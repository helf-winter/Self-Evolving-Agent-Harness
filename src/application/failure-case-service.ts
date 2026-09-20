import { HarnessError } from "../domain/errors.js";
import {
  determineFailureMaturity,
  validateReproductionContract,
  type FailureAvailabilityStatus,
  type FailureMaturityLevel,
  type FailureReproductionContract,
  type ReproductionValidationObservation,
} from "../domain/failure-case.js";
import { newId, nowIso } from "../domain/ids.js";
import type { TaskNodeInput } from "../domain/task-tree.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";

interface FailedEvaluationRow {
  evaluation_id: string;
  project_id: string;
  tree_id: string;
  task_node_id: string;
  task_node_revision_id: string;
  execution_attempt_id: string;
  verdict: string;
  evidence_refs_json: string;
  risk_summary: string;
  created_at: string;
  node_title: string;
  body_json: string;
  transition_applied: number;
  transition_target_status: string;
}

export interface FailureCaptureView {
  failureCaseId: string;
  occurrenceId: string;
  reproductionRevisionId: string;
  created: boolean;
  maturityLevel: "L0_observed";
}

export interface FailureReproductionRevisionView {
  reproductionRevisionId: string;
  failureCaseId: string;
  revisionNumber: number;
  mode: FailureReproductionContract["mode"];
  validationStatus: string;
  createdAt: string;
}

export interface ReproductionValidationView {
  validationResultId: string;
  failureCaseId: string;
  reproductionRevisionId: string;
  promotedMaturity: FailureMaturityLevel;
  caseMaturity: FailureMaturityLevel;
  createdAt: string;
}

const maturityRank: Record<FailureMaturityLevel, number> = {
  L0_observed: 0,
  L1_manual: 1,
  L2_assisted: 2,
  L3_automated: 3,
  L4_regression: 4,
};

const availabilityStatuses = new Set<FailureAvailabilityStatus>([
  "active", "flaky", "environment_blocked", "quarantined", "obsolete",
]);

function normalizeFailureSummary(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ") || "unspecified failure";
}

export class FailureCaseService {
  constructor(private readonly database: RuntimeDatabase) {}

  captureFailedEvaluationWithinTransaction(input: { projectId: string; evaluationId: string }): FailureCaptureView {
    const evaluation = this.database.get<FailedEvaluationRow>(`
      SELECT e.id AS evaluation_id, e.project_id, e.tree_id, e.task_node_id,
             e.task_node_revision_id, e.execution_attempt_id, e.verdict,
             e.evidence_refs_json, e.risk_summary, e.created_at,
             n.title AS node_title, nr.body_json,
             l.applied AS transition_applied, l.target_status AS transition_target_status
      FROM evaluations e
      JOIN execution_attempts a ON a.id = e.execution_attempt_id
      JOIN task_nodes n ON n.id = e.task_node_id
      JOIN task_node_revisions nr ON nr.id = e.task_node_revision_id
      JOIN lifecycle_transition_records l ON l.evaluation_id = e.id
      WHERE e.id = ? AND e.project_id = ?
    `, input.evaluationId, input.projectId);
    if (!evaluation) throw new HarnessError("not_found", "Evaluation was not found in this Project");
    if (evaluation.verdict !== "failed" || evaluation.transition_applied !== 1 || evaluation.transition_target_status !== "failed") {
      throw new HarnessError("failure_case_invalid", "only an applied failed Evaluation can create a Failure Case occurrence");
    }

    const existingOccurrence = this.database.get<{
      occurrence_id: string; failure_case_id: string; current_reproduction_revision_id: string;
    }>(`
      SELECT o.id AS occurrence_id, o.failure_case_id, f.current_reproduction_revision_id
      FROM failure_case_occurrences o
      JOIN failure_cases f ON f.id = o.failure_case_id
      WHERE o.project_id = ? AND o.evaluation_id = ?
    `, input.projectId, input.evaluationId);
    if (existingOccurrence) {
      return {
        failureCaseId: existingOccurrence.failure_case_id,
        occurrenceId: existingOccurrence.occurrence_id,
        reproductionRevisionId: existingOccurrence.current_reproduction_revision_id,
        created: false,
        maturityLevel: "L0_observed",
      };
    }

    const body = JSON.parse(evaluation.body_json) as TaskNodeInput;
    const failureGoal = body.objectives?.find((value) => value.trim()) ?? evaluation.node_title;
    const normalizedSummary = normalizeFailureSummary(evaluation.risk_summary);
    const failureSignature = canonicalJson({
      version: 1,
      taskNodeRevisionId: evaluation.task_node_revision_id,
      failureSummary: normalizedSummary,
    });
    const artifactIds = this.database.all<{ artifact_id: string }>(`
      SELECT DISTINCT l.artifact_id
      FROM task_node_artifact_links l
      JOIN task_node_revisions nr ON nr.node_id = l.task_node_id AND nr.tree_revision_id = l.tree_revision_id
      WHERE nr.id = ?
      ORDER BY l.artifact_id
    `, evaluation.task_node_revision_id).map((row) => row.artifact_id);
    const evidenceRefs = JSON.parse(evaluation.evidence_refs_json) as string[];
    const createdAt = nowIso();
    let failureCase = this.database.get<{
      id: string; current_reproduction_revision_id: string; related_artifact_ids_json: string;
    }>("SELECT id, current_reproduction_revision_id, related_artifact_ids_json FROM failure_cases WHERE project_id = ? AND failure_signature = ?", input.projectId, failureSignature);
    let created = false;
    if (!failureCase) {
      const failureCaseId = newId();
      const reproductionRevisionId = newId();
      this.database.run(`
        INSERT INTO failure_cases (
          id, project_id, tree_id, source_task_node_id, source_execution_attempt_id,
          source_evaluation_id, failure_goal, failure_signature, maturity_level,
          availability_status, current_reproduction_revision_id, related_artifact_ids_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'L0_observed', 'active', ?, ?, ?, ?)
      `, failureCaseId, input.projectId, evaluation.tree_id, evaluation.task_node_id,
      evaluation.execution_attempt_id, evaluation.evaluation_id, failureGoal, failureSignature,
      reproductionRevisionId, canonicalJson(artifactIds), createdAt, createdAt);
      this.database.run(`
        INSERT INTO failure_reproduction_revisions (
          id, project_id, failure_case_id, revision_number, reproduction_mode,
          contract_json, validation_status, created_at
        ) VALUES (?, ?, ?, 1, 'observed', ?, 'draft', ?)
      `, reproductionRevisionId, input.projectId, failureCaseId, canonicalJson({
        mode: "observed",
        sourceEvaluationId: evaluation.evaluation_id,
        sourceAttemptId: evaluation.execution_attempt_id,
        failureSummary: normalizedSummary,
        evidenceRefs,
      }), createdAt);
      failureCase = { id: failureCaseId, current_reproduction_revision_id: reproductionRevisionId, related_artifact_ids_json: canonicalJson(artifactIds) };
      created = true;
    } else {
      const mergedArtifactIds = [...new Set([
        ...(JSON.parse(failureCase.related_artifact_ids_json) as string[]),
        ...artifactIds,
      ])].sort();
      this.database.run(
        "UPDATE failure_cases SET related_artifact_ids_json = ?, updated_at = ? WHERE id = ? AND project_id = ?",
        canonicalJson(mergedArtifactIds), createdAt, failureCase.id, input.projectId,
      );
    }

    const occurrenceId = newId();
    this.database.run(`
      INSERT INTO failure_case_occurrences (
        id, project_id, failure_case_id, execution_attempt_id, evaluation_id,
        evidence_refs_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, occurrenceId, input.projectId, failureCase.id, evaluation.execution_attempt_id,
    evaluation.evaluation_id, canonicalJson(evidenceRefs), createdAt);
    return {
      failureCaseId: failureCase.id,
      occurrenceId,
      reproductionRevisionId: failureCase.current_reproduction_revision_id,
      created,
      maturityLevel: "L0_observed",
    };
  }

  addReproductionRevision(input: {
    projectId: string;
    failureCaseId: string;
    contract: FailureReproductionContract;
  }): FailureReproductionRevisionView {
    validateReproductionContract(input.contract);
    const failureCase = this.requireFailureCase(input.projectId, input.failureCaseId);
    this.requireEvidence(input.projectId, input.contract.evidenceRefs);
    const revisionNumber = (this.database.get<{ maximum: number | null }>(
      "SELECT MAX(revision_number) AS maximum FROM failure_reproduction_revisions WHERE failure_case_id = ? AND project_id = ?",
      input.failureCaseId, input.projectId,
    )?.maximum ?? 0) + 1;
    const reproductionRevisionId = newId();
    const createdAt = nowIso();
    this.database.transaction(() => {
      this.database.run(`
        INSERT INTO failure_reproduction_revisions (
          id, project_id, failure_case_id, revision_number, reproduction_mode,
          contract_json, validation_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)
      `, reproductionRevisionId, input.projectId, failureCase.id, revisionNumber,
      input.contract.mode, canonicalJson(input.contract), createdAt);
      this.database.run("UPDATE failure_cases SET updated_at = ? WHERE id = ? AND project_id = ?", createdAt, failureCase.id, input.projectId);
    });
    return {
      reproductionRevisionId,
      failureCaseId: failureCase.id,
      revisionNumber,
      mode: input.contract.mode,
      validationStatus: "draft",
      createdAt,
    };
  }

  validateReproduction(input: {
    projectId: string;
    failureCaseId: string;
    reproductionRevisionId: string;
    observation: ReproductionValidationObservation;
    idempotencyKey: string;
  }): ReproductionValidationView {
    if (!input.idempotencyKey.trim()) {
      throw new HarnessError("reproduction_validation_rejected", "reproduction validation requires an idempotency key");
    }
    const failureCase = this.requireFailureCase(input.projectId, input.failureCaseId);
    const revision = this.database.get<{
      id: string; reproduction_mode: FailureReproductionContract["mode"]; contract_json: string; created_at: string;
    }>(`
      SELECT id, reproduction_mode, contract_json, created_at FROM failure_reproduction_revisions
      WHERE id = ? AND failure_case_id = ? AND project_id = ?
    `, input.reproductionRevisionId, input.failureCaseId, input.projectId);
    if (!revision || revision.reproduction_mode === ("observed" as FailureReproductionContract["mode"])) {
      throw new HarnessError("not_found", "authored Failure Reproduction Revision was not found in this Project");
    }
    const contract = JSON.parse(revision.contract_json) as FailureReproductionContract;
    const observationJson = canonicalJson(input.observation);
    const existing = this.database.get<{
      id: string; project_id: string; failure_case_id: string; reproduction_revision_id: string;
      observation_json: string; maturity_promotion_verdict: FailureMaturityLevel; created_at: string;
    }>(`
      SELECT id, project_id, failure_case_id, reproduction_revision_id,
             observation_json, maturity_promotion_verdict, created_at
      FROM reproduction_validation_results WHERE idempotency_key = ?
    `, input.idempotencyKey);
    if (existing) {
      if (existing.project_id !== input.projectId
        || existing.failure_case_id !== input.failureCaseId
        || existing.reproduction_revision_id !== input.reproductionRevisionId
        || existing.observation_json !== observationJson) {
        throw new HarnessError("reproduction_validation_rejected", "validation idempotency key was already used for different input");
      }
      return {
        validationResultId: existing.id,
        failureCaseId: existing.failure_case_id,
        reproductionRevisionId: existing.reproduction_revision_id,
        promotedMaturity: existing.maturity_promotion_verdict,
        caseMaturity: failureCase.maturity_level,
        createdAt: existing.created_at,
      };
    }
    this.requireEvidence(input.projectId, input.observation.evidenceRefs, revision.created_at);
    const promotedMaturity = determineFailureMaturity({
      mode: contract.mode,
      contract,
      validation: input.observation,
    });
    const caseMaturity = maturityRank[promotedMaturity] > maturityRank[failureCase.maturity_level]
      ? promotedMaturity
      : failureCase.maturity_level;
    const accepted = promotedMaturity !== "L0_observed";
    const validationStatus = !accepted
      ? "rejected"
      : contract.mode === "manual"
        ? "verified_manual"
        : contract.mode === "assisted" ? "verified_assisted" : "verified_automated";
    const validationResultId = newId();
    const createdAt = nowIso();
    this.database.transaction(() => {
      this.database.run(`
        INSERT INTO reproduction_validation_results (
          id, project_id, failure_case_id, reproduction_revision_id, observation_json,
          pre_fix_verdict, post_fix_verdict, oracle_discrimination_verdict,
          repeat_stability_verdict, isolation_verdict, evidence_refs_json,
          maturity_promotion_verdict, rejection_reasons_json, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, validationResultId, input.projectId, input.failureCaseId, input.reproductionRevisionId,
      observationJson, input.observation.preFixVerdict, input.observation.postFixVerdict,
      input.observation.oracleDiscriminationVerdict, input.observation.repeatStabilityVerdict,
      input.observation.isolationVerdict, canonicalJson(input.observation.evidenceRefs),
      promotedMaturity, canonicalJson(accepted ? [] : ["maturity_gates_not_met"]),
      input.idempotencyKey, createdAt);
      this.database.run(
        "UPDATE failure_reproduction_revisions SET validation_status = ? WHERE id = ? AND project_id = ?",
        validationStatus, input.reproductionRevisionId, input.projectId,
      );
      const useRevision = accepted && maturityRank[promotedMaturity] >= maturityRank[failureCase.maturity_level];
      this.database.run(`
        UPDATE failure_cases
        SET maturity_level = ?, current_reproduction_revision_id = CASE WHEN ? = 1 THEN ? ELSE current_reproduction_revision_id END,
            updated_at = ?
        WHERE id = ? AND project_id = ?
      `, caseMaturity, useRevision ? 1 : 0, input.reproductionRevisionId, createdAt, input.failureCaseId, input.projectId);
    });
    return {
      validationResultId,
      failureCaseId: input.failureCaseId,
      reproductionRevisionId: input.reproductionRevisionId,
      promotedMaturity,
      caseMaturity,
      createdAt,
    };
  }

  setAvailability(input: {
    projectId: string;
    failureCaseId: string;
    availabilityStatus: FailureAvailabilityStatus;
  }): { failureCaseId: string; maturityLevel: FailureMaturityLevel; availabilityStatus: FailureAvailabilityStatus } {
    if (!availabilityStatuses.has(input.availabilityStatus)) {
      throw new HarnessError("failure_case_invalid", "unsupported Failure Case availability status");
    }
    const failureCase = this.requireFailureCase(input.projectId, input.failureCaseId);
    this.database.run(
      "UPDATE failure_cases SET availability_status = ?, updated_at = ? WHERE id = ? AND project_id = ?",
      input.availabilityStatus, nowIso(), input.failureCaseId, input.projectId,
    );
    return {
      failureCaseId: input.failureCaseId,
      maturityLevel: failureCase.maturity_level,
      availabilityStatus: input.availabilityStatus,
    };
  }

  private requireFailureCase(projectId: string, failureCaseId: string) {
    const failureCase = this.database.get<{
      id: string; maturity_level: FailureMaturityLevel; availability_status: FailureAvailabilityStatus;
    }>("SELECT id, maturity_level, availability_status FROM failure_cases WHERE id = ? AND project_id = ?", failureCaseId, projectId);
    if (!failureCase) throw new HarnessError("not_found", "Failure Case was not found in this Project");
    return failureCase;
  }

  private requireEvidence(projectId: string, evidenceRefs: string[], notBefore?: string): void {
    const uniqueRefs = [...new Set(evidenceRefs)];
    if (uniqueRefs.length === 0) {
      throw new HarnessError("reproduction_validation_rejected", "Failure Case evidence cannot be empty");
    }
    const placeholders = uniqueRefs.map(() => "?").join(", ");
    const found = this.database.get<{ count: number }>(
      `SELECT count(*) AS count FROM trace_events WHERE project_id = ? AND id IN (${placeholders})${notBefore ? " AND occurred_at >= ?" : ""}`,
      projectId, ...uniqueRefs, ...(notBefore ? [notBefore] : []),
    )?.count ?? 0;
    if (found !== uniqueRefs.length) {
      throw new HarnessError("evidence_scope_mismatch", "Failure Case evidence must reference Trace Events from the same Project");
    }
  }
}
