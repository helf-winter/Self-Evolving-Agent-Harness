import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Parent-child Task communication", () => {
  it("restores derived child results and requires an independent parent Evaluation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-parent-child-e2e-"));
    dirs.push(directory);
    const projectDir = path.join(directory, "project");
    await mkdir(projectDir);
    const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") };

    const first = openRuntime(environment);
    const project = await first.projects.resolve(projectDir, "persist");
    const root = await first.taskTrees.createTaskRoot({ projectId: project.projectId, title: "Deliver integrated runtime" });
    const document = {
      nodes: [
        {
          id: "parent", parentId: null, title: "Verify integrated runtime", children: ["child"],
          executionPhase: "verification" as const, dependencies: [],
          requiredEvidence: [{ key: "integration", description: "integration test passes" }],
        },
        {
          id: "child", parentId: "parent", title: "Build runtime skeleton", children: [],
          objectives: ["Build one runtime skeleton"], expectedOutputs: ["src/runtime.ts"],
          acceptanceCriteria: ["runtime compiles"], unresolvedQuestions: [], unresolvedDecisions: [], dependencies: [],
          requiredEvidence: [{ key: "compile", description: "compile succeeds" }], executionPhase: "skeleton" as const,
          stopDecompositionReason: "one independently verifiable skeleton",
        },
      ],
      relations: [],
      artifacts: [{ id: "runtime-file", kind: "file" as const, locator: "src/runtime.ts", status: "draft" as const }],
      artifactLinks: [{ taskNodeId: "child", artifactId: "runtime-file", relationType: "creates" as const }],
    };
    const revision = first.taskTrees.saveDraftRevision({
      projectId: project.projectId, treeId: root.treeId, baseRevisionId: root.revisionId, document,
    });
    expect(first.taskTrees.scanPlanReadiness({ projectId: project.projectId, treeId: root.treeId }).ready).toBe(true);
    const confirmation = first.workflows.createConfirmationPrompt({
      projectId: project.projectId, treeId: root.treeId, scopeId: root.treeId,
      readinessResultId: first.database.get<{ id: string }>(
        "SELECT id FROM plan_readiness_results WHERE tree_id = ? ORDER BY created_at DESC LIMIT 1", root.treeId,
      )!.id,
      prompt: "Execute the tree?", workflowRevision: 3,
    });
    const answer = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "parent-child-run", cwd: projectDir, prompt: "yes",
    }));
    if (!answer.recorded) throw new Error("confirmation Trace was not recorded");
    first.workflows.confirmScope({
      projectId: project.projectId, confirmationId: confirmation.confirmationId, answer: "yes",
      answerTraceEventId: answer.eventId, workflowRevision: 3,
    });

    const childAttempt = first.executions.startAttempt({ projectId: project.projectId, nodeId: "child", expectedTreeRevisionId: revision.revisionId });
    const childTrace = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "parent-child-run", cwd: projectDir,
      tool_name: "Bash", tool_use_id: "child-compile", tool_input: { command: "npm run build" },
      tool_response: { exitCode: 0 },
    }));
    if (!childTrace.recorded) throw new Error("child Trace was not recorded");
    first.executions.attachEvidence({
      projectId: project.projectId, attemptId: childAttempt.attemptId,
      requiredEvidenceKey: "compile", traceEventId: childTrace.eventId,
    });
    first.executions.beginVerification({ projectId: project.projectId, attemptId: childAttempt.attemptId, expectedStatus: "running" });
    const childEvaluation = first.evaluations.evaluateAttempt({
      projectId: project.projectId, attemptId: childAttempt.attemptId, proposedVerdict: "succeeded", riskSummary: null,
    });
    expect(childEvaluation.transition.applied).toBe(true);
    first.close();

    const reopened = openRuntime(environment);
    try {
      const restoredParent = reopened.queries.getTaskNodeDetail(project.projectId, "parent", {});
      expect(restoredParent.childSummary).toMatchObject({ total: 1, allChildrenSucceeded: true, readyForParentEvaluation: true });
      expect(restoredParent.childReports).toEqual([expect.objectContaining({
        nodeId: "child", status: "succeeded",
        latestEvaluation: expect.objectContaining({ evaluationId: childEvaluation.evaluation.evaluationId, verdict: "succeeded" }),
        artifactCounts: { total: 1, planned: 1, actual: 0 },
      })]);

      reopened.workflows.transition({ projectId: project.projectId, treeId: root.treeId, workflowRevision: 4, to: "skeleton_gate" });
      reopened.workflows.transition({
        projectId: project.projectId, treeId: root.treeId, workflowRevision: 5,
        to: "branch_implementation", skeletonGateEvidenceId: childAttempt.attemptId,
      });
      reopened.workflows.transition({ projectId: project.projectId, treeId: root.treeId, workflowRevision: 6, to: "branch_verification" });
      reopened.workflows.transition({ projectId: project.projectId, treeId: root.treeId, workflowRevision: 7, to: "root_verification" });
      const parentAttempt = reopened.executions.startAttempt({
        projectId: project.projectId, nodeId: "parent", expectedTreeRevisionId: revision.revisionId,
      });
      const parentTrace = await reopened.hooks.ingest(mapClaudeHook({
        hook_event_name: "PostToolUse", session_id: "parent-child-run", cwd: projectDir,
        tool_name: "Bash", tool_use_id: "parent-integration", tool_input: { command: "npm test -- integration" },
        tool_response: { exitCode: 0 },
      }));
      if (!parentTrace.recorded) throw new Error("parent Trace was not recorded");
      reopened.executions.attachEvidence({
        projectId: project.projectId, attemptId: parentAttempt.attemptId,
        requiredEvidenceKey: "integration", traceEventId: parentTrace.eventId,
      });
      reopened.executions.beginVerification({ projectId: project.projectId, attemptId: parentAttempt.attemptId, expectedStatus: "running" });
      const parentEvaluation = reopened.evaluations.evaluateAttempt({
        projectId: project.projectId, attemptId: parentAttempt.attemptId,
        proposedVerdict: "succeeded", riskSummary: null,
      });
      expect(parentEvaluation.transition).toMatchObject({ applied: true, targetStatus: "succeeded" });
      expect(parentEvaluation.evaluation.evaluationId).not.toBe(childEvaluation.evaluation.evaluationId);
      expect(reopened.queries.getTaskNodeDetail(project.projectId, "parent", {}).evaluations)
        .toEqual([expect.objectContaining({ evaluationId: parentEvaluation.evaluation.evaluationId, verdict: "succeeded" })]);
    } finally {
      reopened.close();
    }
  });
});
