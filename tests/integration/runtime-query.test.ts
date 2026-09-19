import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeQueryService } from "../../src/application/runtime-query-service.js";
import { TaskTreeService } from "../../src/application/task-tree-service.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-query-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/a', 'now', 'now')");
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p2', '/b', 'now', 'now')");
  const tree = await new TaskTreeService(database).createTaskRoot({ projectId: "p1", title: "Runtime" });
  database.run("INSERT INTO runtime_confirmation_prompts (id, project_id, tree_id, scope_id, prompt, status, created_at) VALUES ('c1', 'p1', ?, ?, 'Execute?', 'pending', 'now')", tree.treeId, tree.treeId);
  for (const [id, at] of [["e1", "2026-01-01"], ["e2", "2026-01-02"]] as const) {
    database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES (?, 'p1', ?, ?, 's', 'PostToolUse', '{}', ?, ?)", id, tree.treeId, tree.document.nodes[0]!.id, at, `k-${id}`);
  }
  const nodeId = tree.document.nodes[0]!.id;
  const nodeRevision = database.get<{ id: string }>("SELECT id FROM task_node_revisions WHERE node_id = ?", nodeId)!;
  database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at, completed_at) VALUES ('a1', 'p1', ?, ?, ?, 1, 'failed', '2026-01-03', '2026-01-04')", tree.treeId, nodeId, nodeRevision.id);
  database.run("INSERT INTO evaluations (id, project_id, tree_id, task_node_id, task_node_revision_id, execution_attempt_id, verdict, evidence_refs_json, covered_required_evidence_json, missing_required_evidence_json, risk_summary, created_at) VALUES ('v1', 'p1', ?, ?, ?, 'a1', 'failed', '[]', '[]', '[]', 'failed check', '2026-01-04')", tree.treeId, nodeId, nodeRevision.id);
  return { database, tree, service: new RuntimeQueryService(database) };
}
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("RuntimeQueryService", () => {
  it("returns a compact Snapshot and richer Summary", async () => {
    const { database, tree, service } = await fixture();
    expect(service.getRuntimeSnapshot("p1")).toMatchObject({
      selectedTreeId: tree.treeId, workflow: { stage: "draft_task_tree", revision: 1 }, pendingConfirmation: { confirmationId: "c1" },
      activeAttemptCount: 0, confirmationCounts: { draft: 1, pendingUserConfirmation: 0, confirmed: 0, partialConfirmed: 0 },
    });
    expect(service.getTaskTreeSummary("p1", tree.treeId)).toMatchObject({
      treeId: tree.treeId, title: "Runtime", traceCount: 2, attemptCount: 1, evaluationCount: 1,
      confirmationCounts: { draft: 1, pendingUserConfirmation: 0, confirmed: 0, partialConfirmed: 0 },
      nodes: [expect.objectContaining({ confirmationState: "draft" })],
    });
    database.close();
  });

  it("paginates evidence and never reveals another project's identifiers", async () => {
    const { database, tree, service } = await fixture();
    const nodeId = tree.document.nodes[0]!.id;
    const detail = service.getTaskNodeDetail("p1", nodeId, { limit: 1 });
    expect(detail.confirmationState).toBe("draft");
    expect(detail.evidence).toHaveLength(1);
    expect(detail.attempts).toEqual([expect.objectContaining({ attemptId: "a1", attemptNumber: 1, status: "failed" })]);
    expect(detail.evaluations).toEqual([expect.objectContaining({ evaluationId: "v1", attemptId: "a1", verdict: "failed" })]);
    expect(detail.nextCursor).toBeTruthy();
    expect(service.getTraceEvents("p1", { limit: 1, cursor: detail.nextCursor! }).items[0]?.eventId).toBe("e1");
    const nodeRevision = database.get<{ id: string }>("SELECT id FROM task_node_revisions WHERE node_id = ?", nodeId)!;
    database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at, completed_at) VALUES ('a2', 'p1', ?, ?, ?, 2, 'aborted', '2026-01-05', '2026-01-06')", tree.treeId, nodeId, nodeRevision.id);
    database.run("INSERT INTO evaluations (id, project_id, tree_id, task_node_id, task_node_revision_id, execution_attempt_id, verdict, evidence_refs_json, covered_required_evidence_json, missing_required_evidence_json, risk_summary, created_at) VALUES ('v2', 'p1', ?, ?, ?, 'a2', 'uncertain', '[]', '[]', '[]', '', '2026-01-06')", tree.treeId, nodeId, nodeRevision.id);
    const firstHistory = service.getTaskNodeDetail("p1", nodeId, { attemptLimit: 1, evaluationLimit: 1 });
    expect(firstHistory.attempts[0]?.attemptId).toBe("a2");
    expect(firstHistory.evaluations[0]?.evaluationId).toBe("v2");
    expect(firstHistory.attemptNextCursor).toBeTruthy();
    expect(firstHistory.evaluationNextCursor).toBeTruthy();
    const secondHistory = service.getTaskNodeDetail("p1", nodeId, {
      attemptLimit: 1, attemptCursor: firstHistory.attemptNextCursor!,
      evaluationLimit: 1, evaluationCursor: firstHistory.evaluationNextCursor!,
    });
    expect(secondHistory.attempts[0]?.attemptId).toBe("a1");
    expect(secondHistory.evaluations[0]?.evaluationId).toBe("v1");
    expect(() => service.getTaskTreeSummary("p2", tree.treeId)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => service.getTaskNodeDetail("p2", nodeId, {})).toThrow(expect.objectContaining({ code: "not_found" }));
    database.close();
  });
});
