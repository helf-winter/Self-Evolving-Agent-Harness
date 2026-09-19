import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskTreeService } from "../../src/application/task-tree-service.js";
import { WorkflowService } from "../../src/application/workflow-service.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
const branchDocument = {
  nodes: [
    { id: "root", parentId: null, title: "Root", children: ["branch-a", "branch-b"] },
    {
      id: "branch-a", parentId: "root", title: "A", children: [], objectives: ["A"], expectedOutputs: ["a.ts"],
      acceptanceCriteria: ["A passes"], unresolvedQuestions: [], unresolvedDecisions: [], dependencies: ["branch-b"],
      requiredEvidence: [{ key: "a-test", description: "A tests" }], executionPhase: "implementation" as const,
      stopDecompositionReason: "one branch",
    },
    {
      id: "branch-b", parentId: "root", title: "B", children: [], objectives: ["B"], expectedOutputs: ["b.ts"],
      acceptanceCriteria: ["B passes"], unresolvedQuestions: [], unresolvedDecisions: [], dependencies: [],
      requiredEvidence: [{ key: "b-test", description: "B tests" }], executionPhase: "implementation" as const,
      stopDecompositionReason: "one branch",
    },
  ],
  relations: [], artifacts: [],
};
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-workflow-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/a', 'now', 'now')");
  const tree = await new TaskTreeService(database).createTaskRoot({ projectId: "p1", title: "Runtime" });
  database.run("UPDATE workflow_states SET stage = 'branch_confirmation' WHERE project_id = 'p1'");
  database.run(
    "INSERT INTO plan_readiness_results (id, tree_id, revision_id, ready, blockers_json, created_at) VALUES ('ready-tree', ?, ?, 1, '[]', 'now')",
    tree.treeId, tree.revisionId,
  );
  database.run("INSERT INTO artifacts (id, project_id, tree_id, kind, locator, status, created_at, updated_at) VALUES ('a1', 'p1', ?, 'file', 'src/a.ts', 'draft', 'now', 'now')", tree.treeId);
  const rootNodeId = tree.document.nodes[0]!.id;
  const rootNodeRevisionId = database.get<{ id: string }>("SELECT id FROM task_node_revisions WHERE node_id = ? AND tree_revision_id = ?", rootNodeId, tree.revisionId)!.id;
  database.run(
    "INSERT INTO task_node_artifact_links (id, project_id, tree_id, tree_revision_id, task_node_id, task_node_revision_id, artifact_id, relation_type, source_planning_revision_id, created_at) VALUES ('fixture-link', 'p1', ?, ?, ?, ?, 'a1', 'plans', ?, 'now')",
    tree.treeId, tree.revisionId, rootNodeId, rootNodeRevisionId, tree.revisionId,
  );
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
    expect(database.get<{ count: number }>("SELECT count(*) AS count FROM scope_confirmation_records WHERE confirmation_prompt_id = ?", prompt.confirmationId)?.count).toBe(1);
    database.close();
  });

  it("rejects user-answer evidence outside the prompt tree scope", async () => {
    const { database, tree, service } = await fixture();
    const prompt = service.createConfirmationPrompt({ projectId: "p1", treeId: tree.treeId, scopeId: tree.treeId, prompt: "Execute?", workflowRevision: 1 });
    database.run("INSERT INTO trace_events (id, project_id, tree_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('unscoped-answer', 'p1', NULL, 's1', 'UserPromptSubmit', '{\"text\":\"yes\"}', 'now', 'unscoped-answer')");
    expect(() => service.confirmScope({ projectId: "p1", confirmationId: prompt.confirmationId, answer: "yes", answerTraceEventId: "unscoped-answer", workflowRevision: 1 }))
      .toThrow(expect.objectContaining({ code: "workflow_transition_rejected" }));
    database.close();
  });

  it("confirms one branch while keeping siblings isolated and blocking unconfirmed dependencies", async () => {
    const { database, tree, service } = await fixture();
    const taskTrees = new TaskTreeService(database);
    database.run("UPDATE workflow_states SET stage = 'task_tree_refinement' WHERE project_id = 'p1'");
    const document = branchDocument;
    const revision = taskTrees.saveDraftRevision({ projectId: "p1", treeId: tree.treeId, baseRevisionId: tree.revisionId, document });
    const readiness = taskTrees.scanPlanReadiness({ projectId: "p1", treeId: tree.treeId, scopeRootNodeId: "branch-a" });
    const workflow = database.get<{ revision: number }>("SELECT revision FROM workflow_states WHERE project_id = 'p1' AND active = 1")!;
    const prompt = service.createConfirmationPrompt({
      projectId: "p1", treeId: tree.treeId, scopeId: "branch-a", scopeRootNodeId: "branch-a",
      readinessResultId: readiness.resultId, prompt: "Confirm A?", workflowRevision: workflow.revision,
    });
    database.run("INSERT INTO trace_events (id, project_id, tree_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('branch-answer', 'p1', ?, 's1', 'UserPromptSubmit', '{\"text\":\"yes\"}', 'now', 'branch-answer')", tree.treeId);
    const result = service.confirmScope({ projectId: "p1", confirmationId: prompt.confirmationId, answer: "yes", answerTraceEventId: "branch-answer", workflowRevision: workflow.revision });

    expect(result).toMatchObject({ stage: "branch_confirmation", status: "confirmed", scopeKind: "branch" });
    expect(database.all<{ task_node_id: string; state: string }>(
      "SELECT task_node_id, state FROM task_node_confirmation_states WHERE tree_revision_id = ? ORDER BY task_node_id", revision.revisionId,
    )).toEqual([
      { task_node_id: "branch-a", state: "confirmed" },
      { task_node_id: "branch-b", state: "draft" },
      { task_node_id: "root", state: "partial_confirmed" },
    ]);
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = 'branch-a'")).toEqual({ status: "blocked_by_unconfirmed_dependency" });
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = 'branch-b'")).toEqual({ status: "draft" });
    database.close();
  });

  it("retains an inherited confirmed sibling when accepting a changed branch revision", async () => {
    const { database, tree, service } = await fixture();
    const taskTrees = new TaskTreeService(database);
    database.run("UPDATE workflow_states SET stage = 'task_tree_refinement' WHERE project_id = 'p1'");
    const first = taskTrees.saveDraftRevision({ projectId: "p1", treeId: tree.treeId, baseRevisionId: tree.revisionId, document: branchDocument });
    database.run(
      "UPDATE task_node_confirmation_states SET state = CASE task_node_id WHEN 'root' THEN 'partial_confirmed' ELSE 'confirmed' END WHERE tree_revision_id = ?",
      first.revisionId,
    );
    const changedDocument = {
      ...branchDocument,
      nodes: branchDocument.nodes.map((node) => node.id === "branch-a" ? { ...node, title: "A revised" } : node),
    };
    const second = taskTrees.saveDraftRevision({ projectId: "p1", treeId: tree.treeId, baseRevisionId: first.revisionId, document: changedDocument });
    const readiness = taskTrees.scanPlanReadiness({ projectId: "p1", treeId: tree.treeId, scopeRootNodeId: "branch-a" });
    const workflow = database.get<{ revision: number }>("SELECT revision FROM workflow_states WHERE project_id = 'p1' AND active = 1")!;
    const prompt = service.createConfirmationPrompt({
      projectId: "p1", treeId: tree.treeId, scopeId: "branch-a", scopeRootNodeId: "branch-a",
      readinessResultId: readiness.resultId, prompt: "Confirm revised A?", workflowRevision: workflow.revision,
    });
    database.run("INSERT INTO trace_events (id, project_id, tree_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('revision-answer', 'p1', ?, 's1', 'UserPromptSubmit', '{\"text\":\"yes\"}', 'now', 'revision-answer')", tree.treeId);
    service.confirmScope({ projectId: "p1", confirmationId: prompt.confirmationId, answer: "yes", answerTraceEventId: "revision-answer", workflowRevision: workflow.revision });

    expect(database.all<{ task_node_id: string; state: string }>(
      "SELECT task_node_id, state FROM task_node_confirmation_states WHERE tree_revision_id = ? ORDER BY task_node_id", second.revisionId,
    )).toEqual([
      { task_node_id: "branch-a", state: "confirmed" },
      { task_node_id: "branch-b", state: "confirmed" },
      { task_node_id: "root", state: "partial_confirmed" },
    ]);
    database.close();
  });

  it("promotes only draft Artifacts linked to the confirmed branch", async () => {
    const { database, tree, service } = await fixture();
    const taskTrees = new TaskTreeService(database);
    database.run("UPDATE workflow_states SET stage = 'task_tree_refinement' WHERE project_id = 'p1'");
    const document = {
      ...branchDocument,
      artifacts: [
        { id: "artifact-a", kind: "file" as const, locator: "src/branch-a.ts" },
        { id: "artifact-b", kind: "file" as const, locator: "src/branch-b.ts" },
        { id: "unlinked", kind: "file" as const, locator: "src/unlinked.ts" },
      ],
      artifactLinks: [
        { taskNodeId: "branch-a", artifactId: "artifact-a", relationType: "creates" as const },
        { taskNodeId: "branch-b", artifactId: "artifact-b", relationType: "creates" as const },
      ],
    };
    const revision = taskTrees.saveDraftRevision({ projectId: "p1", treeId: tree.treeId, baseRevisionId: tree.revisionId, document });
    const readiness = taskTrees.scanPlanReadiness({ projectId: "p1", treeId: tree.treeId, scopeRootNodeId: "branch-a" });
    const workflow = database.get<{ revision: number }>("SELECT revision FROM workflow_states WHERE project_id = 'p1' AND active = 1")!;
    const prompt = service.createConfirmationPrompt({
      projectId: "p1", treeId: tree.treeId, scopeId: "branch-a", scopeRootNodeId: "branch-a",
      readinessResultId: readiness.resultId, prompt: "Confirm A?", workflowRevision: workflow.revision,
    });
    database.run("INSERT INTO trace_events (id, project_id, tree_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('artifact-answer', 'p1', ?, 's1', 'UserPromptSubmit', '{\"text\":\"yes\"}', 'now', 'artifact-answer')", tree.treeId);
    service.confirmScope({ projectId: "p1", confirmationId: prompt.confirmationId, answer: "yes", answerTraceEventId: "artifact-answer", workflowRevision: workflow.revision });

    expect(database.all<{ id: string; status: string; planned_by_task_node_id: string | null; source_planning_revision_id: string | null }>(
      "SELECT id, status, planned_by_task_node_id, source_planning_revision_id FROM artifacts WHERE id IN ('artifact-a', 'artifact-b', 'unlinked') ORDER BY id",
    )).toEqual([
      { id: "artifact-a", status: "planned", planned_by_task_node_id: "branch-a", source_planning_revision_id: revision.revisionId },
      { id: "artifact-b", status: "draft", planned_by_task_node_id: null, source_planning_revision_id: revision.revisionId },
      { id: "unlinked", status: "draft", planned_by_task_node_id: null, source_planning_revision_id: revision.revisionId },
    ]);
    database.close();
  });

  it("rejects stale prompts after a Task Tree revision changes", async () => {
    const { database, tree, service } = await fixture();
    const prompt = service.createConfirmationPrompt({ projectId: "p1", treeId: tree.treeId, scopeId: tree.treeId, prompt: "Execute?", workflowRevision: 1 });
    database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES ('new-revision', ?, 2, ?, 'later')", tree.treeId, JSON.stringify(tree.document));
    database.run("UPDATE task_trees SET current_revision_id = 'new-revision' WHERE id = ?", tree.treeId);
    database.run("INSERT INTO trace_events (id, project_id, tree_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('stale-answer', 'p1', ?, 's1', 'UserPromptSubmit', '{\"text\":\"yes\"}', 'later', 'stale-answer')", tree.treeId);
    expect(() => service.confirmScope({ projectId: "p1", confirmationId: prompt.confirmationId, answer: "yes", answerTraceEventId: "stale-answer", workflowRevision: 1 }))
      .toThrow(expect.objectContaining({ code: "revision_conflict" }));
    database.close();
  });

  it("records rejection without creating an accepted confirmation record", async () => {
    const { database, tree, service } = await fixture();
    const prompt = service.createConfirmationPrompt({ projectId: "p1", treeId: tree.treeId, scopeId: tree.treeId, prompt: "Execute?", workflowRevision: 1 });
    database.run("INSERT INTO trace_events (id, project_id, tree_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('reject-answer', 'p1', ?, 's1', 'UserPromptSubmit', '{\"text\":\"no\"}', 'now', 'reject-answer')", tree.treeId);
    expect(service.confirmScope({ projectId: "p1", confirmationId: prompt.confirmationId, answer: "no", answerTraceEventId: "reject-answer", workflowRevision: 1 }))
      .toMatchObject({ stage: "branch_confirmation", status: "rejected" });
    expect(database.get<{ count: number }>("SELECT count(*) AS count FROM scope_confirmation_records")?.count).toBe(0);
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
