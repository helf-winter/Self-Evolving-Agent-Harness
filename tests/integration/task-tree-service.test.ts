import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskTreeService } from "../../src/application/task-tree-service.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
const validDocument = {
  nodes: [
    { id: "root", parentId: null, title: "Build runtime", children: ["leaf"] },
    {
      id: "leaf", parentId: "root", title: "Persist project", children: [], objectives: ["Persist one project"],
      expectedOutputs: ["runtime.db"], acceptanceCriteria: ["survives restart"], unresolvedQuestions: [],
      unresolvedDecisions: [], dependencies: [], requiredEvidence: [{ key: "test-output", description: "test output" }], executionPhase: "implementation" as const,
      stopDecompositionReason: "one verifiable result",
    },
  ],
  relations: [],
  artifacts: [{ id: "a1", kind: "file" as const, locator: "src/runtime.ts", status: "draft" as const }],
};
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-tree-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  for (const [id, projectPath] of [["p1", "/a"], ["p2", "/b"]] as const) {
    database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES (?, ?, ?, ?)", id, projectPath, "now", "now");
  }
  return { database, service: new TaskTreeService(database) };
}
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("TaskTreeService", () => {
  it("returns ranked candidates only from the requested project", async () => {
    const { database, service } = await fixture();
    await service.createTaskRoot({ projectId: "p1", title: "Authentication repair" });
    await service.createTaskRoot({ projectId: "p2", title: "Authentication elsewhere" });
    const candidates = service.listTaskTreeCandidates({ projectId: "p1", query: "auth" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ title: "Authentication repair", matchedBy: ["title"] });
    database.close();
  });

  it("stores complete drafts as immutable revisions and rejects a stale change set", async () => {
    const { database, service } = await fixture();
    const root = await service.createTaskRoot({ projectId: "p1", title: "Runtime" });
    const draft = service.saveDraftRevision({ projectId: "p1", treeId: root.treeId, baseRevisionId: root.revisionId, document: validDocument });
    expect(draft.revision).toBe(2);
    expect(() => service.applyDraftChangeSet({
      projectId: "p1", treeId: root.treeId, baseRevisionId: root.revisionId,
      operations: [{ op: "replace_document", document: validDocument }], affectedReferences: ["leaf"], decisionSummary: "stale edit",
    })).toThrow(expect.objectContaining({ code: "revision_conflict" }));
    expect(database.all("SELECT id FROM task_tree_revisions WHERE tree_id = ?", root.treeId)).toHaveLength(2);
    database.close();
  });

  it("rejects incomplete leaves and reports missing relation contracts", async () => {
    const { database, service } = await fixture();
    const root = await service.createTaskRoot({ projectId: "p1", title: "Runtime" });
    expect(() => service.saveDraftRevision({
      projectId: "p1", treeId: root.treeId, baseRevisionId: root.revisionId,
      document: { ...validDocument, nodes: [validDocument.nodes[0]!, { ...validDocument.nodes[1]!, acceptanceCriteria: [] }] },
    })).toThrow(expect.objectContaining({ code: "leaf_contract_invalid" }));

    const related = {
      ...validDocument,
      relations: [{ fromNodeId: "root", toNodeId: "leaf", kind: "calls" as const, artifactId: "missing" }],
    };
    expect(() => service.saveDraftRevision({ projectId: "p1", treeId: root.treeId, baseRevisionId: root.revisionId, document: related })).toThrow(expect.objectContaining({ code: "relation_artifact_required" }));
    database.close();
  });

  it("records a ready result for a valid current revision", async () => {
    const { database, service } = await fixture();
    const root = await service.createTaskRoot({ projectId: "p1", title: "Runtime" });
    const draft = service.saveDraftRevision({ projectId: "p1", treeId: root.treeId, baseRevisionId: root.revisionId, document: validDocument });
    expect(service.scanPlanReadiness({ projectId: "p1", treeId: root.treeId })).toMatchObject({ revisionId: draft.revisionId, ready: true, blockers: [] });
    expect(database.get<{ stage: string; revision: number }>("SELECT stage, revision FROM workflow_states WHERE project_id = 'p1' AND active = 1")).toEqual({
      stage: "branch_confirmation",
      revision: 3,
    });
    database.close();
  });

  it("marks a changed succeeded node as needing revalidation in the new revision", async () => {
    const { database, service } = await fixture();
    const root = await service.createTaskRoot({ projectId: "p1", title: "Runtime" });
    const first = service.saveDraftRevision({ projectId: "p1", treeId: root.treeId, baseRevisionId: root.revisionId, document: validDocument });
    database.run("UPDATE task_nodes SET status = 'succeeded' WHERE id = 'leaf'");
    const changed = {
      ...validDocument,
      nodes: [validDocument.nodes[0]!, { ...validDocument.nodes[1]!, title: "Persist project safely" }],
    };
    service.saveDraftRevision({ projectId: "p1", treeId: root.treeId, baseRevisionId: first.revisionId, document: changed });
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = 'leaf'")).toEqual({ status: "needs_revalidation" });
    database.close();
  });
});
