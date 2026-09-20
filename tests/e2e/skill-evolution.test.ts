import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Skill Evolution vertical slice", () => {
  it("promotes a failed-failed-succeeded Experience through four evidence-backed splits and restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-skill-e2e-"));
    dirs.push(directory);
    const projectDir = path.join(directory, "project");
    await mkdir(projectDir);
    const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") };
    const runtime = openRuntime(environment);
    const project = await runtime.projects.resolve(projectDir, "persist");
    const root = await runtime.taskTrees.createTaskRoot({ projectId: project.projectId, title: "Repair endpoint" });
    const rootNodeId = root.document.nodes[0]!.id;
    const document: TaskTreeDocument = {
      nodes: [
        { id: rootNodeId, parentId: null, title: "Repair endpoint", children: ["endpoint-repair"] },
        {
          id: "endpoint-repair", parentId: rootNodeId, title: "Repair endpoint contract", children: [],
          objectives: ["Repair endpoint contract"], expectedOutputs: ["src/endpoint.ts"],
          acceptanceCriteria: ["focused endpoint test passes"], unresolvedQuestions: [], unresolvedDecisions: [],
          dependencies: [], requiredEvidence: [{ key: "endpoint-test", description: "focused endpoint test" }],
          executionPhase: "skeleton", stopDecompositionReason: "one independently verifiable repair",
        },
      ],
      relations: [], artifacts: [],
    };
    const revision = runtime.taskTrees.saveDraftRevision({
      projectId: project.projectId, treeId: root.treeId, baseRevisionId: root.revisionId, document,
    });
    const readiness = runtime.taskTrees.scanPlanReadiness({ projectId: project.projectId, treeId: root.treeId });
    const workflowRevision = runtime.database.get<{ revision: number }>(
      "SELECT revision FROM workflow_states WHERE project_id = ? AND tree_id = ? AND active = 1",
      project.projectId, root.treeId,
    )!.revision;
    const prompt = runtime.workflows.createConfirmationPrompt({
      projectId: project.projectId, treeId: root.treeId, scopeId: root.treeId,
      readinessResultId: readiness.resultId, prompt: "Execute repair?", workflowRevision,
    });
    const answer = await runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "confirm", cwd: projectDir, prompt: "yes",
    }));
    if (!answer.recorded) throw new Error("confirmation Trace was not recorded");
    runtime.workflows.confirmScope({
      projectId: project.projectId, confirmationId: prompt.confirmationId, answer: "yes",
      answerTraceEventId: answer.eventId, workflowRevision,
    });

    for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
      const attempt = runtime.executions.startAttempt({
        projectId: project.projectId, nodeId: "endpoint-repair", expectedTreeRevisionId: revision.revisionId,
      });
      const succeeded = attemptNumber === 3;
      const trace = await runtime.hooks.ingest(mapClaudeHook({
        hook_event_name: "PostToolUse", session_id: `attempt-${attemptNumber}`, cwd: projectDir,
        tool_name: "Bash", tool_use_id: `endpoint-${attemptNumber}`,
        tool_input: { command: "npm test -- endpoint.test.ts" },
        tool_response: succeeded ? { exitCode: 0 } : { exitCode: 1, stderr: "AssertionError: endpoint" },
      }));
      if (!trace.recorded) throw new Error("attempt Trace was not recorded");
      runtime.executions.attachEvidence({
        projectId: project.projectId, attemptId: attempt.attemptId,
        requiredEvidenceKey: "endpoint-test", traceEventId: trace.eventId,
      });
      runtime.executions.beginVerification({ projectId: project.projectId, attemptId: attempt.attemptId, expectedStatus: "running" });
      runtime.evaluations.evaluateAttempt({
        projectId: project.projectId, attemptId: attempt.attemptId,
        proposedVerdict: succeeded ? "succeeded" : "failed", riskSummary: succeeded ? null : "endpoint assertion",
      });
    }

    const experience = runtime.queries.getSkillEvolutionCandidates(project.projectId, { treeId: root.treeId }).items[0]!;
    expect(experience.failureAttemptIds).toHaveLength(2);
    const candidate = runtime.evolution.freezeSkillCandidate({
      projectId: project.projectId, experienceId: experience.experienceId,
      stableKey: "endpoint-contract-repair", name: "Endpoint contract repair",
      triggerContext: { taskType: "typescript-test-failure" },
      instructionSnapshot: "Reproduce the focused failure, isolate its contract, then verify the smallest repair.",
    });
    const testTypes = ["real_failure_replay", "variation", "holdout", "negative_applicability"] as const;
    const cases = [];
    for (const [caseIndex, testType] of testTypes.entries()) {
      const testCase = runtime.evolution.proposeSkillTestCase({
        projectId: project.projectId, candidateRevisionId: candidate.candidateRevisionId, testType,
        sourceRefs: [`scenario:${testType}`], targetBehavior: `validate ${testType}`,
        applicableContext: { language: "typescript" }, fixtureSetup: { isolated: true }, input: { caseIndex },
        expectedResult: { pass: true }, oracle: { kind: "exit_code", value: 0 },
        reproductionCommand: `npm test -- ${testType}`, timeoutMs: 30_000,
        generatedBy: testType === "holdout" ? "independent-author" : "agent",
        leakagePolicy: testType === "holdout" ? "candidate instructions unavailable" : "source facts only",
      });
      const qualityTrace = await runtime.hooks.ingest(mapClaudeHook({
        hook_event_name: "PostToolUse", session_id: `quality-${caseIndex}`, cwd: projectDir,
        tool_name: "Bash", tool_use_id: `quality-${caseIndex}`,
        tool_input: { command: `validate fixture ${testType}` }, tool_response: { exitCode: 0 },
      }));
      if (!qualityTrace.recorded) throw new Error("quality Trace was not recorded");
      runtime.evolution.validateSkillTestQuality({
        projectId: project.projectId, skillTestCaseId: testCase.testCaseId, idempotencyKey: `quality-${caseIndex}`,
        schemaValid: true, fixtureIsolated: true, failureReproduced: true, oracleValid: true,
        discriminative: true, stable: true, splitValid: true, evidenceRefs: [qualityTrace.eventId],
      });
      cases.push(testCase);
    }

    for (const [caseIndex, testCase] of cases.entries()) {
      for (const runMode of ["no_skill_baseline", "skill_enabled"] as const) {
        for (let repetitionIndex = 1; repetitionIndex <= 3; repetitionIndex += 1) {
          const runTrace = await runtime.hooks.ingest(mapClaudeHook({
            hook_event_name: "PostToolUse", session_id: `run-${caseIndex}-${runMode}-${repetitionIndex}`, cwd: projectDir,
            tool_name: "Bash", tool_use_id: `run-${caseIndex}-${runMode}-${repetitionIndex}`,
            tool_input: { command: `run ${testCase.testType} ${runMode}` }, tool_response: { exitCode: 0 },
          }));
          if (!runTrace.recorded) throw new Error("run Trace was not recorded");
          runtime.evolution.recordSkillValidationRun({
            projectId: project.projectId, candidateRevisionId: candidate.candidateRevisionId,
            skillTestCaseId: testCase.testCaseId, runMode, repetitionIndex,
            verdict: runMode === "no_skill_baseline" && testCase.testType === "real_failure_replay" ? "failed" : "passed",
            tokenUsage: runMode === "skill_enabled" ? 100 : 80, toolCallCount: 4,
            sideEffectRisk: "none", sideEffectSummary: "isolated fixture", evidenceRefs: [runTrace.eventId],
          });
        }
      }
    }
    const report = runtime.evolution.generateSkillValidationReport({
      projectId: project.projectId, candidateRevisionId: candidate.candidateRevisionId, idempotencyKey: "promotion-report",
    });
    expect(report).toMatchObject({ verdict: "pass", promoted: true });
    runtime.close();

    const reopened = openRuntime(environment);
    try {
      const detail = reopened.queries.getSkillCandidateDetail(project.projectId, candidate.candidateRevisionId);
      expect(detail.skill).toMatchObject({ stableKey: "endpoint-contract-repair", validationStatus: "promoted" });
      expect(detail.candidate).toMatchObject({ validationStatus: "promoted", sourceExperienceIds: [experience.experienceId] });
      expect(detail.testCases).toHaveLength(4);
      expect(detail.validationRuns).toHaveLength(24);
      expect(detail.reports).toEqual([expect.objectContaining({ verdict: "pass", rejectionReasons: [] })]);
    } finally {
      reopened.close();
    }
  });
});
