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
const branchedDocument = {
  nodes: [
    { id: "root", parentId: null, title: "Build runtime", children: ["branch-a", "branch-b"] },
    {
      id: "branch-a", parentId: "root", title: "Branch A", children: [], objectives: ["Implement A"],
      expectedOutputs: ["a.ts"], acceptanceCriteria: ["A passes"], unresolvedQuestions: [], unresolvedDecisions: [],
      dependencies: [], requiredEvidence: [{ key: "a-test", description: "A tests" }], executionPhase: "implementation" as const,
      stopDecompositionReason: "one independently verifiable branch",
    },
    {
      id: "branch-b", parentId: "root", title: "Branch B", children: [], objectives: ["Implement B"],
      expectedOutputs: ["b.ts"], acceptanceCriteria: ["B passes"], unresolvedQuestions: [], unresolvedDecisions: [],
      dependencies: [], requiredEvidence: [{ key: "b-test", description: "B tests" }], executionPhase: "implementation" as const,
      stopDecompositionReason: "one independently verifiable branch",
    },
  ],
  relations: [],
  artifacts: [],
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

  it("records readiness for an exact branch scope and rejects unknown roots", async () => {
    const { database, service } = await fixture();
    const root = await service.createTaskRoot({ projectId: "p1", title: "Runtime" });
    const draft = service.saveDraftRevision({ projectId: "p1", treeId: root.treeId, baseRevisionId: root.revisionId, document: branchedDocument });
    const result = service.scanPlanReadiness({ projectId: "p1", treeId: root.treeId, scopeRootNodeId: "branch-a" });
    expect(result).toMatchObject({
      revisionId: draft.revisionId,
      ready: true,
      scopeKind: "branch",
      scopeRootNodeId: "branch-a",
      coveredNodeIds: ["branch-a"],
    });
    expect(database.get<{ scope_kind: string; scope_root_node_id: string }>(
      "SELECT scope_kind, scope_root_node_id FROM plan_readiness_results WHERE id = ?", result.resultId,
    )).toEqual({ scope_kind: "branch", scope_root_node_id: "branch-a" });
    expect(() => service.scanPlanReadiness({ projectId: "p1", treeId: root.treeId, scopeRootNodeId: "missing" }))
      .toThrow(expect.objectContaining({ code: "not_found" }));
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

  it("preserves an unchanged confirmed sibling and invalidates only the changed branch", async () => {
    const { database, service } = await fixture();
    const root = await service.createTaskRoot({ projectId: "p1", title: "Runtime" });
    const first = service.saveDraftRevision({ projectId: "p1", treeId: root.treeId, baseRevisionId: root.revisionId, document: branchedDocument });
    database.run(
      "UPDATE task_node_confirmation_states SET state = CASE task_node_id WHEN 'root' THEN 'partial_confirmed' ELSE 'confirmed' END WHERE tree_revision_id = ?",
      first.revisionId,
    );
    const changed = {
      ...branchedDocument,
      nodes: branchedDocument.nodes.map((node) => node.id === "branch-a" ? { ...node, title: "Branch A revised" } : node),
    };
    const second = service.saveDraftRevision({ projectId: "p1", treeId: root.treeId, baseRevisionId: first.revisionId, document: changed });
    expect(database.all<{ task_node_id: string; state: string }>(
      "SELECT task_node_id, state FROM task_node_confirmation_states WHERE tree_revision_id = ? ORDER BY task_node_id", second.revisionId,
    )).toEqual([
      { task_node_id: "branch-a", state: "pending_user_confirmation" },
      { task_node_id: "branch-b", state: "confirmed" },
      { task_node_id: "root", state: "partial_confirmed" },
    ]);
    database.close();
  });

  it("projects Artifact links, relations, and contracts from an immutable planning revision", async () => {
    const { database, service } = await fixture();
    const root = await service.createTaskRoot({ projectId: "p1", title: "Runtime" });
    const document = {
      ...branchedDocument,
      artifacts: [
        { id: "api", kind: "contract" as const, locator: "contract:api", metadata: { owner: "runtime" } },
        { id: "file", kind: "file" as const, locator: "src/api.ts" },
      ],
      artifactLinks: [
        { taskNodeId: "branch-a", artifactId: "api", relationType: "implements" as const },
        { taskNodeId: "branch-b", artifactId: "api", relationType: "consumes" as const },
        { taskNodeId: "branch-a", artifactId: "file", relationType: "creates" as const },
      ],
      artifactRelations: [{ fromArtifactId: "file", toArtifactId: "api", kind: "calls" as const }],
      artifactContracts: [{
        id: "api-v1", artifactId: "api", name: "Runtime API", version: "1", compatibilityPolicy: "exact" as const,
        schemaOrSignature: "GET /runtime", providerNodeIds: ["branch-a"], consumerNodeIds: ["branch-b"], validationRefs: ["contract-test"],
      }],
    };
    const revision = service.saveDraftRevision({ projectId: "p1", treeId: root.treeId, baseRevisionId: root.revisionId, document });
    database.close();

    const reopened = new RuntimeDatabase(database.filename);
    expect(reopened.all<{ relation_type: string; artifact_id: string }>(
      "SELECT relation_type, artifact_id FROM task_node_artifact_links WHERE tree_revision_id = ? ORDER BY relation_type", revision.revisionId,
    )).toEqual([
      { relation_type: "consumes", artifact_id: "api" },
      { relation_type: "creates", artifact_id: "file" },
      { relation_type: "implements", artifact_id: "api" },
    ]);
    expect(reopened.get<{ source_planning_revision_id: string; granularity: string; metadata_json: string }>(
      "SELECT source_planning_revision_id, granularity, metadata_json FROM artifacts WHERE id = 'api'",
    )).toEqual({ source_planning_revision_id: revision.revisionId, granularity: "contract", metadata_json: '{"owner":"runtime"}' });
    expect(reopened.get<{ contract_name: string; provider_revision_ids_json: string; consumer_revision_ids_json: string }>(
      "SELECT contract_name, provider_revision_ids_json, consumer_revision_ids_json FROM artifact_contracts WHERE contract_id = 'api-v1' AND tree_revision_id = ?",
      revision.revisionId,
    )).toEqual(expect.objectContaining({ contract_name: "Runtime API" }));
    expect(reopened.get<{ kind: string }>("SELECT kind FROM artifact_graph_relations WHERE tree_revision_id = ?", revision.revisionId)).toEqual({ kind: "calls" });
    reopened.close();
  });
});
