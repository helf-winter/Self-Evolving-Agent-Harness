import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

const document = {
  planningVersion: 1 as const,
  planningContext: {
    goal: "Build API", scopeBoundaries: ["API only"], exclusions: ["No UI"],
    unresolvedQuestions: [], unresolvedDecisions: [], plannedEffects: [],
  },
  nodes: [
    { id: "root", parentId: null, title: "Build API", children: ["api"] },
    { id: "api", parentId: "root", title: "API", children: ["api-skeleton", "api-implementation"] },
    {
      id: "api-skeleton", parentId: "api", title: "Wire API", children: [], objectives: ["Wire API skeleton"],
      expectedOutputs: ["src/api.ts"], acceptanceCriteria: ["API compiles"], unresolvedQuestions: [], unresolvedDecisions: [],
      dependencies: [], requiredEvidence: [{ key: "contract-check", description: "contract compiles" }],
      executionPhase: "skeleton" as const, stopDecompositionReason: "one verifiable skeleton",
    },
    {
      id: "api-implementation", parentId: "api", title: "Implement API", children: [], objectives: ["Implement API behavior"],
      expectedOutputs: ["src/api.ts"], acceptanceCriteria: ["API tests pass"], unresolvedQuestions: [], unresolvedDecisions: [],
      dependencies: ["api-skeleton"], requiredEvidence: [{ key: "api-test", description: "API tests pass" }],
      executionPhase: "implementation" as const, stopDecompositionReason: "one independently testable branch",
    },
  ],
  relations: [{ fromNodeId: "api-implementation", toNodeId: "api-skeleton", kind: "depends_on" as const }],
  artifacts: [
    { id: "api-file", kind: "file" as const, locator: "src/api.ts" },
    { id: "api-contract-artifact", kind: "contract" as const, locator: "contract:api", granularity: "contract" as const },
  ],
  artifactLinks: [
    { taskNodeId: "api-skeleton", artifactId: "api-file", relationType: "creates" as const },
    { taskNodeId: "api-skeleton", artifactId: "api-contract-artifact", relationType: "implements" as const },
    { taskNodeId: "api-implementation", artifactId: "api-contract-artifact", relationType: "consumes" as const },
  ],
  artifactContracts: [{
    id: "api-contract", artifactId: "api-contract-artifact", name: "API Contract", version: "1",
    compatibilityPolicy: "exact" as const, schemaOrSignature: "GET /api -> 200",
    providerNodeIds: ["api-skeleton"], consumerNodeIds: ["api-implementation"], validationRefs: ["contract-check"],
  }],
  skeletonCriteria: [{
    id: "api-skeleton-ready", branchNodeId: "api", expectedArtifacts: ["src/api.ts"],
    requiredContracts: ["api-contract"], verificationCommands: ["npm run build"], readinessConditions: ["API is wired"],
  }],
};

async function confirmedFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-skeleton-gate-")); dirs.push(directory);
  const projectDir = path.join(directory, "project"); await mkdir(projectDir);
  const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") };
  const runtime = openRuntime(environment);
  const project = await runtime.projects.resolve(projectDir, "persist");
  const root = await runtime.taskTrees.createTaskRoot({ projectId: project.projectId, title: "Build API" });
  const revision = runtime.taskTrees.saveDraftRevision({
    projectId: project.projectId, treeId: root.treeId, baseRevisionId: root.revisionId, document,
  });
  const readiness = runtime.taskTrees.scanPlanReadiness({ projectId: project.projectId, treeId: root.treeId });
  expect(readiness.ready).toBe(true);
  const prompt = runtime.workflows.createConfirmationPrompt({
    projectId: project.projectId, treeId: root.treeId, scopeId: root.treeId,
    readinessResultId: readiness.resultId, prompt: "Execute?", workflowRevision: 3,
  });
  const answer = await runtime.hooks.ingest(mapClaudeHook({
    hook_event_name: "UserPromptSubmit", session_id: "gate-run", cwd: projectDir, prompt: "yes",
  }));
  if (!answer.recorded) throw new Error("answer was not recorded");
  runtime.workflows.confirmScope({
    projectId: project.projectId, confirmationId: prompt.confirmationId, answer: "yes",
    answerTraceEventId: answer.eventId, workflowRevision: 3,
  });
  return { directory, projectDir, environment, runtime, project, root, revision };
}

describe("SkeletonGateService", () => {
  it("persists blockers, remains executable, then advances only after every planned fact exists", async () => {
    const fixture = await confirmedFixture();
    const first = fixture.runtime.skeletonGates.evaluate({
      projectId: fixture.project.projectId, treeId: fixture.root.treeId, workflowRevision: 4,
    });
    expect(first).toMatchObject({
      status: "failed", workflow: { stage: "skeleton_pass", revision: 4 },
      blockers: expect.arrayContaining([
        { code: "skeleton_attempt_incomplete", ref: "api" },
        { code: "expected_artifact_missing", ref: "src/api.ts" },
      ]),
    });

    const attempt = fixture.runtime.executions.startAttempt({
      projectId: fixture.project.projectId, nodeId: "api-skeleton", expectedTreeRevisionId: fixture.revision.revisionId,
    });
    const write = await fixture.runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "gate-run", cwd: fixture.projectDir, tool_name: "Write", tool_use_id: "write-api",
      tool_input: { file_path: "src/api.ts", content: "export const api = true" }, tool_response: { ok: true },
    }));
    const build = await fixture.runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "gate-run", cwd: fixture.projectDir, tool_name: "Bash", tool_use_id: "build-api",
      tool_input: { command: "npm run build" }, tool_response: { exitCode: 0 },
    }));
    if (!write.recorded || !build.recorded) throw new Error("Skeleton traces were not recorded");
    fixture.runtime.executions.attachEvidence({
      projectId: fixture.project.projectId, attemptId: attempt.attemptId,
      requiredEvidenceKey: "contract-check", traceEventId: build.eventId,
    });
    fixture.runtime.executions.beginVerification({ projectId: fixture.project.projectId, attemptId: attempt.attemptId, expectedStatus: "running" });
    fixture.runtime.evaluations.evaluateAttempt({
      projectId: fixture.project.projectId, attemptId: attempt.attemptId, proposedVerdict: "succeeded", riskSummary: null,
    });
    const passed = fixture.runtime.skeletonGates.evaluate({
      projectId: fixture.project.projectId, treeId: fixture.root.treeId, workflowRevision: 4,
    });
    expect(passed).toMatchObject({
      status: "passed", blockers: [], workflow: { stage: "branch_implementation", revision: 5 },
      attemptIds: [attempt.attemptId], evidenceTraceIds: expect.arrayContaining([write.eventId, build.eventId]),
    });
    expect(fixture.runtime.queries.getRuntimeSnapshot(fixture.project.projectId)).toMatchObject({
      workflow: { stage: "branch_implementation", revision: 5 },
      latestSkeletonGate: { resultId: passed.resultId, status: "passed", blockerCount: 0 },
    });
    fixture.runtime.close();

    const reopened = openRuntime(fixture.environment);
    expect(reopened.skeletonGates.list(fixture.project.projectId, { treeId: fixture.root.treeId }))
      .toEqual([expect.objectContaining({ resultId: passed.resultId, status: "passed" }), expect.objectContaining({ resultId: first.resultId, status: "failed" })]);
    reopened.close();
  });

  it("blocks unresolved drift and isolates result history by Project", async () => {
    const fixture = await confirmedFixture();
    fixture.runtime.drifts.recordDrift({
      projectId: fixture.project.projectId, treeId: fixture.root.treeId, nodeId: "api-skeleton",
      driftType: "relation_changed", severity: "blocking", description: "Contract wiring drifted",
      explanation: "Observed wiring differs from the confirmed plan", recommendation: "Resolve the contract before implementation",
    });
    const result = fixture.runtime.skeletonGates.evaluate({
      projectId: fixture.project.projectId, treeId: fixture.root.treeId, workflowRevision: 4,
    });
    expect(result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "blocking_drift" })]));
    const otherDir = path.join(fixture.directory, "other"); await mkdir(otherDir);
    const other = await fixture.runtime.projects.resolve(otherDir, "persist");
    expect(fixture.runtime.skeletonGates.list(other.projectId)).toEqual([]);
    fixture.runtime.close();
  });
});

