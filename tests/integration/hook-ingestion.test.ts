import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HookIngestionService } from "../../src/application/hook-ingestion-service.js";
import { ProjectIdentityService } from "../../src/application/project-identity-service.js";
import { TaskTreeService } from "../../src/application/task-tree-service.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
const databases: RuntimeDatabase[] = [];
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-hook-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "data", "runtime.db"));
  databases.push(database);
  const service = new HookIngestionService(database, new ProjectIdentityService(database));
  return { directory, database, service };
}

async function activeTree(directory: string, database: RuntimeDatabase) {
  const identity = new ProjectIdentityService(database);
  const project = await identity.resolve(directory, "persist");
  const tree = await new TaskTreeService(database).createTaskRoot({ projectId: project.projectId, title: "Runtime" });
  const nodeId = tree.document.nodes[0]!.id;
  const nodeRevisionId = database.get<{ id: string }>(
    "SELECT id FROM task_node_revisions WHERE node_id = ? AND tree_revision_id = ?",
    nodeId, tree.revisionId,
  )!.id;
  database.run("UPDATE task_nodes SET status = 'running' WHERE id = ?", nodeId);
  database.run(
    "INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at) VALUES (?, ?, ?, ?, ?, 1, 'running', 'now')",
    `attempt-${nodeId}`, project.projectId, tree.treeId, nodeId, nodeRevisionId,
  );
  return { project, tree, nodeId, nodeRevisionId };
}

function linkPlannedFile(database: RuntimeDatabase, input: {
  projectId: string; treeId: string; treeRevisionId: string; nodeId: string; nodeRevisionId: string; artifactId: string; locator: string;
}) {
  database.run(
    "INSERT INTO artifacts (id, project_id, tree_id, kind, locator, status, metadata_json, created_at, updated_at) VALUES (?, ?, ?, 'file', ?, 'planned', '{}', 'now', 'now')",
    input.artifactId, input.projectId, input.treeId, input.locator,
  );
  database.run(
    `INSERT INTO task_node_artifact_links (
       id, project_id, tree_id, tree_revision_id, task_node_id, task_node_revision_id,
       artifact_id, relation_type, source_planning_revision_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'modifies', ?, 'now')`,
    `link-${input.artifactId}`, input.projectId, input.treeId, input.treeRevisionId, input.nodeId, input.nodeRevisionId,
    input.artifactId, input.treeRevisionId,
  );
}
afterEach(async () => {
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {
      // A test may have closed the database explicitly before teardown.
    }
  }
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Claude hook ingestion", () => {
  it("rejects malformed hook input at the binding boundary", () => {
    expect(() => mapClaudeHook({ hook_event_name: "PostToolUse" })).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("maps bounded Claude runtime context fields without retaining transcript paths or unknown environment data", () => {
    const event = mapClaudeHook({
      hook_event_name: "SessionStart", session_id: "run-1", cwd: "/work/a", source: "resume",
      model: "glm-5.3", prompt_id: "prompt-1", permission_mode: "default", effort: { level: "high" },
      agent_id: "agent-1", agent_type: "reviewer", transcript_path: "/secret/transcript.jsonl",
      apiKey: "must-not-survive",
    });
    expect(event.runtimeContext).toEqual({
      promptId: "prompt-1", permissionMode: "default", effortLevel: "high", agentId: "agent-1",
      agentType: "reviewer", modelId: "glm-5.3", launchMethod: "resume",
    });
    expect(event).not.toHaveProperty("transcriptPath");

    expect(mapClaudeHook({
      hook_event_name: "PostModelSwitch", session_id: "run-1", cwd: "/work/a",
      from_model: "glm-5.3", to_model: "kimi-k3", source: "command",
    }).runtimeContext).toMatchObject({ modelId: "kimi-k3", modelSwitchSource: "command", previousModelId: "glm-5.3" });

    expect(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "run-1", cwd: "/work/a",
      permission_mode: "unknown", effort: { level: "extreme" },
    }).runtimeContext).toEqual({});
  });

  it("does not create project state for ordinary conversation without an active workflow", async () => {
    const { directory, database, service } = await fixture();
    const result = await service.ingest(mapClaudeHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: directory, prompt: "explain this" }));
    expect(result).toEqual({ recorded: false, reason: "inactive" });
    expect(database.all("SELECT id FROM projects")).toEqual([]);
    await expect(readFile(path.join(directory, ".agent-harness-project.json"))).rejects.toThrow();
    database.close();
  });

  it("records an early mutation violation but never blocks the tool", async () => {
    const { directory, database, service } = await fixture();
    const event = mapClaudeHook({ hook_event_name: "PreToolUse", session_id: "s1", cwd: directory, tool_name: "Write", tool_use_id: "u1", tool_input: { file_path: path.join(directory, "a.ts"), apiKey: "secret" } });
    expect(await service.ingest(event)).toMatchObject({ recorded: true, violation: true, blocked: false });
    const trace = database.get<{ event_name: string; payload_json: string }>("SELECT event_name, payload_json FROM trace_events");
    expect(trace?.event_name).toBe("workflow_violation");
    expect(trace?.payload_json).not.toContain("secret");
    expect(trace?.payload_json).toContain("[REDACTED]");
    const bashMutation = mapClaudeHook({
      hook_event_name: "PreToolUse", session_id: "s1", cwd: directory, tool_name: "Bash", tool_use_id: "u2",
      tool_input: { command: "printf 'x' > src/a.ts" },
    });
    expect(await service.ingest(bashMutation)).toMatchObject({ recorded: true, violation: true, blocked: false });
    database.close();
  });

  it("deduplicates deliveries and projects successful and failed tool outcomes", async () => {
    const { directory, database, service } = await fixture();
    const identity = new ProjectIdentityService(database);
    const project = await identity.resolve(directory, "persist");
    await new TaskTreeService(database).createTaskRoot({ projectId: project.projectId, title: "Runtime" });
    const success = mapClaudeHook({ hook_event_name: "PostToolUse", session_id: "s1", cwd: directory, tool_name: "Write", tool_use_id: "u1", tool_input: { file_path: path.join(directory, "a.ts") }, tool_response: { ok: true } });
    const successResult = await service.ingest(success);
    if (!successResult.recorded) throw new Error("success hook was not recorded");
    expect(await service.ingest(success)).toEqual({ recorded: false, reason: "duplicate" });
    await service.ingest(mapClaudeHook({ hook_event_name: "PostToolUseFailure", session_id: "s1", cwd: directory, tool_name: "Bash", tool_use_id: "u2", tool_input: { command: "npm test" }, tool_response: { exitCode: 1 } }));
    expect(database.all("SELECT id FROM trace_events")).toHaveLength(2);
    expect(database.get<{ status: string; source_trace_event_id: string }>("SELECT status, source_trace_event_id FROM artifacts WHERE kind = 'file'")).toEqual({
      status: "created", source_trace_event_id: successResult.eventId,
    });
    expect(database.get<{ status: string }>("SELECT status FROM artifacts WHERE kind = 'command'")?.status).toBe("failed");
    expect(JSON.parse(database.get<{ payload_json: string }>("SELECT payload_json FROM trace_events WHERE id = ?", successResult.eventId)!.payload_json))
      .toMatchObject({ artifactRefs: [expect.any(String)], toolInput: { file_path: path.join(directory, "a.ts") } });
    database.close();
  });

  it("updates a planned file as modified and preserves Trace provenance", async () => {
    const { directory, database, service } = await fixture();
    const identity = new ProjectIdentityService(database);
    const project = await identity.resolve(directory, "persist");
    const tree = await new TaskTreeService(database).createTaskRoot({ projectId: project.projectId, title: "Runtime" });
    database.run(
      "INSERT INTO artifacts (id, project_id, tree_id, kind, locator, status, metadata_json, created_at, updated_at) VALUES ('planned-file', ?, ?, 'file', 'src/planned.ts', 'planned', '{}', 'now', 'now')",
      project.projectId, tree.treeId,
    );
    const result = await service.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "s1", cwd: directory, tool_name: "Edit", tool_use_id: "planned-edit",
      tool_input: { file_path: path.join(directory, "src", "planned.ts") }, tool_response: { ok: true },
    }));
    if (!result.recorded) throw new Error("planned edit was not recorded");
    expect(database.get<{ status: string; source_trace_event_id: string; confidence: string }>(
      "SELECT status, source_trace_event_id, confidence FROM artifacts WHERE id = 'planned-file'",
    )).toEqual({ status: "modified", source_trace_event_id: result.eventId, confidence: "observed" });
    database.close();
  });

  it("marks successful verification commands as verified Artifacts", async () => {
    const { directory, database, service } = await fixture();
    const identity = new ProjectIdentityService(database);
    const project = await identity.resolve(directory, "persist");
    await new TaskTreeService(database).createTaskRoot({ projectId: project.projectId, title: "Runtime" });
    const result = await service.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "s1", cwd: directory, tool_name: "Bash", tool_use_id: "verify",
      tool_input: { command: "npm test" }, tool_response: { exitCode: 0 },
    }));
    if (!result.recorded) throw new Error("verification hook was not recorded");
    expect(database.get<{ status: string; confidence: string; source_trace_event_id: string }>(
      "SELECT status, confidence, source_trace_event_id FROM artifacts WHERE kind = 'command'",
    )).toEqual({ status: "verified", confidence: "verified", source_trace_event_id: result.eventId });
    database.close();
  });

  it("does not record Drift when a mutation matches the selected node plan", async () => {
    const { directory, database, service } = await fixture();
    const { project, tree, nodeId, nodeRevisionId } = await activeTree(directory, database);
    linkPlannedFile(database, {
      projectId: project.projectId, treeId: tree.treeId, treeRevisionId: tree.revisionId,
      nodeId, nodeRevisionId, artifactId: "own-file", locator: "src/owned.ts",
    });

    await service.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "s1", cwd: directory, tool_name: "Edit", tool_use_id: "owned-edit",
      tool_input: { file_path: path.join(directory, "src", "owned.ts") }, tool_response: { ok: true },
    }));

    expect(database.all("SELECT id FROM plan_drift_records")).toEqual([]);
  });

  it("records warning Drift for an unplanned mutation", async () => {
    const { directory, database, service } = await fixture();
    const { nodeId } = await activeTree(directory, database);

    const event = mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "s1", cwd: directory, tool_name: "Write", tool_use_id: "unplanned-write",
      tool_input: { file_path: path.join(directory, "src", "surprise.ts") }, tool_response: { ok: true },
    });
    await service.ingest(event);
    expect(await service.ingest(event)).toEqual({ recorded: false, reason: "duplicate" });

    expect(database.get<{ severity: string; resolution_status: string; task_node_id: string }>(
      "SELECT severity, resolution_status, task_node_id FROM plan_drift_records",
    )).toEqual({ severity: "warning", resolution_status: "recorded", task_node_id: nodeId });
    expect(database.get<{ count: number }>("SELECT count(*) AS count FROM plan_drift_records")).toEqual({ count: 1 });
    expect(database.get<{ count: number }>("SELECT count(*) AS count FROM trace_events")).toEqual({ count: 2 });
    expect(database.get<{ status: string }>("SELECT status FROM execution_attempts WHERE task_node_id = ?", nodeId)).toEqual({ status: "running" });
  });

  it("records blocking Drift when a mutation belongs to an unconfirmed sibling branch", async () => {
    const { directory, database, service } = await fixture();
    const { project, tree, nodeId } = await activeTree(directory, database);
    database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES ('sibling', ?, ?, 'Sibling', 'draft')", tree.treeId, nodeId);
    database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES ('sibling-r1', 'sibling', ?, '{}', 'now')", tree.revisionId);
    database.run(
      "INSERT INTO task_node_confirmation_states (project_id, tree_id, tree_revision_id, task_node_id, state, updated_at) VALUES (?, ?, ?, 'sibling', 'draft', 'now')",
      project.projectId, tree.treeId, tree.revisionId,
    );
    linkPlannedFile(database, {
      projectId: project.projectId, treeId: tree.treeId, treeRevisionId: tree.revisionId,
      nodeId: "sibling", nodeRevisionId: "sibling-r1", artifactId: "sibling-file", locator: "src/sibling.ts",
    });

    const source = await service.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "s1", cwd: directory, tool_name: "Edit", tool_use_id: "sibling-edit",
      tool_input: { file_path: path.join(directory, "src", "sibling.ts") }, tool_response: { ok: true },
    }));
    if (!source.recorded) throw new Error("sibling edit was not recorded");

    const drift = database.get<{ severity: string; resolution_status: string; trace_event_id: string; task_node_id: string }>(
      "SELECT severity, resolution_status, trace_event_id, task_node_id FROM plan_drift_records",
    );
    expect(drift).toMatchObject({ severity: "blocking", resolution_status: "pending_user_confirmation", task_node_id: nodeId });
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = ?", nodeId)).toEqual({ status: "blocked" });
    expect(database.get<{ status: string }>("SELECT status FROM execution_attempts WHERE task_node_id = ?", nodeId)).toEqual({ status: "blocked" });
    expect(JSON.parse(database.get<{ payload_json: string }>("SELECT payload_json FROM trace_events WHERE id = ?", drift!.trace_event_id)!.payload_json))
      .toMatchObject({ sourceTraceEventId: source.eventId, actualArtifactId: "sibling-file" });
  });
});
