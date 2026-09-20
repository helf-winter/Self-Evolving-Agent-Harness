import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeActionService } from "../../src/application/runtime-action-service.js";
import { TaskTreeService } from "../../src/application/task-tree-service.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
const databases: RuntimeDatabase[] = [];

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-user-change-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  databases.push(database);
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/p1', 'now', 'now')");
  const trees = new TaskTreeService(database);
  const root = await trees.createTaskRoot({ projectId: "p1", title: "Endpoint" });
  const rootNodeId = root.document.nodes[0]!.id;
  const document: TaskTreeDocument = {
    nodes: [
      { id: rootNodeId, parentId: null, title: "Endpoint", children: ["leaf"] },
      {
        id: "leaf", parentId: rootNodeId, title: "Implement endpoint", children: [],
        objectives: ["Implement endpoint"], expectedOutputs: ["src/endpoint.ts"],
        acceptanceCriteria: ["endpoint test passes"], unresolvedQuestions: [], unresolvedDecisions: [],
        dependencies: [], requiredEvidence: [{ key: "test", description: "endpoint test passes" }],
        executionPhase: "implementation", stopDecompositionReason: "one independently testable endpoint",
      },
    ],
    relations: [], artifacts: [],
  };
  const revision = trees.saveDraftRevision({ projectId: "p1", treeId: root.treeId, baseRevisionId: root.revisionId, document });
  database.run("UPDATE task_node_confirmation_states SET state = 'confirmed' WHERE tree_revision_id = ?", revision.revisionId);
  database.run("UPDATE task_nodes SET status = 'ready' WHERE tree_id = ?", root.treeId);
  database.run("UPDATE task_nodes SET status = 'running' WHERE id = 'leaf'");
  database.run("UPDATE task_trees SET status = 'confirmed' WHERE id = ?", root.treeId);
  database.run("UPDATE workflow_states SET stage = 'branch_implementation', revision = 5 WHERE tree_id = ?", root.treeId);
  database.run("UPDATE runtime_states SET selected_tree_id = ?, selected_node_id = 'leaf', state_json = '{}' WHERE project_id = 'p1'", root.treeId);
  const leafRevision = database.get<{ id: string }>("SELECT id FROM task_node_revisions WHERE node_id = 'leaf' AND tree_revision_id = ?", revision.revisionId)!;
  database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at) VALUES ('attempt-1', 'p1', ?, 'leaf', ?, 1, 'running', '2026-01-01')", root.treeId, leafRevision.id);
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('source-change', 'p1', ?, 'leaf', 's', 'UserPromptSubmit', '{}', '2026-01-02', 'source-change')", root.treeId);
  return {
    database, trees, rootNodeId, treeId: root.treeId, revisionId: revision.revisionId, document,
    service: new RuntimeActionService(database),
  };
}

function changedDocument(document: TaskTreeDocument): TaskTreeDocument {
  return {
    ...document,
    nodes: document.nodes.map((node) => node.id === "leaf"
      ? { ...node, title: "Implement renamed endpoint", acceptanceCriteria: ["renamed endpoint test passes"] }
      : node),
  };
}

function addAnswer(database: RuntimeDatabase, treeId: string, id: string) {
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES (?, 'p1', ?, 'leaf', 'answer', 'UserPromptSubmit', '{}', '2099-01-01', ?)", id, treeId, id);
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    try { database.close(); } catch { /* already closed */ }
  }
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("RuntimeActionService User Change lifecycle", () => {
  it("commits a minor change as fact without changing the Task Tree revision", async () => {
    const { database, service, treeId, revisionId } = await fixture();
    const action = service.proposeUserChange({
      projectId: "p1", treeId, nodeId: "leaf", expectedTreeRevisionId: revisionId,
      changeType: "minor_change", summary: "Adjust the response copy",
      changeImpact: { artifacts: ["src/endpoint.ts"], scopeChanged: false },
      sourceMessageTraceEventId: "source-change",
    });
    expect(action).toMatchObject({ actionType: "record_user_change", status: "committed", confirmationId: null, changeType: "minor_change" });
    expect(database.get<{ current_revision_id: string }>("SELECT current_revision_id FROM task_trees WHERE id = ?", treeId)).toEqual({ current_revision_id: revisionId });
    expect(database.get<{ status: string }>("SELECT status FROM execution_attempts WHERE id = 'attempt-1'")).toEqual({ status: "running" });
    expect(database.get<{ count: number }>("SELECT count(*) AS count FROM trace_events WHERE event_name = 'user_change_request'")?.count).toBe(1);
  });

  it("commits a priority change by switching selection without changing node status", async () => {
    const { database, service, treeId, revisionId, rootNodeId } = await fixture();
    const action = service.proposeUserChange({
      projectId: "p1", treeId, nodeId: "leaf", expectedTreeRevisionId: revisionId,
      changeType: "priority_change", summary: "Work on the integration root next",
      changeImpact: { executionOrderChanged: true }, priorityTargetNodeId: rootNodeId,
      sourceMessageTraceEventId: "source-change",
    });
    expect(action).toMatchObject({ status: "committed", changeType: "priority_change" });
    expect(database.get<{ selected_node_id: string }>("SELECT selected_node_id FROM runtime_states WHERE project_id = 'p1'")).toEqual({ selected_node_id: rootNodeId });
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = 'leaf'")).toEqual({ status: "running" });
  });

  it("stores a scope candidate and aborts active work without activating the revision", async () => {
    const { database, service, treeId, revisionId, document } = await fixture();
    const action = service.proposeUserChange({
      projectId: "p1", treeId, nodeId: "leaf", expectedTreeRevisionId: revisionId,
      changeType: "scope_change", summary: "Rename the confirmed endpoint",
      changeImpact: { changedNodes: ["leaf"], scopeChanged: true }, proposedDocument: changedDocument(document),
      sourceMessageTraceEventId: "source-change",
    });
    expect(action).toMatchObject({ status: "pending_confirmation", changeType: "scope_change", confirmationId: expect.any(String) });
    expect(database.get<{ current_revision_id: string }>("SELECT current_revision_id FROM task_trees WHERE id = ?", treeId)).toEqual({ current_revision_id: revisionId });
    expect(database.get<{ status: string }>("SELECT status FROM execution_attempts WHERE id = 'attempt-1'")).toEqual({ status: "aborted" });
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = 'leaf'")).toEqual({ status: "pending_user_confirmation" });
  });

  it("rejects a scope change while preserving the old revision and retryability", async () => {
    const { database, service, treeId, revisionId, document } = await fixture();
    const action = service.proposeUserChange({
      projectId: "p1", treeId, nodeId: "leaf", expectedTreeRevisionId: revisionId,
      changeType: "scope_change", summary: "Rename endpoint", changeImpact: { changedNodes: ["leaf"] },
      proposedDocument: changedDocument(document), sourceMessageTraceEventId: "source-change",
    });
    if (!action.confirmationId) throw new Error("scope confirmation missing");
    addAnswer(database, treeId, "scope-no");
    expect(service.resolveConfirmation({ projectId: "p1", confirmationId: action.confirmationId, answer: "no", answerTraceEventId: "scope-no" }))
      .toMatchObject({ status: "rejected", changeType: "scope_change" });
    expect(database.get<{ current_revision_id: string }>("SELECT current_revision_id FROM task_trees WHERE id = ?", treeId)).toEqual({ current_revision_id: revisionId });
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = 'leaf'")).toEqual({ status: "ready" });
  });

  it("applies a confirmed scope change once and returns the workflow to refinement", async () => {
    const { database, service, treeId, revisionId, document } = await fixture();
    const action = service.proposeUserChange({
      projectId: "p1", treeId, nodeId: "leaf", expectedTreeRevisionId: revisionId,
      changeType: "scope_change", summary: "Rename endpoint", changeImpact: { changedNodes: ["leaf"] },
      proposedDocument: changedDocument(document), sourceMessageTraceEventId: "source-change",
    });
    if (!action.confirmationId) throw new Error("scope confirmation missing");
    addAnswer(database, treeId, "scope-yes");
    const resolved = service.resolveConfirmation({ projectId: "p1", confirmationId: action.confirmationId, answer: "yes", answerTraceEventId: "scope-yes" });
    expect(resolved).toMatchObject({ status: "committed", changeType: "scope_change" });
    const current = database.get<{ current_revision_id: string }>("SELECT current_revision_id FROM task_trees WHERE id = ?", treeId)!;
    expect(current.current_revision_id).not.toBe(revisionId);
    expect(database.get<{ stage: string }>("SELECT stage FROM workflow_states WHERE tree_id = ?", treeId)).toEqual({ stage: "task_tree_refinement" });
    expect(database.get<{ state: string }>("SELECT state FROM task_node_confirmation_states WHERE tree_revision_id = ? AND task_node_id = 'leaf'", current.current_revision_id)).toEqual({ state: "pending_user_confirmation" });
    service.resolveConfirmation({ projectId: "p1", confirmationId: action.confirmationId, answer: "yes", answerTraceEventId: "scope-yes" });
    expect(database.get<{ count: number }>("SELECT count(*) AS count FROM task_tree_revisions WHERE tree_id = ?", treeId)?.count).toBe(3);
  });

  it("persists revision_conflict when the Tree changes before scope confirmation", async () => {
    const { database, trees, service, treeId, revisionId, document } = await fixture();
    const action = service.proposeUserChange({
      projectId: "p1", treeId, nodeId: "leaf", expectedTreeRevisionId: revisionId,
      changeType: "scope_change", summary: "Rename endpoint", changeImpact: { changedNodes: ["leaf"] },
      proposedDocument: changedDocument(document), sourceMessageTraceEventId: "source-change",
    });
    if (!action.confirmationId) throw new Error("scope confirmation missing");
    const confirmationId = action.confirmationId;
    trees.saveDraftRevision({ projectId: "p1", treeId, baseRevisionId: revisionId, document });
    addAnswer(database, treeId, "scope-stale");
    expect(() => service.resolveConfirmation({ projectId: "p1", confirmationId, answer: "yes", answerTraceEventId: "scope-stale" }))
      .toThrow(expect.objectContaining({ code: "revision_conflict" }));
    expect(database.get<{ status: string }>("SELECT status FROM runtime_actions WHERE id = ?", action.actionId)).toEqual({ status: "revision_conflict" });
  });
});
