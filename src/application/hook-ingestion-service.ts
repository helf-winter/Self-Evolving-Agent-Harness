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
        this.projectArtifact(project.projectId, workflow?.tree_id, event, event.eventName === "PostToolUse" ? "observed" : "failed");
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

  private projectArtifact(projectId: string, treeId: string | undefined, event: ClaudeHookEvent, status: "observed" | "failed"): void {
    let kind: "file" | "command" | undefined;
    let locator: string | undefined;
    const filePath = event.toolInput?.file_path ?? event.toolInput?.path;
    if (typeof filePath === "string") {
      kind = "file";
      locator = path.isAbsolute(filePath) ? path.normalize(filePath).replaceAll("\\", "/") : filePath.replaceAll("\\", "/");
    } else if (event.toolName === "Bash" && typeof event.toolInput?.command === "string") {
      kind = "command";
      locator = event.toolInput.command;
    }
    if (!kind || !locator) return;
    const timestamp = event.occurredAt;
    this.database.run(
      "INSERT INTO artifacts (id, project_id, tree_id, kind, locator, status, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?) ON CONFLICT(project_id, kind, locator) DO UPDATE SET status = excluded.status, tree_id = COALESCE(excluded.tree_id, artifacts.tree_id), updated_at = excluded.updated_at",
      newId(), projectId, treeId ?? null, kind, locator, status, timestamp, timestamp,
    );
  }
}
