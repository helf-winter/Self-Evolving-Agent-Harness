import { HarnessError } from "../domain/errors.js";
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
}
