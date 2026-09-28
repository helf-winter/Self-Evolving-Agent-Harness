import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

const leaf = (id: string, parentId: string, title: string) => ({
  id, parentId, title, children: [], objectives: [`Implement ${title}`], expectedOutputs: [`src/${id}.ts`],
  acceptanceCriteria: [`${title} test passes`], unresolvedQuestions: [], unresolvedDecisions: [], dependencies: [],
  requiredEvidence: [{ key: `${id}-test`, description: `${title} test` }], executionPhase: "implementation" as const,
  stopDecompositionReason: "one independently verifiable output",
});

describe("Tree-centered Runtime View", () => {
  it("restores progressive views, stable relation references, and explicit overlay filters after restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-tree-view-e2e-"));
    dirs.push(directory);
    const projectDir = path.join(directory, "project");
    await mkdir(projectDir);
    const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") };

    const first = openRuntime(environment);
    const project = await first.projects.resolve(projectDir, "persist");
    const root = await first.taskTrees.createTaskRoot({ projectId: project.projectId, title: "Tree-centered runtime" });
    first.taskTrees.saveDraftRevision({
      projectId: project.projectId, treeId: root.treeId, baseRevisionId: root.revisionId,
      document: {
        nodes: [
          { id: "view-root", parentId: null, title: "Tree-centered runtime", children: ["branch-a", "branch-b"] },
          { id: "branch-a", parentId: "view-root", title: "Runtime API", children: ["provider", "consumer"] },
          leaf("provider", "branch-a", "Provider"), leaf("consumer", "branch-a", "Consumer"),
          leaf("branch-b", "view-root", "Documentation"),
        ],
        relations: [
          { fromNodeId: "consumer", toNodeId: "provider", kind: "calls", artifactId: "runtime-api" },
          { fromNodeId: "consumer", toNodeId: "provider", kind: "depends_on", dependencyKind: "execution_order" },
          { fromNodeId: "branch-b", toNodeId: "branch-a", kind: "coordinates_with", coordinationKind: "schedule_only" },
        ],
        artifacts: [{ id: "runtime-api", kind: "contract", locator: "runtime-api", status: "planned" }],
        artifactLinks: [
          { taskNodeId: "provider", artifactId: "runtime-api", relationType: "implements" },
          { taskNodeId: "consumer", artifactId: "runtime-api", relationType: "consumes" },
        ],
      },
    });
    const beforeRestart = first.queries.getTreeView(project.projectId, {
      treeId: root.treeId, depth: "detail", selectedNodeId: "consumer", includeRelationOverlay: true,
    });
    const relationIds = beforeRestart.relations.map((relation) => relation.relationId).sort();
    expect(relationIds).toHaveLength(3);
    expect(relationIds.every((relationId) => !relationId.startsWith("revision:"))).toBe(true);
    first.close();

    const reopened = openRuntime(environment);
    try {
      const snapshot = reopened.queries.getTreeView(project.projectId, { treeId: root.treeId, depth: "snapshot" });
      expect(snapshot.relationOverlay).toBe(false);
      expect(snapshot.relations).toEqual([
        expect.objectContaining({ kind: "depends_on", status: "unconfirmed_dependency", risk: "medium" }),
      ]);

      const summary = reopened.queries.getTreeView(project.projectId, {
        treeId: root.treeId, depth: "summary", selectedNodeId: "consumer",
      });
      expect(summary.relations).toHaveLength(2);
      expect(summary.selectedNodeContext).toMatchObject({
        nodeId: "consumer", artifactIds: ["runtime-api"], relationCounts: { incoming: 0, outgoing: 2, attention: 1 },
      });

      const implicitDetail = reopened.queries.getTreeView(project.projectId, {
        treeId: root.treeId, depth: "detail", selectedNodeId: "consumer",
      });
      expect(implicitDetail.relationOverlay).toBe(false);
      expect(implicitDetail.relations).toHaveLength(2);

      const branchOverlay = reopened.queries.getTreeView(project.projectId, {
        treeId: root.treeId, depth: "detail", selectedNodeId: "consumer", includeRelationOverlay: true,
        branchRootNodeId: "branch-a",
      });
      expect(branchOverlay.relationOverlay).toBe(true);
      expect(branchOverlay.relations).toHaveLength(2);
      expect(branchOverlay.relations.map((relation) => relation.relationId).sort())
        .toEqual(relationIds.filter((relationId) => beforeRestart.relations.find((relation) => relation.relationId === relationId)?.kind !== "coordinates_with").sort());

      const filtered = reopened.queries.getTreeView(project.projectId, {
        treeId: root.treeId, depth: "detail", selectedNodeId: "consumer", includeRelationOverlay: true,
        relationKinds: ["calls"], direction: "outgoing", artifactId: "runtime-api", risks: ["low"],
      });
      expect(filtered.relations).toEqual([expect.objectContaining({ kind: "calls", artifactId: "runtime-api", risk: "low" })]);
      expect(reopened.queries.getTreeView(project.projectId, {
        treeId: root.treeId, depth: "detail", selectedNodeId: "consumer", includeRelationOverlay: true,
      }).relations.map((relation) => relation.relationId).sort()).toEqual(relationIds);
    } finally {
      reopened.close();
    }
  });
});

