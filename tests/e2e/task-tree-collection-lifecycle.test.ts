import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Task Tree Collection lifecycle", () => {
  it("preserves revisions and Trace while restore remains inactive after Runtime restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-tree-collection-e2e-"));
    dirs.push(directory);
    const projectDir = path.join(directory, "project");
    await mkdir(projectDir);
    const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") };

    const firstRuntime = openRuntime(environment);
    const project = await firstRuntime.projects.resolve(projectDir, "persist");
    const historical = await firstRuntime.taskTrees.createTaskRoot({ projectId: project.projectId, title: "Historical tree" });
    const rootId = historical.document.nodes[0]!.id;
    const document: TaskTreeDocument = {
      nodes: [
        { id: rootId, parentId: null, title: "Historical tree", children: ["historical-leaf"] },
        {
          id: "historical-leaf", parentId: rootId, title: "Persist history", children: [],
          objectives: ["Persist tree history"], expectedOutputs: ["history.db"],
          acceptanceCriteria: ["history survives restart"], unresolvedQuestions: [], unresolvedDecisions: [],
          dependencies: [], requiredEvidence: [{ key: "restart", description: "restart verification" }],
          executionPhase: "implementation", stopDecompositionReason: "one independently verifiable result",
        },
      ],
      relations: [], artifacts: [],
    };
    const historicalRevision = firstRuntime.taskTrees.saveDraftRevision({
      projectId: project.projectId, treeId: historical.treeId, baseRevisionId: historical.revisionId, document,
    });
    await firstRuntime.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "tree-collection-run", cwd: projectDir,
      prompt_id: "historical-prompt", prompt: "preserve this tree",
    }));
    const current = await firstRuntime.taskTrees.createTaskRoot({ projectId: project.projectId, title: "Current tree" });
    firstRuntime.taskTrees.selectTaskTree({ projectId: project.projectId, treeId: historical.treeId });
    firstRuntime.taskTrees.archiveTaskTree({ projectId: project.projectId, treeId: historical.treeId });
    firstRuntime.taskTrees.selectTaskTree({ projectId: project.projectId, treeId: current.treeId });
    firstRuntime.close();

    const reopened = openRuntime(environment);
    try {
      expect(reopened.taskTrees.listTaskTreeCandidates({ projectId: project.projectId }))
        .toEqual([expect.objectContaining({ treeId: current.treeId, selected: true })]);
      expect(reopened.taskTrees.listTaskTreeCandidates({ projectId: project.projectId, includeArchived: true }))
        .toEqual(expect.arrayContaining([expect.objectContaining({ treeId: historical.treeId, status: "archived" })]));

      const restored = reopened.taskTrees.restoreTaskTree({ projectId: project.projectId, treeId: historical.treeId });
      expect(restored).toMatchObject({ treeId: historical.treeId, status: "draft", selected: false, selectedTreeId: current.treeId });
      expect(reopened.taskTrees.getRevision(project.projectId, historical.treeId))
        .toMatchObject({ revisionId: historicalRevision.revisionId, revision: 2 });
      expect(reopened.queries.getTraceEvents(project.projectId, { treeId: historical.treeId, limit: 10 }).items)
        .toEqual([expect.objectContaining({ eventName: "UserPromptSubmit", sessionId: "tree-collection-run" })]);
      expect(reopened.database.get<{ selected_tree_id: string }>(
        "SELECT selected_tree_id FROM runtime_states WHERE project_id = ?", project.projectId,
      )).toEqual({ selected_tree_id: current.treeId });
      expect(reopened.database.get<{ active: number }>(
        "SELECT active FROM workflow_states WHERE project_id = ? AND tree_id = ?", project.projectId, historical.treeId,
      )).toEqual({ active: 0 });
      expect(reopened.database.all("SELECT id FROM task_tree_revisions WHERE tree_id = ?", historical.treeId)).toHaveLength(2);
    } finally {
      reopened.close();
    }
  });
});
