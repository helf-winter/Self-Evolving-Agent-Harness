import { HarnessError } from "../domain/errors.js";
import {
  evaluateExperienceEligibility,
  type EvolutionEvaluationFact,
  type SkillSideEffectRisk,
  type SkillTestType,
  type SkillValidationRunMode,
  type SkillValidationRunVerdict,
} from "../domain/evolution.js";
import { newId, nowIso } from "../domain/ids.js";
import type { TaskNodeInput } from "../domain/task-tree.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";

export type ExperienceCaptureView = {
  eligible: false;
  reason: "no_applied_success" | "insufficient_failures";
} | {
  eligible: true;
  experienceId: string;
  created: boolean;
  projectId: string;
  treeId: string;
  nodeId: string;
  nodeRevisionId: string;
  successEvaluationId: string;
  successAttemptId: string;
  failureEvaluationIds: string[];
  failureAttemptIds: string[];
};

export interface SkillCandidateView {
  skillId: string;
  candidateRevisionId: string;
  stableKey: string;
  revisionNumber: number;
  validationStatus: "frozen";
  created: boolean;
  frozenAt: string;
}

export interface SkillTestCaseView {
  testCaseId: string;
  candidateRevisionId: string;
  testType: SkillTestType;
  qualityStatus: "draft" | "accepted" | "rejected";
  created: boolean;
  createdAt: string;
}

export interface SkillTestQualityView {
  qualityResultId: string;
  skillTestCaseId: string;
  verdict: "accepted" | "rejected";
  qualityStatus: "accepted" | "rejected";
  created: boolean;
  createdAt: string;
}

export interface SkillValidationRunView {
  validationRunId: string;
  skillTestCaseId: string;
  runMode: SkillValidationRunMode;
  repetitionIndex: number;
  verdict: SkillValidationRunVerdict;
  created: boolean;
  createdAt: string;
}

export class EvolutionService {
  constructor(private readonly database: RuntimeDatabase) {}

  captureEligibleExperienceWithinTransaction(input: {
    projectId: string;
    successEvaluationId: string;
  }): ExperienceCaptureView {
    const success = this.database.get<{
      evaluation_id: string; project_id: string; tree_id: string; task_node_id: string;
      task_node_revision_id: string; execution_attempt_id: string; verdict: string;
      evidence_refs_json: string; task_title: string; body_json: string;
      applied: number; target_status: string;
    }>(`
      SELECT e.id AS evaluation_id, e.project_id, e.tree_id, e.task_node_id,
             e.task_node_revision_id, e.execution_attempt_id, e.verdict, e.evidence_refs_json,
             n.title AS task_title, nr.body_json, l.applied, l.target_status
      FROM evaluations e
      JOIN task_nodes n ON n.id = e.task_node_id
      JOIN task_node_revisions nr ON nr.id = e.task_node_revision_id
      JOIN lifecycle_transition_records l ON l.evaluation_id = e.id
      WHERE e.id = ? AND e.project_id = ?
    `, input.successEvaluationId, input.projectId);
    if (!success) throw new HarnessError("not_found", "successful Evaluation was not found in this Project");
    if (success.verdict !== "succeeded" || success.applied !== 1 || success.target_status !== "succeeded") {
      throw new HarnessError("evolution_not_eligible", "Experience requires an applied succeeded Evaluation");
    }
    const facts = this.database.all<{
      evaluation_id: string; execution_attempt_id: string; task_node_revision_id: string;
      verdict: EvolutionEvaluationFact["verdict"]; applied: number; created_at: string; attempt_number: number;
    }>(`
      SELECT e.id AS evaluation_id, e.execution_attempt_id, e.task_node_revision_id,
             e.verdict, l.applied, e.created_at, a.attempt_number
      FROM evaluations e
      JOIN lifecycle_transition_records l ON l.evaluation_id = e.id
      JOIN execution_attempts a ON a.id = e.execution_attempt_id
      WHERE e.project_id = ? AND e.task_node_id = ? AND e.task_node_revision_id = ?
        AND a.attempt_number <= (SELECT attempt_number FROM execution_attempts WHERE id = ?)
      ORDER BY a.attempt_number, e.created_at, e.id
    `, input.projectId, success.task_node_id, success.task_node_revision_id, success.execution_attempt_id)
      .map((row) => ({
        evaluationId: row.evaluation_id,
        attemptId: row.execution_attempt_id,
        nodeRevisionId: row.task_node_revision_id,
        verdict: row.verdict,
        applied: row.applied === 1,
        occurredAt: `${String(row.attempt_number).padStart(12, "0")}:${row.created_at}`,
      }));
    const eligibility = evaluateExperienceEligibility(facts);
    if (!eligibility.eligible) return eligibility;
    const existing = this.database.get<{ id: string }>(
      "SELECT id FROM experiences WHERE source_success_evaluation_id = ? AND source_project_id = ?",
      input.successEvaluationId, input.projectId,
    );
    if (existing) return { ...eligibility, experienceId: existing.id, created: false, projectId: input.projectId, treeId: success.tree_id, nodeId: success.task_node_id };

    const relatedArtifactIds = this.database.all<{ artifact_id: string }>(`
      SELECT DISTINCT artifact_id FROM task_node_artifact_links
      WHERE project_id = ? AND task_node_revision_id = ? ORDER BY artifact_id
    `, input.projectId, success.task_node_revision_id).map((row) => row.artifact_id);
    const body = JSON.parse(success.body_json) as TaskNodeInput;
    const experienceId = newId();
    const createdAt = nowIso();
    this.database.run(`
      INSERT INTO experiences (
        id, source_project_id, source_tree_id, source_task_node_id, source_task_node_revision_id,
        source_success_attempt_id, source_success_evaluation_id, source_failure_attempt_ids_json,
        source_failure_evaluation_ids_json, summary, applicable_context_json, verification_json,
        related_artifact_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, experienceId, input.projectId, success.tree_id, success.task_node_id, success.task_node_revision_id,
    eligibility.successAttemptId, eligibility.successEvaluationId,
    canonicalJson(eligibility.failureAttemptIds), canonicalJson(eligibility.failureEvaluationIds),
    `Recovered ${success.task_title} after ${eligibility.failureAttemptIds.length} failed attempts`,
    canonicalJson({ taskTitle: success.task_title, objectives: body.objectives ?? [], executionPhase: body.executionPhase ?? null }),
    canonicalJson({ successEvidenceRefs: JSON.parse(success.evidence_refs_json) as string[], successEvaluationId: success.evaluation_id }),
    canonicalJson(relatedArtifactIds), createdAt);
    return {
      ...eligibility,
      experienceId,
      created: true,
      projectId: input.projectId,
      treeId: success.tree_id,
      nodeId: success.task_node_id,
    };
  }

  freezeSkillCandidate(input: {
    projectId: string;
    experienceId: string;
    stableKey: string;
    name: string;
    triggerContext: Record<string, unknown>;
    instructionSnapshot: string;
  }): SkillCandidateView {
    const stableKey = input.stableKey.trim();
    const name = input.name.trim();
    const instruction = input.instructionSnapshot.trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(stableKey) || !name || !instruction) {
      throw new HarnessError("skill_candidate_invalid", "Skill candidate requires a kebab-case stable key, name, and instruction snapshot");
    }
    const triggerContextJson = canonicalJson(input.triggerContext);
    return this.database.transaction(() => {
      const experience = this.database.get<{ id: string }>(
        "SELECT id FROM experiences WHERE id = ? AND source_project_id = ?", input.experienceId, input.projectId,
      );
      if (!experience) throw new HarnessError("not_found", "Experience was not found in this Project");
      let skill = this.database.get<{ id: string; name: string; trigger_context_json: string }>(
        "SELECT id, name, trigger_context_json FROM skills WHERE stable_key = ?", stableKey,
      );
      const now = nowIso();
      if (!skill) {
        const skillId = newId();
        this.database.run(
          "INSERT INTO skills (id, stable_key, name, trigger_context_json, validation_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)",
          skillId, stableKey, name, triggerContextJson, now, now,
        );
        skill = { id: skillId, name, trigger_context_json: triggerContextJson };
      } else if (skill.name !== name || skill.trigger_context_json !== triggerContextJson) {
        throw new HarnessError("skill_candidate_invalid", "existing Skill identity has different name or trigger context");
      }
      const sourceExperienceIdsJson = canonicalJson([experience.id]);
      const existing = this.database.get<{ id: string; revision_number: number; frozen_at: string }>(`
        SELECT id, revision_number, frozen_at FROM skill_candidate_revisions
        WHERE skill_id = ? AND source_experience_ids_json = ? AND instruction_snapshot = ?
      `, skill.id, sourceExperienceIdsJson, instruction);
      if (existing) {
        return {
          skillId: skill.id, candidateRevisionId: existing.id, stableKey,
          revisionNumber: existing.revision_number, validationStatus: "frozen" as const,
          created: false, frozenAt: existing.frozen_at,
        };
      }
      const revisionNumber = (this.database.get<{ maximum: number | null }>(
        "SELECT MAX(revision_number) AS maximum FROM skill_candidate_revisions WHERE skill_id = ?", skill.id,
      )?.maximum ?? 0) + 1;
      const candidateRevisionId = newId();
      this.database.run(`
        INSERT INTO skill_candidate_revisions (
          id, skill_id, revision_number, source_experience_ids_json,
          instruction_snapshot, frozen_at, validation_status
        ) VALUES (?, ?, ?, ?, ?, ?, 'frozen')
      `, candidateRevisionId, skill.id, revisionNumber, sourceExperienceIdsJson, instruction, now);
      this.database.run(
        "UPDATE skills SET current_candidate_revision_id = ?, validation_status = 'frozen', updated_at = ? WHERE id = ?",
        candidateRevisionId, now, skill.id,
      );
      return {
        skillId: skill.id, candidateRevisionId, stableKey, revisionNumber,
        validationStatus: "frozen" as const, created: true, frozenAt: now,
      };
    });
  }

  proposeSkillTestCase(input: {
    projectId: string;
    candidateRevisionId: string;
    testType: SkillTestType;
    sourceRefs: string[];
    targetBehavior: string;
    applicableContext: Record<string, unknown>;
    fixtureSetup: unknown;
    input: unknown;
    expectedResult: unknown;
    oracle: Record<string, unknown>;
    reproductionCommand: string;
    timeoutMs: number;
    generatedBy: string;
    leakagePolicy: string;
  }): SkillTestCaseView {
    this.requireCandidateProject(input.candidateRevisionId, input.projectId);
    const targetBehavior = input.targetBehavior.trim();
    const reproductionCommand = input.reproductionCommand.trim();
    const generatedBy = input.generatedBy.trim();
    const leakagePolicy = input.leakagePolicy.trim();
    if (!input.sourceRefs.length || !targetBehavior || !reproductionCommand || !generatedBy || !leakagePolicy
      || !Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0) {
      throw new HarnessError("skill_test_invalid", "Skill test requires sources, behavior, executable reproduction metadata, and a positive timeout");
    }
    const values = {
      sourceRefsJson: canonicalJson(input.sourceRefs),
      applicableContextJson: canonicalJson(input.applicableContext),
      fixtureSetupJson: canonicalJson(input.fixtureSetup),
      inputJson: canonicalJson(input.input),
      expectedResultJson: canonicalJson(input.expectedResult),
      oracleJson: canonicalJson(input.oracle),
    };
    const existing = this.database.all<{
      id: string; source_refs_json: string; target_behavior: string; applicable_context_json: string;
      fixture_setup_json: string; input_json: string; expected_result_json: string; oracle_json: string;
      reproduction_command: string; timeout_ms: number; generated_by: string; leakage_policy: string;
      quality_status: "draft" | "accepted" | "rejected"; created_at: string;
    }>("SELECT * FROM skill_test_cases WHERE skill_candidate_revision_id = ? AND test_type = ?", input.candidateRevisionId, input.testType)
      .find((row) => row.source_refs_json === values.sourceRefsJson
        && row.target_behavior === targetBehavior
        && row.applicable_context_json === values.applicableContextJson
        && row.fixture_setup_json === values.fixtureSetupJson
        && row.input_json === values.inputJson
        && row.expected_result_json === values.expectedResultJson
        && row.oracle_json === values.oracleJson
        && row.reproduction_command === reproductionCommand
        && row.timeout_ms === input.timeoutMs
        && row.generated_by === generatedBy
        && row.leakage_policy === leakagePolicy);
    if (existing) {
      return {
        testCaseId: existing.id, candidateRevisionId: input.candidateRevisionId,
        testType: input.testType, qualityStatus: existing.quality_status,
        created: false, createdAt: existing.created_at,
      };
    }
    const testCaseId = newId();
    const createdAt = nowIso();
    this.database.run(`
      INSERT INTO skill_test_cases (
        id, skill_candidate_revision_id, test_type, source_refs_json, target_behavior,
        applicable_context_json, fixture_setup_json, input_json, expected_result_json,
        oracle_json, reproduction_command, timeout_ms, generated_by, quality_status,
        leakage_policy, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `, testCaseId, input.candidateRevisionId, input.testType, values.sourceRefsJson, targetBehavior,
    values.applicableContextJson, values.fixtureSetupJson, values.inputJson, values.expectedResultJson,
    values.oracleJson, reproductionCommand, input.timeoutMs, generatedBy, leakagePolicy, createdAt);
    return { testCaseId, candidateRevisionId: input.candidateRevisionId, testType: input.testType, qualityStatus: "draft", created: true, createdAt };
  }

  validateSkillTestQuality(input: {
    projectId: string;
    skillTestCaseId: string;
    idempotencyKey: string;
    schemaValid: boolean;
    fixtureIsolated: boolean;
    failureReproduced: boolean;
    oracleValid: boolean;
    discriminative: boolean;
    stable: boolean;
    splitValid: boolean;
    evidenceRefs: string[];
  }): SkillTestQualityView {
    const testCase = this.database.get<{ skill_candidate_revision_id: string; created_at: string }>(
      "SELECT skill_candidate_revision_id, created_at FROM skill_test_cases WHERE id = ?", input.skillTestCaseId,
    );
    if (!testCase) throw new HarnessError("not_found", "Skill test case was not found");
    this.requireCandidateProject(testCase.skill_candidate_revision_id, input.projectId);
    this.requireEvidence(input.projectId, input.evidenceRefs, testCase.created_at);
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw new HarnessError("skill_test_invalid", "quality validation requires an idempotency key");
    const verdict = input.schemaValid && input.fixtureIsolated && input.failureReproduced
      && input.oracleValid && input.discriminative && input.stable && input.splitValid ? "accepted" : "rejected";
    const evidenceRefsJson = canonicalJson(input.evidenceRefs);
    return this.database.transaction(() => {
      const existing = this.database.get<{
        id: string; skill_test_case_id: string; schema_valid: number; fixture_isolated: number;
        failure_reproduced: number; oracle_valid: number; discriminative: number; stable: number;
        split_valid: number; evidence_refs_json: string; verdict: "accepted" | "rejected"; created_at: string;
      }>("SELECT * FROM skill_test_quality_results WHERE idempotency_key = ?", idempotencyKey);
      if (existing) {
        const same = existing.skill_test_case_id === input.skillTestCaseId
          && existing.schema_valid === Number(input.schemaValid) && existing.fixture_isolated === Number(input.fixtureIsolated)
          && existing.failure_reproduced === Number(input.failureReproduced) && existing.oracle_valid === Number(input.oracleValid)
          && existing.discriminative === Number(input.discriminative) && existing.stable === Number(input.stable)
          && existing.split_valid === Number(input.splitValid) && existing.evidence_refs_json === evidenceRefsJson
          && existing.verdict === verdict;
        if (!same) throw new HarnessError("skill_validation_rejected", "idempotency key was already used for different quality evidence");
        return {
          qualityResultId: existing.id, skillTestCaseId: input.skillTestCaseId,
          verdict: existing.verdict, qualityStatus: existing.verdict, created: false, createdAt: existing.created_at,
        };
      }
      const qualityResultId = newId();
      const createdAt = nowIso();
      this.database.run(`
        INSERT INTO skill_test_quality_results (
          id, skill_test_case_id, schema_valid, fixture_isolated, failure_reproduced,
          oracle_valid, discriminative, stable, split_valid, evidence_refs_json,
          verdict, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, qualityResultId, input.skillTestCaseId, Number(input.schemaValid), Number(input.fixtureIsolated),
      Number(input.failureReproduced), Number(input.oracleValid), Number(input.discriminative),
      Number(input.stable), Number(input.splitValid), evidenceRefsJson, verdict, idempotencyKey, createdAt);
      this.database.run("UPDATE skill_test_cases SET quality_status = ? WHERE id = ?", verdict, input.skillTestCaseId);
      return { qualityResultId, skillTestCaseId: input.skillTestCaseId, verdict, qualityStatus: verdict, created: true, createdAt };
    });
  }

  recordSkillValidationRun(input: {
    projectId: string;
    candidateRevisionId: string;
    skillTestCaseId: string;
    runMode: SkillValidationRunMode;
    repetitionIndex: number;
    verdict: SkillValidationRunVerdict;
    tokenUsage?: number | null;
    toolCallCount?: number | null;
    sideEffectRisk: SkillSideEffectRisk;
    sideEffectSummary: string;
    evidenceRefs: string[];
  }): SkillValidationRunView {
    this.requireCandidateProject(input.candidateRevisionId, input.projectId);
    const testCase = this.database.get<{ skill_candidate_revision_id: string; quality_status: string; created_at: string }>(
      "SELECT skill_candidate_revision_id, quality_status, created_at FROM skill_test_cases WHERE id = ?", input.skillTestCaseId,
    );
    if (!testCase || testCase.skill_candidate_revision_id !== input.candidateRevisionId) {
      throw new HarnessError("not_found", "Skill test case was not found for this candidate");
    }
    if (testCase.quality_status !== "accepted") throw new HarnessError("skill_test_invalid", "validation runs require an accepted test case");
    if (!Number.isInteger(input.repetitionIndex) || input.repetitionIndex <= 0
      || (input.tokenUsage != null && (!Number.isInteger(input.tokenUsage) || input.tokenUsage < 0))
      || (input.toolCallCount != null && (!Number.isInteger(input.toolCallCount) || input.toolCallCount < 0))) {
      throw new HarnessError("skill_validation_rejected", "validation run counters must be non-negative integers");
    }
    this.requireEvidence(input.projectId, input.evidenceRefs, testCase.created_at);
    const sideEffectSummary = input.sideEffectSummary.trim();
    if (!sideEffectSummary) throw new HarnessError("skill_validation_rejected", "validation run requires a side-effect summary");
    const evidenceRefsJson = canonicalJson(input.evidenceRefs);
    return this.database.transaction(() => {
      const existing = this.database.get<{
        id: string; verdict: SkillValidationRunVerdict; token_usage: number | null; tool_call_count: number | null;
        side_effect_risk: SkillSideEffectRisk; side_effect_summary: string; evidence_refs_json: string; created_at: string;
      }>(`SELECT id, verdict, token_usage, tool_call_count, side_effect_risk, side_effect_summary, evidence_refs_json, created_at
           FROM skill_validation_runs WHERE skill_candidate_revision_id = ? AND skill_test_case_id = ? AND run_mode = ? AND repetition_index = ?`,
      input.candidateRevisionId, input.skillTestCaseId, input.runMode, input.repetitionIndex);
      const tokenUsage = input.tokenUsage ?? null;
      const toolCallCount = input.toolCallCount ?? null;
      if (existing) {
        const same = existing.verdict === input.verdict && existing.token_usage === tokenUsage
          && existing.tool_call_count === toolCallCount && existing.side_effect_risk === input.sideEffectRisk
          && existing.side_effect_summary === sideEffectSummary && existing.evidence_refs_json === evidenceRefsJson;
        if (!same) throw new HarnessError("skill_validation_rejected", "validation repetition already has different immutable evidence");
        return {
          validationRunId: existing.id, skillTestCaseId: input.skillTestCaseId, runMode: input.runMode,
          repetitionIndex: input.repetitionIndex, verdict: existing.verdict, created: false, createdAt: existing.created_at,
        };
      }
      const validationRunId = newId();
      const createdAt = nowIso();
      this.database.run(`
        INSERT INTO skill_validation_runs (
          id, skill_candidate_revision_id, skill_test_case_id, run_mode, repetition_index,
          verdict, token_usage, tool_call_count, side_effect_risk, side_effect_summary,
          evidence_refs_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, validationRunId, input.candidateRevisionId, input.skillTestCaseId, input.runMode, input.repetitionIndex,
      input.verdict, tokenUsage, toolCallCount, input.sideEffectRisk, sideEffectSummary, evidenceRefsJson, createdAt);
      this.database.run("UPDATE skill_candidate_revisions SET validation_status = 'validating' WHERE id = ? AND validation_status = 'frozen'", input.candidateRevisionId);
      this.database.run("UPDATE skills SET validation_status = 'validating', updated_at = ? WHERE current_candidate_revision_id = ? AND validation_status IN ('frozen', 'draft')", createdAt, input.candidateRevisionId);
      return {
        validationRunId, skillTestCaseId: input.skillTestCaseId, runMode: input.runMode,
        repetitionIndex: input.repetitionIndex, verdict: input.verdict, created: true, createdAt,
      };
    });
  }

  private requireCandidateProject(candidateRevisionId: string, projectId: string): void {
    const candidate = this.database.get<{ source_experience_ids_json: string }>(
      "SELECT source_experience_ids_json FROM skill_candidate_revisions WHERE id = ?", candidateRevisionId,
    );
    if (!candidate) throw new HarnessError("not_found", "Skill candidate revision was not found");
    const sourceIds = JSON.parse(candidate.source_experience_ids_json) as string[];
    if (!sourceIds.length || sourceIds.some((experienceId) => !this.database.get(
      "SELECT id FROM experiences WHERE id = ? AND source_project_id = ?", experienceId, projectId,
    ))) throw new HarnessError("not_found", "Skill candidate revision was not found in this Project");
  }

  private requireEvidence(projectId: string, evidenceRefs: string[], notBefore: string): void {
    if (!evidenceRefs.length) throw new HarnessError("evidence_not_found", "at least one Trace evidence reference is required");
    const placeholders = evidenceRefs.map(() => "?").join(", ");
    const matched = this.database.get<{ count: number }>(
      `SELECT count(*) AS count FROM trace_events WHERE project_id = ? AND id IN (${placeholders}) AND occurred_at >= ?`,
      projectId, ...evidenceRefs, notBefore,
    )?.count ?? 0;
    if (matched !== new Set(evidenceRefs).size) {
      throw new HarnessError("evidence_scope_mismatch", "Trace evidence must belong to the candidate Project and occur after the tested record exists");
    }
  }
}
