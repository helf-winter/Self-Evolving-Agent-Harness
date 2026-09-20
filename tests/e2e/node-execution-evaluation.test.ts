import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Node execution and evaluation vertical slice", () => {
  it("preserves skeleton-first execution and failed, failed, succeeded history across restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-execution-e2e-")); dirs.push(directory);
    const projectDir = path.join(directory, "project");
    await mkdir(projectDir);
    const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") };
    const first = openRuntime(environment);
    const project = await first.projects.resolve(projectDir, "persist");
    const root = await first.taskTrees.createTaskRoot({ projectId: project.projectId, title: "Build endpoint" });
    const document = {
      nodes: [
        { id: "root", parentId: null, title: "Build endpoint", children: ["skeleton", "implementation"] },
        {
          id: "skeleton", parentId: "root", title: "Define route contract", children: [], objectives: ["Define one route contract"],
          expectedOutputs: ["src/route.ts"], acceptanceCriteria: ["route compiles"], unresolvedQuestions: [], unresolvedDecisions: [],
          dependencies: [], requiredEvidence: [{ key: "compile", description: "compile succeeds" }], executionPhase: "skeleton" as const,
          stopDecompositionReason: "one verifiable contract",
        },
        {
          id: "implementation", parentId: "root", title: "Implement route", children: [], objectives: ["Implement one route"],
          expectedOutputs: ["src/route.ts"], acceptanceCriteria: ["route test passes"], unresolvedQuestions: [], unresolvedDecisions: [],
          dependencies: ["skeleton"], requiredEvidence: [{ key: "test", description: "route test succeeds" }], executionPhase: "implementation" as const,
          stopDecompositionReason: "one independently testable implementation",
        },
      ],
      relations: [{ fromNodeId: "implementation", toNodeId: "skeleton", kind: "depends_on" as const }],
      artifacts: [{ id: "route-file", kind: "file" as const, locator: "src/route.ts", status: "draft" as const }],
    };
    const revision = first.taskTrees.saveDraftRevision({ projectId: project.projectId, treeId: root.treeId, baseRevisionId: root.revisionId, document });
    expect(first.taskTrees.scanPlanReadiness({ projectId: project.projectId, treeId: root.treeId }).ready).toBe(true);
    const confirmation = first.workflows.createConfirmationPrompt({ projectId: project.projectId, treeId: root.treeId, scopeId: root.treeId, prompt: "Execute?", workflowRevision: 3 });
    const answer = await first.hooks.ingest(mapClaudeHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: projectDir, prompt: "yes" }));
    if (!answer.recorded) throw new Error("confirmation trace was not recorded");
    first.workflows.confirmScope({ projectId: project.projectId, confirmationId: confirmation.confirmationId, answer: "yes", answerTraceEventId: answer.eventId, workflowRevision: 3 });

    const skeleton = first.executions.startAttempt({ projectId: project.projectId, nodeId: "skeleton", expectedTreeRevisionId: revision.revisionId });
    const compile = await first.hooks.ingest(mapClaudeHook({ hook_event_name: "PostToolUse", session_id: "s1", cwd: projectDir, tool_name: "Bash", tool_use_id: "compile", tool_input: { command: "npm run build" }, tool_response: { exitCode: 0 } }));
    if (!compile.recorded) throw new Error("compile trace was not recorded");
    first.executions.attachEvidence({ projectId: project.projectId, attemptId: skeleton.attemptId, requiredEvidenceKey: "compile", traceEventId: compile.eventId });
    first.executions.beginVerification({ projectId: project.projectId, attemptId: skeleton.attemptId, expectedStatus: "running" });
    expect(first.evaluations.evaluateAttempt({ projectId: project.projectId, attemptId: skeleton.attemptId, proposedVerdict: "succeeded", riskSummary: null }).transition.applied).toBe(true);
    first.workflows.transition({ projectId: project.projectId, treeId: root.treeId, workflowRevision: 4, to: "skeleton_gate" });
    first.workflows.transition({ projectId: project.projectId, treeId: root.treeId, workflowRevision: 5, to: "branch_implementation", skeletonGateEvidenceId: skeleton.attemptId });

    for (const index of [1, 2]) {
      const attempt = first.executions.startAttempt({ projectId: project.projectId, nodeId: "implementation", expectedTreeRevisionId: revision.revisionId });
      first.executions.beginVerification({ projectId: project.projectId, attemptId: attempt.attemptId, expectedStatus: "running" });
      first.evaluations.evaluateAttempt({ projectId: project.projectId, attemptId: attempt.attemptId, proposedVerdict: "failed", riskSummary: `failure ${index}` });
    }
    const success = first.executions.startAttempt({ projectId: project.projectId, nodeId: "implementation", expectedTreeRevisionId: revision.revisionId });
    const test = await first.hooks.ingest(mapClaudeHook({ hook_event_name: "PostToolUse", session_id: "s1", cwd: projectDir, tool_name: "Bash", tool_use_id: "test", tool_input: { command: "npm test" }, tool_response: { exitCode: 0 } }));
    if (!test.recorded) throw new Error("test trace was not recorded");
    first.executions.attachEvidence({ projectId: project.projectId, attemptId: success.attemptId, requiredEvidenceKey: "test", traceEventId: test.eventId });
    first.executions.beginVerification({ projectId: project.projectId, attemptId: success.attemptId, expectedStatus: "running" });
    first.evaluations.evaluateAttempt({ projectId: project.projectId, attemptId: success.attemptId, proposedVerdict: "succeeded", riskSummary: null });
    first.drifts.recordDrift({
      projectId: project.projectId,
      treeId: root.treeId,
      nodeId: "implementation",
      actualArtifactId: "route-file",
      driftType: "relation_changed",
      severity: "warning",
      description: "The implementation refined the route relation",
      explanation: "The observed engineering relation is richer than the initial plan",
    });
    first.close();

    const reopened = openRuntime(environment);
    const detail = reopened.queries.getTaskNodeDetail(project.projectId, "implementation", { limit: 10 });
    expect(detail.status).toBe("succeeded");
    expect(detail.attempts.map((attempt) => attempt.status)).toEqual(["succeeded", "failed", "failed"]);
    expect(detail.evaluations.map((evaluation) => evaluation.verdict)).toEqual(["succeeded", "failed", "failed"]);
    expect(detail.evaluations[0]).toMatchObject({ coveredRequiredEvidence: ["test"], evidenceRefs: [test.eventId] });
    expect(reopened.queries.getTaskTreeSummary(project.projectId, root.treeId)).toMatchObject({ attemptCount: 4, evaluationCount: 4 });
    expect(reopened.queries.getArtifactGraphSummary(project.projectId, { treeId: root.treeId }).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifactId: "route-file", locator: "src/route.ts" }),
    ]));
    expect(reopened.queries.getArtifactDetail(project.projectId, "route-file").drifts).toEqual([
      expect.objectContaining({ severity: "warning", resolutionStatus: "recorded" }),
    ]);
    expect(reopened.queries.getPlanDriftSummary(project.projectId, { treeId: root.treeId, severity: "warning" }).items).toHaveLength(1);
    reopened.close();
  });
});
