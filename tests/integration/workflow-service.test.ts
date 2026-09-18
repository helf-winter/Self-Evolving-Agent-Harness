import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskTreeService } from "../../src/application/task-tree-service.js";
import { WorkflowService } from "../../src/application/workflow-service.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-workflow-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/a', 'now', 'now')");
  const tree = await new TaskTreeService(database).createTaskRoot({ projectId: "p1", title: "Runtime" });
  database.run("UPDATE workflow_states SET stage = 'branch_confirmation' WHERE project_id = 'p1'");
  database.run("INSERT INTO artifacts (id, project_id, tree_id, kind, locator, status, created_at, updated_at) VALUES ('a1', 'p1', ?, 'file', 'src/a.ts', 'draft', 'now', 'now')", tree.treeId);
  return { database, tree, service: new WorkflowService(database) };
}
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("WorkflowService", () => {
  it("requires the current workflow revision", async () => {
    const { database, tree, service } = await fixture();
    expect(() => service.createConfirmationPrompt({ projectId: "p1", treeId: tree.treeId, scopeId: tree.treeId, prompt: "Execute?", workflowRevision: 2 })).toThrow(expect.objectContaining({ code: "revision_conflict" }));
    database.close();
  });

  it("requires recorded user-answer evidence before confirming", async () => {
    const { database, tree, service } = await fixture();
    const prompt = service.createConfirmationPrompt({ projectId: "p1", treeId: tree.treeId, scopeId: tree.treeId, prompt: "Execute?", workflowRevision: 1 });
    expect(() => service.confirmScope({ projectId: "p1", confirmationId: prompt.confirmationId, answer: "yes", answerTraceEventId: "missing", workflowRevision: 1 })).toThrow(expect.objectContaining({ code: "workflow_transition_rejected" }));
    expect(database.get<{ stage: string }>("SELECT stage FROM workflow_states WHERE project_id = 'p1' AND active = 1")?.stage).toBe("branch_confirmation");
    database.close();
  });

  it("atomically records confirmation, plans artifacts, and advances to skeleton", async () => {
    const { database, tree, service } = await fixture();
    const prompt = service.createConfirmationPrompt({ projectId: "p1", treeId: tree.treeId, scopeId: tree.treeId, prompt: "Execute?", workflowRevision: 1 });
    database.run("INSERT INTO trace_events (id, project_id, tree_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('e1', 'p1', ?, 's1', 'UserPromptSubmit', '{\"text\":\"yes\"}', 'now', 'k1')", tree.treeId);
    const result = service.confirmScope({ projectId: "p1", confirmationId: prompt.confirmationId, answer: "yes", answerTraceEventId: "e1", workflowRevision: 1 });
    expect(result).toMatchObject({ stage: "skeleton_pass", workflowRevision: 2 });
    expect(database.get<{ status: string }>("SELECT status FROM artifacts WHERE id = 'a1'")?.status).toBe("planned");
    expect(database.get<{ status: string }>("SELECT status FROM runtime_confirmation_prompts WHERE id = ?", prompt.confirmationId)?.status).toBe("confirmed");
    database.close();
  });

  it("rejects arbitrary skeleton gate evidence identifiers", async () => {
    const { database, tree, service } = await fixture();
    database.run("UPDATE workflow_states SET stage = 'skeleton_gate' WHERE project_id = 'p1'");
    expect(() => service.transition({
      projectId: "p1", treeId: tree.treeId, workflowRevision: 1,
      to: "branch_implementation", skeletonGateEvidenceId: "not-an-attempt",
    })).toThrow(expect.objectContaining({ code: "workflow_transition_rejected" }));
    database.close();
  });

  it("requires every current skeleton node to succeed before opening implementation", async () => {
    const { database, tree, service } = await fixture();
    const rootNode = tree.document.nodes[0]!.id;
    const rootRevision = database.get<{ id: string }>("SELECT id FROM task_node_revisions WHERE node_id = ?", rootNode)!;
    database.run("UPDATE task_node_revisions SET body_json = ? WHERE id = ?", JSON.stringify({ id: rootNode, executionPhase: "skeleton", requiredEvidence: [{ key: "compile", description: "compile" }] }), rootRevision.id);
    database.run("UPDATE task_nodes SET status = 'succeeded' WHERE id = ?", rootNode);
    database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at, completed_at) VALUES ('sk-a1', 'p1', ?, ?, ?, 1, 'succeeded', 'now', 'now')", tree.treeId, rootNode, rootRevision.id);
    database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES ('sk2', ?, NULL, 'Second skeleton', 'ready')", tree.treeId);
    database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES ('sk2-r1', 'sk2', ?, ?, 'now')", tree.revisionId, JSON.stringify({ id: "sk2", executionPhase: "skeleton", requiredEvidence: [{ key: "compile", description: "compile" }] }));
    database.run("UPDATE workflow_states SET stage = 'skeleton_gate' WHERE project_id = 'p1'");
    expect(() => service.transition({
      projectId: "p1", treeId: tree.treeId, workflowRevision: 1,
      to: "branch_implementation", skeletonGateEvidenceId: "sk-a1",
    })).toThrow(expect.objectContaining({ code: "workflow_transition_rejected" }));
    database.close();
  });
});
