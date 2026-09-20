import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvolutionService } from "../../src/application/evolution-service.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-evolution-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/p1', 'now', 'now')");
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p2', '/p2', 'now', 'now')");
  database.run("INSERT INTO task_trees (id, project_id, title, status, current_revision_id, created_at, updated_at) VALUES ('t1', 'p1', 'Tree', 'confirmed', 'tr1', 'now', 'now')");
  database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES ('tr1', 't1', 1, '{}', 'now')");
  database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES ('n1', 't1', NULL, 'Repair endpoint', 'succeeded')");
  database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES ('nr1', 'n1', 'tr1', '{\"objectives\":[\"Repair endpoint\"],\"executionPhase\":\"implementation\"}', 'now')");
  return { database, service: new EvolutionService(database) };
}

function addEvaluation(database: RuntimeDatabase, sequence: number, verdict: "failed" | "succeeded", applied = 1) {
  const attemptId = `a${sequence}`;
  const evaluationId = `e${sequence}`;
  database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at, completed_at) VALUES (?, 'p1', 't1', 'n1', 'nr1', ?, ?, ?, ?)", attemptId, sequence, verdict, `2026-01-0${sequence}`, `2026-01-0${sequence}`);
  database.run("INSERT INTO evaluations (id, project_id, tree_id, task_node_id, task_node_revision_id, execution_attempt_id, verdict, evidence_refs_json, covered_required_evidence_json, missing_required_evidence_json, risk_summary, created_at) VALUES (?, 'p1', 't1', 'n1', 'nr1', ?, ?, ?, '[]', '[]', '', ?)", evaluationId, attemptId, verdict, JSON.stringify([`trace-${sequence}`]), `2026-01-0${sequence}`);
  database.run("INSERT INTO lifecycle_transition_records (id, evaluation_id, task_node_id, policy_version, from_status, target_status, applied, rejection_code, created_at) VALUES (?, ?, 'n1', 'v1', 'verifying', ?, ?, NULL, ?)", `lt${sequence}`, evaluationId, verdict, applied, `2026-01-0${sequence}`);
  return { attemptId, evaluationId };
}

function addTrace(database: RuntimeDatabase, id: string, projectId = "p1", occurredAt = "2099-01-01T00:00:00.000Z") {
  database.run(
    "INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES (?, ?, ?, ?, 'validation', 'PostToolUse', '{}', ?, ?)",
    id, projectId, projectId === "p1" ? "t1" : null, projectId === "p1" ? "n1" : null, occurredAt, id,
  );
}

function eligibleCandidate(database: RuntimeDatabase, service: EvolutionService) {
  addEvaluation(database, 1, "failed"); addEvaluation(database, 2, "failed");
  const success = addEvaluation(database, 3, "succeeded");
  const experience = service.captureEligibleExperienceWithinTransaction({ projectId: "p1", successEvaluationId: success.evaluationId });
  if (!experience.eligible) throw new Error("experience was not eligible");
  return service.freezeSkillCandidate({
    projectId: "p1", experienceId: experience.experienceId, stableKey: "endpoint-repair",
    name: "Endpoint repair", triggerContext: { taskType: "typescript-test-failure" },
    instructionSnapshot: "Reproduce the focused failure before changing implementation.",
  });
}

afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("EvolutionService Experience and candidate lifecycle", () => {
  it("creates one eligible Experience only after two applied failures and a success", async () => {
    const { database, service } = await fixture();
    addEvaluation(database, 1, "failed");
    const premature = addEvaluation(database, 2, "succeeded");
    expect(service.captureEligibleExperienceWithinTransaction({ projectId: "p1", successEvaluationId: premature.evaluationId }))
      .toMatchObject({ eligible: false, reason: "insufficient_failures" });
    database.run("DELETE FROM lifecycle_transition_records WHERE evaluation_id = 'e2'");
    database.run("DELETE FROM evaluations WHERE id = 'e2'");
    database.run("DELETE FROM execution_attempts WHERE id = 'a2'");
    addEvaluation(database, 2, "failed");
    const success = addEvaluation(database, 3, "succeeded");
    const captured = service.captureEligibleExperienceWithinTransaction({ projectId: "p1", successEvaluationId: success.evaluationId });
    expect(captured).toMatchObject({ eligible: true, created: true, failureEvaluationIds: ["e1", "e2"], successEvaluationId: "e3" });
    expect(service.captureEligibleExperienceWithinTransaction({ projectId: "p1", successEvaluationId: success.evaluationId }))
      .toMatchObject({ eligible: true, created: false, experienceId: captured.eligible ? captured.experienceId : "missing" });
    expect(database.all("SELECT id FROM experiences")).toHaveLength(1);
    database.close();
  });

  it("freezes immutable candidate revisions and reuses exact proposals", async () => {
    const { database, service } = await fixture();
    addEvaluation(database, 1, "failed"); addEvaluation(database, 2, "failed");
    const success = addEvaluation(database, 3, "succeeded");
    const experience = service.captureEligibleExperienceWithinTransaction({ projectId: "p1", successEvaluationId: success.evaluationId });
    if (!experience.eligible) throw new Error("experience was not eligible");
    const first = service.freezeSkillCandidate({
      projectId: "p1", experienceId: experience.experienceId, stableKey: "endpoint-repair",
      name: "Endpoint repair", triggerContext: { taskType: "typescript-test-failure" },
      instructionSnapshot: "Reproduce the focused failure before changing implementation.",
    });
    expect(first).toMatchObject({ revisionNumber: 1, validationStatus: "frozen", created: true });
    expect(service.freezeSkillCandidate({
      projectId: "p1", experienceId: experience.experienceId, stableKey: "endpoint-repair",
      name: "Endpoint repair", triggerContext: { taskType: "typescript-test-failure" },
      instructionSnapshot: "Reproduce the focused failure before changing implementation.",
    })).toMatchObject({ candidateRevisionId: first.candidateRevisionId, created: false });
    const second = service.freezeSkillCandidate({
      projectId: "p1", experienceId: experience.experienceId, stableKey: "endpoint-repair",
      name: "Endpoint repair", triggerContext: { taskType: "typescript-test-failure" },
      instructionSnapshot: "Reproduce the failure, isolate the cause, then verify the focused fix.",
    });
    expect(second.revisionNumber).toBe(2);
    expect(database.get<{ instruction_snapshot: string }>("SELECT instruction_snapshot FROM skill_candidate_revisions WHERE id = ?", first.candidateRevisionId))
      .toEqual({ instruction_snapshot: "Reproduce the focused failure before changing implementation." });
    expect(() => service.freezeSkillCandidate({
      projectId: "p2", experienceId: experience.experienceId, stableKey: "foreign",
      name: "Foreign", triggerContext: {}, instructionSnapshot: "Do work",
    })).toThrow(expect.objectContaining({ code: "not_found" }));
    database.close();
  });

  it("keeps generated test definitions draft until evidence passes every quality gate", async () => {
    const { database, service } = await fixture();
    const candidate = eligibleCandidate(database, service);
    const testCase = service.proposeSkillTestCase({
      projectId: "p1", candidateRevisionId: candidate.candidateRevisionId,
      testType: "real_failure_replay", sourceRefs: ["failure-case-1"],
      targetBehavior: "repairs the original deterministic failure", applicableContext: { language: "typescript" },
      fixtureSetup: { repository: "fixture" }, input: { command: "npm test" },
      expectedResult: { exitCode: 0 }, oracle: { kind: "exit_code", value: 0 },
      reproductionCommand: "npm test -- endpoint", timeoutMs: 30_000,
      generatedBy: "agent", leakagePolicy: "candidate instructions excluded from holdout authoring",
    });
    expect(testCase).toMatchObject({ testType: "real_failure_replay", qualityStatus: "draft", created: true });
    expect(service.proposeSkillTestCase({
      projectId: "p1", candidateRevisionId: candidate.candidateRevisionId,
      testType: "real_failure_replay", sourceRefs: ["failure-case-1"],
      targetBehavior: "repairs the original deterministic failure", applicableContext: { language: "typescript" },
      fixtureSetup: { repository: "fixture" }, input: { command: "npm test" },
      expectedResult: { exitCode: 0 }, oracle: { kind: "exit_code", value: 0 },
      reproductionCommand: "npm test -- endpoint", timeoutMs: 30_000,
      generatedBy: "agent", leakagePolicy: "candidate instructions excluded from holdout authoring",
    })).toMatchObject({ testCaseId: testCase.testCaseId, created: false });

    addTrace(database, "quality-evidence");
    const accepted = service.validateSkillTestQuality({
      projectId: "p1", skillTestCaseId: testCase.testCaseId, idempotencyKey: "quality-1",
      schemaValid: true, fixtureIsolated: true, failureReproduced: true, oracleValid: true,
      discriminative: true, stable: true, splitValid: true, evidenceRefs: ["quality-evidence"],
    });
    expect(accepted).toMatchObject({ verdict: "accepted", qualityStatus: "accepted", created: true });
    expect(service.validateSkillTestQuality({
      projectId: "p1", skillTestCaseId: testCase.testCaseId, idempotencyKey: "quality-1",
      schemaValid: true, fixtureIsolated: true, failureReproduced: true, oracleValid: true,
      discriminative: true, stable: true, splitValid: true, evidenceRefs: ["quality-evidence"],
    })).toMatchObject({ qualityResultId: accepted.qualityResultId, created: false });
    database.close();
  });

  it("rejects foreign or early quality evidence and records validation runs only for accepted cases", async () => {
    const { database, service } = await fixture();
    const candidate = eligibleCandidate(database, service);
    const testCase = service.proposeSkillTestCase({
      projectId: "p1", candidateRevisionId: candidate.candidateRevisionId,
      testType: "holdout", sourceRefs: ["independent-scenario"], targetBehavior: "generalizes",
      applicableContext: {}, fixtureSetup: {}, input: {}, expectedResult: { pass: true },
      oracle: { kind: "predicate" }, reproductionCommand: "npm test -- holdout", timeoutMs: 30_000,
      generatedBy: "independent-agent", leakagePolicy: "no candidate instruction access",
    });
    addTrace(database, "early", "p1", "2000-01-01T00:00:00.000Z");
    addTrace(database, "foreign", "p2");
    expect(() => service.validateSkillTestQuality({
      projectId: "p1", skillTestCaseId: testCase.testCaseId, idempotencyKey: "bad-quality",
      schemaValid: true, fixtureIsolated: true, failureReproduced: true, oracleValid: true,
      discriminative: true, stable: true, splitValid: true, evidenceRefs: ["early", "foreign"],
    })).toThrow(expect.objectContaining({ code: "evidence_scope_mismatch" }));
    expect(() => service.recordSkillValidationRun({
      projectId: "p1", candidateRevisionId: candidate.candidateRevisionId, skillTestCaseId: testCase.testCaseId,
      runMode: "skill_enabled", repetitionIndex: 1, verdict: "passed", tokenUsage: 20, toolCallCount: 2,
      sideEffectRisk: "none", sideEffectSummary: "isolated fixture", evidenceRefs: ["early"],
    })).toThrow(expect.objectContaining({ code: "skill_test_invalid" }));

    addTrace(database, "quality-ok"); addTrace(database, "run-ok");
    service.validateSkillTestQuality({
      projectId: "p1", skillTestCaseId: testCase.testCaseId, idempotencyKey: "quality-ok",
      schemaValid: true, fixtureIsolated: true, failureReproduced: true, oracleValid: true,
      discriminative: true, stable: true, splitValid: true, evidenceRefs: ["quality-ok"],
    });
    const run = service.recordSkillValidationRun({
      projectId: "p1", candidateRevisionId: candidate.candidateRevisionId, skillTestCaseId: testCase.testCaseId,
      runMode: "skill_enabled", repetitionIndex: 1, verdict: "passed", tokenUsage: 20, toolCallCount: 2,
      sideEffectRisk: "none", sideEffectSummary: "isolated fixture", evidenceRefs: ["run-ok"],
    });
    expect(run).toMatchObject({ created: true, repetitionIndex: 1, verdict: "passed" });
    expect(service.recordSkillValidationRun({
      projectId: "p1", candidateRevisionId: candidate.candidateRevisionId, skillTestCaseId: testCase.testCaseId,
      runMode: "skill_enabled", repetitionIndex: 1, verdict: "passed", tokenUsage: 20, toolCallCount: 2,
      sideEffectRisk: "none", sideEffectSummary: "isolated fixture", evidenceRefs: ["run-ok"],
    })).toMatchObject({ validationRunId: run.validationRunId, created: false });
    expect(() => service.recordSkillValidationRun({
      projectId: "p1", candidateRevisionId: candidate.candidateRevisionId, skillTestCaseId: testCase.testCaseId,
      runMode: "skill_enabled", repetitionIndex: 1, verdict: "failed", tokenUsage: 20, toolCallCount: 2,
      sideEffectRisk: "none", sideEffectSummary: "different outcome", evidenceRefs: ["run-ok"],
    })).toThrow(expect.objectContaining({ code: "skill_validation_rejected" }));
    database.close();
  });

  it("builds a deterministic report and automatically promotes only a fully validated candidate", async () => {
    const { database, service } = await fixture();
    const candidate = eligibleCandidate(database, service);
    const testTypes = ["real_failure_replay", "variation", "holdout", "negative_applicability"] as const;
    const cases = [];
    for (const [caseIndex, testType] of testTypes.entries()) {
      const testCase = service.proposeSkillTestCase({
        projectId: "p1", candidateRevisionId: candidate.candidateRevisionId, testType,
        sourceRefs: [`source-${testType}`], targetBehavior: `validates ${testType}`,
        applicableContext: { testType }, fixtureSetup: { isolated: true }, input: { caseIndex },
        expectedResult: { pass: true }, oracle: { kind: "predicate" },
        reproductionCommand: `npm test -- ${testType}`, timeoutMs: 30_000,
        generatedBy: testType === "holdout" ? "independent-agent" : "agent",
        leakagePolicy: testType === "holdout" ? "no candidate instruction access" : "source-derived only",
      });
      addTrace(database, `quality-${caseIndex}`);
      service.validateSkillTestQuality({
        projectId: "p1", skillTestCaseId: testCase.testCaseId, idempotencyKey: `quality-${caseIndex}`,
        schemaValid: true, fixtureIsolated: true, failureReproduced: true, oracleValid: true,
        discriminative: true, stable: true, splitValid: true, evidenceRefs: [`quality-${caseIndex}`],
      });
      cases.push(testCase);
    }
    for (const [caseIndex, testCase] of cases.entries()) {
      for (const runMode of ["no_skill_baseline", "skill_enabled"] as const) {
        for (let repetitionIndex = 1; repetitionIndex <= 3; repetitionIndex += 1) {
          const traceId = `run-${caseIndex}-${runMode}-${repetitionIndex}`;
          addTrace(database, traceId);
          service.recordSkillValidationRun({
            projectId: "p1", candidateRevisionId: candidate.candidateRevisionId,
            skillTestCaseId: testCase.testCaseId, runMode, repetitionIndex,
            verdict: runMode === "no_skill_baseline" && testCase.testType === "real_failure_replay" ? "failed" : "passed",
            tokenUsage: runMode === "skill_enabled" ? 100 : 80, toolCallCount: 4,
            sideEffectRisk: "none", sideEffectSummary: "isolated fixture", evidenceRefs: [traceId],
          });
        }
      }
    }
    const report = service.generateSkillValidationReport({
      projectId: "p1", candidateRevisionId: candidate.candidateRevisionId, idempotencyKey: "report-1",
    });
    expect(report).toMatchObject({ verdict: "pass", rejectionReasons: [], promoted: true, created: true });
    expect(report.evidenceRefs).toHaveLength(24);
    expect(service.generateSkillValidationReport({
      projectId: "p1", candidateRevisionId: candidate.candidateRevisionId, idempotencyKey: "report-1",
    })).toMatchObject({ reportId: report.reportId, verdict: "pass", promoted: true, created: false });
    expect(database.get<{ validation_status: string }>("SELECT validation_status FROM skills WHERE id = ?", candidate.skillId))
      .toEqual({ validation_status: "promoted" });
    expect(database.get<{ validation_status: string }>("SELECT validation_status FROM skill_candidate_revisions WHERE id = ?", candidate.candidateRevisionId))
      .toEqual({ validation_status: "promoted" });
    database.close();
  });
});
