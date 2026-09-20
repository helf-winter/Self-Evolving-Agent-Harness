import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";
import type { FailureReproductionContract } from "../../src/domain/failure-case.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function reproduction(mode: "manual" | "automated", failureTraceId: string): FailureReproductionContract {
  return {
    mode,
    preconditions: ["fixture dependencies installed"],
    environmentManifest: { node: "22", os: "linux" },
    sourceRevisionRef: "git:broken",
    fixtureRefs: ["fixture:endpoint"],
    setupSteps: ["create isolated endpoint fixture"],
    reproductionSteps: ["run endpoint contract test"],
    cleanupSteps: ["remove isolated fixture"],
    entryCommand: mode === "manual" ? null : "npm test -- endpoint.test.ts",
    timeoutMs: mode === "manual" ? null : 30_000,
    isolationStrategy: "temporary_directory",
    expectedResult: "endpoint contract test passes",
    actualFailure: "endpoint assertion fails",
    failureOracle: { kind: "exit_code", expression: "exitCode == 1 and output contains endpoint assertion" },
    expectedFailureSignature: mode === "manual" ? null : "AssertionError:endpoint",
    preFixBaselineRef: mode === "automated" ? "git:broken" : null,
    postFixBaselineRef: mode === "automated" ? "git:fixed" : null,
    repeatPolicy: { runs: mode === "manual" ? 1 : 3, allowedFailures: 0 },
    automationCoverage: mode === "manual" ? 0 : 1,
    evidenceRefs: [failureTraceId],
  };
}

describe("Failure Case maturity vertical slice", () => {
  it("moves one failed Attempt from L0 through L1 and L3 to restart-persistent L4", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-failure-e2e-"));
    dirs.push(directory);
    const projectDir = path.join(directory, "project");
    await mkdir(projectDir);
    const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") };
    const first = openRuntime(environment);
    const project = await first.projects.resolve(projectDir, "persist");
    const root = await first.taskTrees.createTaskRoot({ projectId: project.projectId, title: "Stabilize endpoint" });
    const rootNodeId = root.document.nodes[0]!.id;
    const document: TaskTreeDocument = {
      nodes: [
        { id: rootNodeId, parentId: null, title: "Stabilize endpoint", children: ["endpoint-test"] },
        {
          id: "endpoint-test", parentId: rootNodeId, title: "Define stable endpoint contract", children: [],
          objectives: ["Make endpoint contract reliable"], expectedOutputs: ["tests/endpoint.test.ts"],
          acceptanceCriteria: ["endpoint contract test passes"], unresolvedQuestions: [], unresolvedDecisions: [],
          dependencies: [], requiredEvidence: [{ key: "endpoint-test", description: "endpoint test command" }],
          executionPhase: "skeleton", stopDecompositionReason: "one independently verifiable contract",
        },
      ],
      relations: [], artifacts: [],
    };
    const revision = first.taskTrees.saveDraftRevision({
      projectId: project.projectId, treeId: root.treeId, baseRevisionId: root.revisionId, document,
    });
    const readiness = first.taskTrees.scanPlanReadiness({ projectId: project.projectId, treeId: root.treeId });
    const workflowRevision = first.database.get<{ revision: number }>(
      "SELECT revision FROM workflow_states WHERE project_id = ? AND tree_id = ? AND active = 1",
      project.projectId, root.treeId,
    )!.revision;
    const prompt = first.workflows.createConfirmationPrompt({
      projectId: project.projectId, treeId: root.treeId, scopeId: root.treeId,
      readinessResultId: readiness.resultId, prompt: "Execute?", workflowRevision,
    });
    const answer = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "confirm", cwd: projectDir, prompt: "yes",
    }));
    if (!answer.recorded) throw new Error("confirmation Trace was not recorded");
    first.workflows.confirmScope({
      projectId: project.projectId, confirmationId: prompt.confirmationId, answer: "yes",
      answerTraceEventId: answer.eventId, workflowRevision,
    });

    const failedAttempt = first.executions.startAttempt({
      projectId: project.projectId, nodeId: "endpoint-test", expectedTreeRevisionId: revision.revisionId,
    });
    const failureTrace = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "failed-test", cwd: projectDir,
      tool_name: "Bash", tool_use_id: "endpoint-red", tool_input: { command: "npm test -- endpoint.test.ts" },
      tool_response: { exitCode: 1, stderr: "AssertionError: endpoint" },
    }));
    if (!failureTrace.recorded) throw new Error("failure Trace was not recorded");
    first.executions.attachEvidence({
      projectId: project.projectId, attemptId: failedAttempt.attemptId,
      requiredEvidenceKey: "endpoint-test", traceEventId: failureTrace.eventId,
    });
    first.executions.beginVerification({ projectId: project.projectId, attemptId: failedAttempt.attemptId, expectedStatus: "running" });
    first.evaluations.evaluateAttempt({
      projectId: project.projectId, attemptId: failedAttempt.attemptId,
      proposedVerdict: "failed", riskSummary: "endpoint assertion mismatch",
    });
    const failureCase = first.queries.getFailureCases(project.projectId, { treeId: root.treeId }).items[0]!;
    expect(failureCase).toMatchObject({ maturityLevel: "L0_observed", occurrenceCount: 1 });

    const manual = first.failures.addReproductionRevision({
      projectId: project.projectId, failureCaseId: failureCase.failureCaseId,
      contract: reproduction("manual", failureTrace.eventId),
    });
    const manualEvidence = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "manual-validation", cwd: projectDir,
      tool_name: "Bash", tool_use_id: "manual-red", tool_input: { command: "manual endpoint reproduction" },
      tool_response: { exitCode: 1, stderr: "AssertionError: endpoint" },
    }));
    if (!manualEvidence.recorded) throw new Error("manual validation Trace was not recorded");
    expect(first.failures.validateReproduction({
      projectId: project.projectId, failureCaseId: failureCase.failureCaseId,
      reproductionRevisionId: manual.reproductionRevisionId,
      observation: {
        preFixVerdict: "red", postFixVerdict: "not_run", oracleDiscriminationVerdict: "not_run",
        repeatStabilityVerdict: "not_run", isolationVerdict: "pass", evidenceRefs: [manualEvidence.eventId],
      },
      idempotencyKey: "manual-red",
    }).caseMaturity).toBe("L1_manual");

    const automated = first.failures.addReproductionRevision({
      projectId: project.projectId, failureCaseId: failureCase.failureCaseId,
      contract: reproduction("automated", failureTrace.eventId),
    });
    const redEvidence = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "automated-red", cwd: projectDir,
      tool_name: "Bash", tool_use_id: "stable-red", tool_input: { command: "repeat isolated pre-fix test" },
      tool_response: { exitCode: 1, repetitions: 3, signature: "AssertionError:endpoint" },
    }));
    if (!redEvidence.recorded) throw new Error("automated RED Trace was not recorded");
    expect(first.failures.validateReproduction({
      projectId: project.projectId, failureCaseId: failureCase.failureCaseId,
      reproductionRevisionId: automated.reproductionRevisionId,
      observation: {
        preFixVerdict: "red", postFixVerdict: "not_run", oracleDiscriminationVerdict: "pass",
        repeatStabilityVerdict: "pass", isolationVerdict: "pass", evidenceRefs: [redEvidence.eventId],
      },
      idempotencyKey: "automated-red",
    }).caseMaturity).toBe("L3_automated");

    const successfulAttempt = first.executions.startAttempt({
      projectId: project.projectId, nodeId: "endpoint-test", expectedTreeRevisionId: revision.revisionId,
    });
    const greenEvidence = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "post-fix-green", cwd: projectDir,
      tool_name: "Bash", tool_use_id: "stable-green", tool_input: { command: "npm test -- endpoint.test.ts" },
      tool_response: { exitCode: 0, repetitions: 3 },
    }));
    if (!greenEvidence.recorded) throw new Error("post-fix GREEN Trace was not recorded");
    first.executions.attachEvidence({
      projectId: project.projectId, attemptId: successfulAttempt.attemptId,
      requiredEvidenceKey: "endpoint-test", traceEventId: greenEvidence.eventId,
    });
    first.executions.beginVerification({ projectId: project.projectId, attemptId: successfulAttempt.attemptId, expectedStatus: "running" });
    first.evaluations.evaluateAttempt({
      projectId: project.projectId, attemptId: successfulAttempt.attemptId,
      proposedVerdict: "succeeded", riskSummary: null,
    });
    expect(first.failures.validateReproduction({
      projectId: project.projectId, failureCaseId: failureCase.failureCaseId,
      reproductionRevisionId: automated.reproductionRevisionId,
      observation: {
        preFixVerdict: "red", postFixVerdict: "green", oracleDiscriminationVerdict: "pass",
        repeatStabilityVerdict: "pass", isolationVerdict: "pass", evidenceRefs: [redEvidence.eventId, greenEvidence.eventId],
      },
      idempotencyKey: "automated-red-green",
    }).caseMaturity).toBe("L4_regression");
    first.close();

    const reopened = openRuntime(environment);
    try {
      const detail = reopened.queries.getFailureCaseDetail(project.projectId, failureCase.failureCaseId);
      expect(detail.failureCase).toMatchObject({
        maturityLevel: "L4_regression", availabilityStatus: "active",
        sourceNodeId: "endpoint-test", sourceAttemptId: failedAttempt.attemptId,
        currentReproductionRevisionId: automated.reproductionRevisionId,
      });
      expect(detail.occurrences).toHaveLength(1);
      expect(detail.reproductionRevisions.map((item) => item.mode)).toEqual(["observed", "manual", "automated"]);
      expect(detail.validationResults.map((item) => item.promotedMaturity)).toEqual(["L1_manual", "L3_automated", "L4_regression"]);
      expect(reopened.queries.getTaskNodeDetail(project.projectId, "endpoint-test", { limit: 10 }).attempts.map((item) => item.status))
        .toEqual(["succeeded", "failed"]);
    } finally {
      reopened.close();
    }
  });
});
