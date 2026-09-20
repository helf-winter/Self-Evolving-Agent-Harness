import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectCloneService } from "../../src/application/project-clone-service.js";
import { RuntimeQueryService } from "../../src/application/runtime-query-service.js";
import { TaskTreeService } from "../../src/application/task-tree-service.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-clone-service-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  database.run("INSERT INTO projects (id, canonical_path, marker_id, identity_token, display_path, platform, created_at, updated_at) VALUES ('source', '/work/source', 'source', 'source-token', '/work/source', 'linux', '2000', '2000')");
  database.run("INSERT INTO project_path_aliases (project_id, normalized_path, observed_path, platform, is_primary, created_at) VALUES ('source', '/work/source', '/work/source', 'linux', 1, '2000')");
  const taskTrees = new TaskTreeService(database);
  const root = await taskTrees.createTaskRoot({ projectId: "source", title: "Clone me" });
  const rootId = root.document.nodes[0]!.id;
  const document: TaskTreeDocument = {
    nodes: [
      { id: rootId, parentId: null, title: "Root", children: ["leaf"] },
      {
        id: "leaf", parentId: rootId, title: "Leaf", children: [], objectives: ["Implement clone fixture"],
        expectedOutputs: ["src/api.ts"], acceptanceCriteria: ["test passes"], unresolvedQuestions: [],
        unresolvedDecisions: [], dependencies: [rootId], requiredEvidence: [{ key: "test", description: "test passes" }],
        executionPhase: "implementation", stopDecompositionReason: "one fixture output",
      },
    ],
    relations: [{ fromNodeId: "leaf", toNodeId: rootId, kind: "calls", artifactId: "api-contract" }],
    artifacts: [
      { id: "api-file", kind: "file", locator: "/work/source/src/api.ts", status: "modified", currentHashOrVersion: "hash:source" },
      { id: "api-contract", kind: "contract", locator: "api.contract", status: "planned" },
    ],
    artifactLinks: [{ taskNodeId: "leaf", artifactId: "api-file", relationType: "modifies" }],
    artifactContracts: [{
      id: "api-v1", artifactId: "api-contract", name: "API", version: "1", compatibilityPolicy: "exact",
      schemaOrSignature: "GET /api", providerNodeIds: [rootId], consumerNodeIds: ["leaf"], validationRefs: ["npm test"],
    }],
  };
  const current = taskTrees.saveDraftRevision({ projectId: "source", treeId: root.treeId, baseRevisionId: root.revisionId, document });
  database.run("UPDATE task_nodes SET status = 'running' WHERE id = ?", rootId);
  database.run("UPDATE task_nodes SET status = 'succeeded' WHERE id = 'leaf'");
  const leafRevision = database.get<{ id: string }>(
    "SELECT id FROM task_node_revisions WHERE node_id = 'leaf' AND tree_revision_id = ?", current.revisionId,
  )!.id;
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('source-trace', 'source', ?, 'leaf', 's', 'PostToolUse', '{}', '2030', 'source-trace')", root.treeId);
  database.run("UPDATE artifacts SET source_trace_event_id = 'source-trace' WHERE project_id = 'source' AND locator = '/work/source/src/api.ts'");
  database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at, completed_at) VALUES ('source-attempt', 'source', ?, 'leaf', ?, 1, 'failed', '2030', '2030')", root.treeId, leafRevision);
  database.run("INSERT INTO evaluations (id, project_id, tree_id, task_node_id, task_node_revision_id, execution_attempt_id, verdict, evidence_refs_json, covered_required_evidence_json, missing_required_evidence_json, risk_summary, created_at) VALUES ('source-evaluation', 'source', ?, 'leaf', ?, 'source-attempt', 'failed', '[\"source-trace\"]', '[]', '[]', 'fixture failure', '2030')", root.treeId, leafRevision);
  return { database, service: new ProjectCloneService(database), treeId: root.treeId, rootId, current };
}

afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("ProjectCloneService", () => {
  it("transactionally clones engineering memory with rewritten IDs and no target execution facts", async () => {
    const { database, service, treeId, rootId } = await fixture();
    const cloned = service.cloneProject({
      sourceProjectId: "source", targetCanonicalPath: "/work/copy", targetDisplayPath: "/work/copy", platform: "linux",
    });
    expect(cloned).toMatchObject({ created: true, status: "incomplete", sourceProjectId: "source" });
    expect(cloned.targetProjectId).not.toBe("source");
    expect(cloned.identityToken).toMatch(/^[a-f0-9]{64}$/);
    expect(cloned.entityCounts).toMatchObject({ taskTrees: 1, taskTreeRevisions: 2, taskNodes: 2, inheritedEvidence: 1 });

    const treeMap = database.get<{ target_entity_id: string }>(
      "SELECT target_entity_id FROM project_clone_entity_maps WHERE clone_id = ? AND entity_type = 'task_tree' AND source_entity_id = ?",
      cloned.cloneId, treeId,
    )!;
    const rootMap = database.get<{ target_entity_id: string }>(
      "SELECT target_entity_id FROM project_clone_entity_maps WHERE clone_id = ? AND entity_type = 'task_node' AND source_entity_id = ?",
      cloned.cloneId, rootId,
    )!;
    const targetTree = database.get<{ current_revision_id: string; cloned_from_task_tree_id: string }>(
      "SELECT current_revision_id, cloned_from_task_tree_id FROM task_trees WHERE id = ? AND project_id = ?",
      treeMap.target_entity_id, cloned.targetProjectId,
    )!;
    expect(targetTree.cloned_from_task_tree_id).toBe(treeId);
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = ?", rootMap.target_entity_id))
      .toEqual({ status: "paused_after_clone" });
    const leafMap = database.get<{ target_entity_id: string }>(
      "SELECT target_entity_id FROM project_clone_entity_maps WHERE clone_id = ? AND entity_type = 'task_node' AND source_entity_id = 'leaf'",
      cloned.cloneId,
    )!;
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = ?", leafMap.target_entity_id))
      .toEqual({ status: "needs_revalidation" });
    const targetDocument = JSON.parse(database.get<{ document_json: string }>(
      "SELECT document_json FROM task_tree_revisions WHERE id = ?", targetTree.current_revision_id,
    )!.document_json) as TaskTreeDocument;
    expect(targetDocument.nodes.map((node) => node.id)).not.toContain(rootId);
    expect(targetDocument.nodes.find((node) => node.id === leafMap.target_entity_id)?.parentId).toBe(rootMap.target_entity_id);
    expect(targetDocument.artifacts.find((artifact) => artifact.kind === "file")).toMatchObject({
      locator: "/work/copy/src/api.ts", status: "planned",
    });
    expect(database.all("SELECT id FROM trace_events WHERE project_id = ?", cloned.targetProjectId)).toEqual([]);
    expect(database.all("SELECT id FROM execution_attempts WHERE project_id = ?", cloned.targetProjectId)).toEqual([]);
    expect(database.all("SELECT id FROM evaluations WHERE project_id = ?", cloned.targetProjectId)).toEqual([]);
    expect(database.all("SELECT id FROM project_clone_inherited_evidence WHERE target_project_id = ?", cloned.targetProjectId)).toHaveLength(1);
    expect(database.get<{ source_trace_event_id: string | null; status: string }>(
      "SELECT source_trace_event_id, status FROM artifacts WHERE project_id = ? AND kind = 'file'", cloned.targetProjectId,
    )).toEqual({ source_trace_event_id: null, status: "planned" });
    expect(JSON.parse(database.get<{ state_json: string }>(
      "SELECT state_json FROM runtime_states WHERE project_id = ?", cloned.targetProjectId,
    )!.state_json)).toMatchObject({ state: "paused_after_clone", sourceProjectId: "source", cloneId: cloned.cloneId });

    service.markMarkerWritten({ cloneId: cloned.cloneId, targetProjectId: cloned.targetProjectId });
    expect(database.get<{ status: string }>("SELECT status FROM project_clone_records WHERE id = ?", cloned.cloneId))
      .toEqual({ status: "completed" });
    expect(service.cloneProject({
      sourceProjectId: "source", targetCanonicalPath: "/work/copy", targetDisplayPath: "/work/copy", platform: "linux",
    })).toMatchObject({ created: false, cloneId: cloned.cloneId, targetProjectId: cloned.targetProjectId, status: "completed" });
    const queries = new RuntimeQueryService(database);
    expect(queries.getProjectClones("source", { direction: "outgoing" }).items)
      .toEqual([expect.objectContaining({ cloneId: cloned.cloneId, targetProjectId: cloned.targetProjectId })]);
    expect(queries.getProjectCloneDetail(cloned.targetProjectId, cloned.cloneId, {})).toMatchObject({
      clone: { cloneId: cloned.cloneId, sourceProjectId: "source", targetProjectId: cloned.targetProjectId, status: "completed" },
      entityMaps: expect.arrayContaining([expect.objectContaining({ entityType: "task_tree" })]),
      inheritedEvidence: [expect.objectContaining({ inheritanceStatus: "needs_revalidation" })],
    });
    database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('unrelated', '/work/unrelated', 'now', 'now')");
    expect(() => queries.getProjectCloneDetail("unrelated", cloned.cloneId, {}))
      .toThrow(expect.objectContaining({ code: "not_found" }));
    database.close();
  });

  it("rolls back the entire target when source integrity prevents cloning", async () => {
    const { database, service } = await fixture();
    database.run("UPDATE task_tree_revisions SET document_json = '{bad json' WHERE revision = 1");
    expect(() => service.cloneProject({
      sourceProjectId: "source", targetCanonicalPath: "/work/broken", targetDisplayPath: "/work/broken", platform: "linux",
    })).toThrow();
    expect(database.get("SELECT id FROM projects WHERE canonical_path = '/work/broken'")).toBeUndefined();
    expect(database.get("SELECT id FROM project_clone_records WHERE target_path = '/work/broken'")).toBeUndefined();
    database.close();
  });
});
