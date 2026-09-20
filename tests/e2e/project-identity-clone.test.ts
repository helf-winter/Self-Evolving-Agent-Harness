import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";
import { normalizeProjectPath } from "../../src/domain/project.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Project Identity and Clone vertical slice", () => {
  it("turns a copied marker into an independent project and preserves provenance across restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-project-clone-e2e-"));
    dirs.push(directory);
    const sourceDir = path.join(directory, "source");
    const copyDir = path.join(directory, "copy");
    await mkdir(path.join(sourceDir, "src"), { recursive: true });
    const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") };

    const first = openRuntime(environment);
    const source = await first.projects.resolve(sourceDir, "persist");
    const root = await first.taskTrees.createTaskRoot({ projectId: source.projectId, title: "Clone-safe feature" });
    const rootId = root.document.nodes[0]!.id;
    const sourceDocument: TaskTreeDocument = {
      nodes: [
        { id: rootId, parentId: null, title: "Clone-safe feature", children: ["implementation"] },
        {
          id: "implementation", parentId: rootId, title: "Implement feature", children: [],
          objectives: ["Implement one independently verifiable feature"],
          expectedOutputs: [path.join(sourceDir, "src", "feature.ts")],
          acceptanceCriteria: ["feature test passes"], unresolvedQuestions: [], unresolvedDecisions: [],
          dependencies: [], requiredEvidence: [{ key: "test", description: "feature test" }],
          executionPhase: "implementation", stopDecompositionReason: "one independently testable output",
        },
      ],
      relations: [],
      artifacts: [{
        id: "feature-file", kind: "file", locator: path.join(sourceDir, "src", "feature.ts"), status: "modified",
        currentHashOrVersion: "hash:source",
      }],
      artifactLinks: [{ taskNodeId: "implementation", artifactId: "feature-file", relationType: "modifies" }],
    };
    const sourceRevision = first.taskTrees.saveDraftRevision({
      projectId: source.projectId, treeId: root.treeId, baseRevisionId: root.revisionId, document: sourceDocument,
    });
    const sourceTrace = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "source-session", cwd: sourceDir,
      prompt: "keep this source execution fact", timestamp: "2030-01-01T00:00:00.000Z",
    }));
    expect(sourceTrace.recorded).toBe(true);
    first.close();

    await cp(sourceDir, copyDir, { recursive: true });
    const second = openRuntime(environment);
    const inspected = await second.projects.resolve(copyDir, "inspect");
    expect(inspected).toMatchObject({ status: "copy_detected", projectId: source.projectId, sourceProjectId: source.projectId });
    expect(second.database.get<{ count: number }>("SELECT count(*) AS count FROM projects")?.count).toBe(1);

    const cloned = await second.projects.resolve(copyDir, "persist");
    expect(cloned).toMatchObject({ status: "copy_detected", sourceProjectId: source.projectId });
    expect(cloned.projectId).not.toBe(source.projectId);
    expect(cloned.cloneId).toBeTruthy();
    const copiedMarker = JSON.parse(await readFile(path.join(copyDir, ".agent-harness-project.json"), "utf8")) as {
      project_id: string;
    };
    expect(copiedMarker.project_id).toBe(cloned.projectId);

    const cloneList = second.queries.getProjectClones(cloned.projectId, { direction: "incoming" });
    expect(cloneList.items).toEqual([
      expect.objectContaining({
        cloneId: cloned.cloneId, sourceProjectId: source.projectId,
        targetProjectId: cloned.projectId, status: "completed",
      }),
    ]);
    const detail = second.queries.getProjectCloneDetail(cloned.projectId, cloned.cloneId!, {});
    const treeMap = detail.entityMaps.find((mapping) => mapping.entityType === "task_tree" && mapping.sourceEntityId === root.treeId);
    expect(treeMap).toBeDefined();
    const targetTreeId = treeMap!.targetEntityId;
    const targetRevision = second.taskTrees.getRevision(cloned.projectId, targetTreeId);
    expect(targetRevision.document.artifacts[0]).toMatchObject({
      locator: normalizeProjectPath(path.join(copyDir, "src", "feature.ts")), status: "planned",
    });
    expect(second.queries.getTraceEvents(cloned.projectId, { limit: 10 }).items).toEqual([]);
    expect(second.queries.getTraceEvents(source.projectId, { limit: 10 }).items).toHaveLength(1);
    expect(JSON.parse(second.database.get<{ state_json: string }>(
      "SELECT state_json FROM runtime_states WHERE project_id = ?", cloned.projectId,
    )!.state_json)).toMatchObject({ state: "paused_after_clone", requiresRevalidation: true });

    const targetDocument: TaskTreeDocument = {
      ...targetRevision.document,
      nodes: targetRevision.document.nodes.map((node) => node.parentId === null ? { ...node, title: "Copy-only title" } : node),
    };
    second.taskTrees.saveDraftRevision({
      projectId: cloned.projectId, treeId: targetTreeId,
      baseRevisionId: targetRevision.revisionId, document: targetDocument,
    });
    expect(second.taskTrees.getRevision(source.projectId, root.treeId)).toMatchObject({
      revisionId: sourceRevision.revisionId,
    });
    second.close();

    const reopened = openRuntime(environment);
    try {
      expect(await reopened.projects.resolve(sourceDir, "inspect")).toMatchObject({
        status: "same_project", projectId: source.projectId,
      });
      expect(await reopened.projects.resolve(copyDir, "inspect")).toMatchObject({
        status: "same_project", projectId: cloned.projectId,
      });
      expect(reopened.queries.getProjectCloneDetail(cloned.projectId, cloned.cloneId!, {}).clone.status).toBe("completed");
      expect(reopened.taskTrees.getRevision(cloned.projectId, targetTreeId).document.nodes[0]?.title).toBe("Copy-only title");
      expect(reopened.taskTrees.getRevision(source.projectId, root.treeId).document.nodes[0]?.title).toBe("Clone-safe feature");
    } finally {
      reopened.close();
    }
  });
});
