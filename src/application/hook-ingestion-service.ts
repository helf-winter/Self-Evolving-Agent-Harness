import path from "node:path";
import { newId } from "../domain/ids.js";
import { canonicalJson, createHookIdempotencyKey, redactSecrets } from "../domain/trace.js";
import type { ClaudeHookEvent } from "../bindings/claude/hook-mapper.js";
import type { RuntimeDatabase } from "../storage/database.js";
import type { ProjectIdentityService } from "./project-identity-service.js";

interface WorkflowContext {
  tree_id: string;
  stage: string;
  selected_node_id: string | null;
}

const mutationTools = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const executableStages = new Set(["skeleton_pass", "skeleton_gate", "branch_implementation", "branch_verification", "root_verification", "final_report"]);

export class HookIngestionService {
  constructor(private readonly database: RuntimeDatabase, private readonly projects: ProjectIdentityService) {}

  async ingest(event: ClaudeHookEvent): Promise<
    | { recorded: false; reason: "inactive" | "duplicate" }
    | { recorded: true; eventId: string; violation: boolean; blocked: false }
  > {
    const key = createHookIdempotencyKey({
      sessionId: event.sessionId,
      eventName: event.eventName,
      ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
      payload: event,
    });
    if (this.database.get("SELECT idempotency_key FROM hook_receipts WHERE idempotency_key = ?", key)) return { recorded: false, reason: "duplicate" };

    let project = await this.projects.resolve(event.cwd, "inspect");
    let workflow = project.status === "persisted"
      ? this.database.get<WorkflowContext>(`
          SELECT w.tree_id, w.stage, r.selected_node_id
          FROM workflow_states w
          LEFT JOIN runtime_states r ON r.project_id = w.project_id
          WHERE w.project_id = ? AND w.active = 1
        `, project.projectId)
      : undefined;
    const mutation = event.eventName === "PreToolUse" && this.isMutation(event);
    if (!workflow && !mutation) return { recorded: false, reason: "inactive" };
    if (project.status !== "persisted") project = await this.projects.resolve(event.cwd, "persist");
    workflow ??= this.database.get<WorkflowContext>(`
      SELECT w.tree_id, w.stage, r.selected_node_id
      FROM workflow_states w
      LEFT JOIN runtime_states r ON r.project_id = w.project_id
      WHERE w.project_id = ? AND w.active = 1
    `, project.projectId);

    const violation = mutation && (!workflow || !executableStages.has(workflow.stage));
    const eventId = newId();
    const eventName = violation ? "workflow_violation" : event.eventName;
    const payload = redactSecrets({
      sourceEvent: event.eventName,
      ...(event.toolName ? { toolName: event.toolName } : {}),
      ...(event.toolInput ? { toolInput: event.toolInput } : {}),
      ...(event.toolResponse !== undefined ? { toolResponse: event.toolResponse } : {}),
      ...(event.prompt ? { prompt: event.prompt } : {}),
      ...(violation ? { reason: "mutation_before_confirmed_executable_scope" } : {}),
    });

    this.database.transaction(() => {
      this.database.run("INSERT INTO hook_receipts (idempotency_key, event_name, received_at) VALUES (?, ?, ?)", key, event.eventName, event.occurredAt);
      this.database.run(
        "INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        eventId, project.projectId, workflow?.tree_id ?? null, workflow?.selected_node_id ?? null, event.sessionId, eventName, canonicalJson(payload), event.occurredAt, key,
      );
      if (event.eventName === "PostToolUse" || event.eventName === "PostToolUseFailure") {
        const artifactId = this.projectArtifact(project.projectId, workflow?.tree_id, eventId, event);
        if (artifactId) {
          this.database.run(
            "UPDATE trace_events SET payload_json = ? WHERE id = ?",
            canonicalJson({ ...(payload as Record<string, unknown>), artifactRefs: [artifactId] }),
            eventId,
          );
        }
      }
    });
    return { recorded: true, eventId, violation, blocked: false };
  }

  private isMutation(event: ClaudeHookEvent): boolean {
    if (event.toolName && mutationTools.has(event.toolName)) return true;
    if (event.toolName !== "Bash") return false;
    const command = typeof event.toolInput?.command === "string" ? event.toolInput.command : "";
    const mutatingCommand = /(^|[;&|]\s*)(rm|mv|cp|touch|mkdir|rmdir|install|chmod|chown|ln|truncate|dd|tee|patch|apply_patch|sed\s+-i|perl\s+-pi|git\s+(commit|checkout|reset|clean|mv|rm)|npm\s+(install|uninstall)|pnpm\s+(add|remove|install)|yarn\s+(add|remove|install))\b/;
    const outputRedirection = /(^|[^<>])>{1,2}(?![>&])\s*[^&]/;
    return mutatingCommand.test(command) || outputRedirection.test(command);
  }

  private projectArtifact(projectId: string, treeId: string | undefined, eventId: string, event: ClaudeHookEvent): string | undefined {
    let kind: "file" | "command" | undefined;
    let locator: string | undefined;
    const filePath = event.toolInput?.file_path ?? event.toolInput?.path;
    if (typeof filePath === "string") {
      kind = "file";
      locator = this.normalizeFileLocator(event.cwd, filePath);
    } else if (event.toolName === "Bash" && typeof event.toolInput?.command === "string") {
      kind = "command";
      locator = event.toolInput.command;
    }
    if (!kind || !locator) return undefined;

    const existing = this.database.get<{ id: string; status: string }>(
      "SELECT id, status FROM artifacts WHERE project_id = ? AND kind = ? AND locator = ?",
      projectId, kind, locator,
    );
    const failed = event.eventName === "PostToolUseFailure";
    const mutation = kind === "file" && this.isMutation(event);
    const verified = kind === "command" && !failed && this.isVerificationCommand(locator);
    const status = failed
      ? "failed"
      : verified
        ? "verified"
        : mutation
          ? existing ? "modified" : "created"
          : existing?.status ?? "observed";
    const confidence = verified ? "verified" : "observed";
    const artifactId = existing?.id ?? newId();
    const timestamp = event.occurredAt;
    this.database.run(
      `INSERT INTO artifacts (
         id, project_id, tree_id, kind, locator, status, metadata_json, created_at, updated_at,
         granularity, artifact_type, path_or_name, identity_strategy, confidence, source_trace_event_id
       ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, 'structural', ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, kind, locator) DO UPDATE SET
         status = excluded.status,
         tree_id = COALESCE(excluded.tree_id, artifacts.tree_id),
         path_or_name = excluded.path_or_name,
         confidence = excluded.confidence,
         source_trace_event_id = excluded.source_trace_event_id,
         updated_at = excluded.updated_at`,
      artifactId, projectId, treeId ?? null, kind, locator, status, timestamp, timestamp,
      kind, locator, kind === "command" ? "command_signature" : "path", confidence, eventId,
    );
    return artifactId;
  }

  private normalizeFileLocator(cwd: string, filePath: string): string {
    if (!path.isAbsolute(filePath)) return path.normalize(filePath).replaceAll("\\", "/");
    const relative = path.relative(path.resolve(cwd), path.resolve(filePath));
    if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return relative.replaceAll("\\", "/");
    }
    return path.normalize(filePath).replaceAll("\\", "/");
  }

  private isVerificationCommand(command: string): boolean {
    return /(?:^|\s|&&|;)(?:npm\s+(?:test|run\s+(?:test|build|lint|typecheck|check))|pnpm\s+(?:test|build|lint|typecheck|check)|yarn\s+(?:test|build|lint|typecheck|check)|npx\s+(?:vitest|tsc|eslint)|pytest|python\s+-m\s+pytest|cargo\s+(?:test|check|build)|go\s+test)(?:\s|$)/i.test(command);
  }
}
