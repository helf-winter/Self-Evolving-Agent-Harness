import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("branch confirmation vertical slice", () => {
  it("persists sibling isolation across restart and gates execution to the confirmed branch", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-branch-confirmation-"));
    dirs.push(directory);
    const projectDir = path.join(directory, "project");
    await mkdir(projectDir);
    const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") };

    const first = openRuntime(environment);
    const project = await first.projects.resolve(projectDir, "persist");
    const root = await first.taskTrees.createTaskRoot({ projectId: project.projectId, title: "Build two branches" });
    const document = {
      nodes: [
        { id: "root", parentId: null, title: "Build two branches", children: ["branch-a", "branch-b"] },
        {
          id: "branch-a", parentId: "root", title: "A", children: [], objectives: ["A"], expectedOutputs: ["a.ts"],
          acceptanceCriteria: ["A passes"], unresolvedQuestions: [], unresolvedDecisions: [], dependencies: [],
          requiredEvidence: [{ key: "a-test", description: "A tests" }], executionPhase: "implementation" as const,
          stopDecompositionReason: "one executable branch",
        },
        {
          id: "branch-b", parentId: "root", title: "B", children: [], objectives: ["B"], expectedOutputs: ["b.ts"],
          acceptanceCriteria: ["B passes"], unresolvedQuestions: [], unresolvedDecisions: [], dependencies: [],
          requiredEvidence: [{ key: "b-test", description: "B tests" }], executionPhase: "implementation" as const,
          stopDecompositionReason: "one executable branch",
        },
      ],
      relations: [], artifacts: [],
    };
    const revision = first.taskTrees.saveDraftRevision({ projectId: project.projectId, treeId: root.treeId, baseRevisionId: root.revisionId, document });
    const readiness = first.taskTrees.scanPlanReadiness({ projectId: project.projectId, treeId: root.treeId, scopeRootNodeId: "branch-a" });
    const workflow = first.database.get<{ revision: number }>("SELECT revision FROM workflow_states WHERE project_id = ? AND active = 1", project.projectId)!;
    const prompt = first.workflows.createConfirmationPrompt({
      projectId: project.projectId, treeId: root.treeId, scopeId: "branch-a", scopeRootNodeId: "branch-a",
      readinessResultId: readiness.resultId, prompt: "Confirm A?", workflowRevision: workflow.revision,
    });
    const answer = await first.hooks.ingest(mapClaudeHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: projectDir, prompt: "yes" }));
    if (!answer.recorded) throw new Error("confirmation Trace was not recorded");
    first.workflows.confirmScope({
      projectId: project.projectId, confirmationId: prompt.confirmationId, answer: "yes",
      answerTraceEventId: answer.eventId, workflowRevision: workflow.revision,
    });
    first.close();

    const reopened = openRuntime(environment);
    const summary = reopened.queries.getTaskTreeSummary(project.projectId, root.treeId);
    expect(summary.confirmationCounts).toEqual({ draft: 1, pendingUserConfirmation: 0, confirmed: 1, partialConfirmed: 1 });
    expect(summary.nodes).toEqual([
      expect.objectContaining({ id: "root", confirmationState: "partial_confirmed" }),
      expect.objectContaining({ id: "branch-a", confirmationState: "confirmed" }),
      expect.objectContaining({ id: "branch-b", confirmationState: "draft" }),
    ]);

    reopened.database.run("UPDATE workflow_states SET stage = 'branch_implementation' WHERE project_id = ? AND active = 1", project.projectId);
    reopened.database.run("UPDATE task_nodes SET status = 'ready' WHERE id = 'branch-b'");
    expect(reopened.executions.startAttempt({ projectId: project.projectId, nodeId: "branch-a", expectedTreeRevisionId: revision.revisionId }))
      .toMatchObject({ nodeId: "branch-a", status: "running" });
    expect(() => reopened.executions.startAttempt({ projectId: project.projectId, nodeId: "branch-b", expectedTreeRevisionId: revision.revisionId }))
      .toThrow(expect.objectContaining({ code: "attempt_not_executable" }));
    reopened.close();
  });
});
