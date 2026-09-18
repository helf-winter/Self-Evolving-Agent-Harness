import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionService } from "../../src/application/node-execution-service.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-execution-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  for (const [id, projectPath] of [["p1", "/a"], ["p2", "/b"]] as const) {
    database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES (?, ?, ?, ?)", id, projectPath, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  }
  database.run("INSERT INTO task_trees (id, project_id, title, status, current_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", "t1", "p1", "Tree", "confirmed", "tr1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES (?, ?, ?, ?, ?)", "tr1", "t1", 1, "{}", "2026-01-01T00:00:00.000Z");
  database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES (?, ?, ?, ?, ?)", "dep", "t1", null, "Dependency", "succeeded");
  database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES (?, ?, ?, ?, ?)", "n1", "t1", "dep", "Implement", "ready");
  database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES (?, ?, ?, ?, ?)", "dep-r1", "dep", "tr1", JSON.stringify({ id: "dep", executionPhase: "implementation", dependencies: [], requiredEvidence: [{ key: "dep-test", description: "dependency test" }] }), "2026-01-01T00:00:00.000Z");
  database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES (?, ?, ?, ?, ?)", "n1-r1", "n1", "tr1", JSON.stringify({ id: "n1", executionPhase: "implementation", dependencies: ["dep"], requiredEvidence: [{ key: "test", description: "tests pass" }] }), "2026-01-01T00:00:00.000Z");
  database.run("INSERT INTO workflow_states (id, project_id, tree_id, stage, revision, active, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)", "w1", "p1", "t1", "branch_implementation", 1, "2026-01-01T00:00:00.000Z");
  database.run("INSERT INTO runtime_states (project_id, selected_tree_id, selected_node_id, state_json, updated_at) VALUES (?, ?, ?, '{}', ?)", "p1", "t1", "dep", "2026-01-01T00:00:00.000Z");
  return { database, service: new NodeExecutionService(database) };
}

afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("NodeExecutionService", () => {
  it("starts one current-revision attempt and increments retry numbers", async () => {
    const { database, service } = await fixture();
    const first = service.startAttempt({ projectId: "p1", nodeId: "n1", expectedTreeRevisionId: "tr1" });
    expect(first).toMatchObject({ nodeRevisionId: "n1-r1", attemptNumber: 1, status: "running" });
    expect(database.get<{ selected_node_id: string }>("SELECT selected_node_id FROM runtime_states WHERE project_id = 'p1'")).toEqual({ selected_node_id: "n1" });
    expect(() => service.startAttempt({ projectId: "p1", nodeId: "n1", expectedTreeRevisionId: "tr1" })).toThrow(expect.objectContaining({ code: "attempt_already_active" }));
    service.abortAttempt({ projectId: "p1", attemptId: first.attemptId, expectedStatus: "running" });
    const second = service.startAttempt({ projectId: "p1", nodeId: "n1", expectedTreeRevisionId: "tr1" });
    expect(second.attemptNumber).toBe(2);
    database.close();
  });

  it("enforces workflow phase and succeeded dependencies", async () => {
    const { database, service } = await fixture();
    database.run("UPDATE workflow_states SET stage = 'skeleton_pass' WHERE id = 'w1'");
    expect(() => service.startAttempt({ projectId: "p1", nodeId: "n1", expectedTreeRevisionId: "tr1" })).toThrow(expect.objectContaining({ code: "attempt_not_executable" }));
    database.run("UPDATE workflow_states SET stage = 'branch_implementation' WHERE id = 'w1'");
    database.run("UPDATE task_nodes SET status = 'failed' WHERE id = 'dep'");
    expect(() => service.startAttempt({ projectId: "p1", nodeId: "n1", expectedTreeRevisionId: "tr1" })).toThrow(expect.objectContaining({ code: "attempt_not_executable" }));
    database.run("UPDATE task_nodes SET status = 'succeeded' WHERE id = 'dep'");
    database.run("UPDATE task_node_revisions SET body_json = ? WHERE id = 'n1-r1'", JSON.stringify({ id: "n1", executionPhase: "implementation", dependencies: [] }));
    expect(() => service.startAttempt({ projectId: "p1", nodeId: "n1", expectedTreeRevisionId: "tr1" })).toThrow(expect.objectContaining({ code: "attempt_not_executable" }));
    database.close();
  });

  it("links only declared, same-scope, post-start Trace evidence", async () => {
    const { database, service } = await fixture();
    const attempt = service.startAttempt({ projectId: "p1", nodeId: "n1", expectedTreeRevisionId: "tr1" });
    database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)", "before", "p1", "t1", "n1", "s", "PostToolUse", "2020-01-01T00:00:00.000Z", "before");
    database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)", "other", "p2", null, null, "s", "PostToolUse", "2030-01-01T00:00:00.000Z", "other");
    database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)", "valid", "p1", "t1", "n1", "s", "PostToolUse", "2030-01-01T00:00:00.000Z", "valid");

    expect(() => service.attachEvidence({ projectId: "p1", attemptId: attempt.attemptId, requiredEvidenceKey: "test", traceEventId: "before" })).toThrow(expect.objectContaining({ code: "evidence_scope_mismatch" }));
    expect(() => service.attachEvidence({ projectId: "p1", attemptId: attempt.attemptId, requiredEvidenceKey: "test", traceEventId: "other" })).toThrow(expect.objectContaining({ code: "evidence_scope_mismatch" }));
    expect(() => service.attachEvidence({ projectId: "p1", attemptId: attempt.attemptId, requiredEvidenceKey: "unknown", traceEventId: "valid" })).toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(service.attachEvidence({ projectId: "p1", attemptId: attempt.attemptId, requiredEvidenceKey: "test", traceEventId: "valid" })).toMatchObject({ requiredEvidenceKey: "test", traceEventId: "valid" });
    database.close();
  });

  it("moves running attempts to verification and can abort without losing history", async () => {
    const { database, service } = await fixture();
    const attempt = service.startAttempt({ projectId: "p1", nodeId: "n1", expectedTreeRevisionId: "tr1" });
    expect(service.beginVerification({ projectId: "p1", attemptId: attempt.attemptId, expectedStatus: "running" })).toMatchObject({ status: "verifying" });
    expect(() => service.beginVerification({ projectId: "p1", attemptId: attempt.attemptId, expectedStatus: "running" })).toThrow(expect.objectContaining({ code: "attempt_state_conflict" }));
    const aborted = service.abortAttempt({ projectId: "p1", attemptId: attempt.attemptId, expectedStatus: "verifying" });
    expect(aborted.status).toBe("aborted");
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = 'n1'")).toEqual({ status: "ready" });
    database.close();
  });
});
