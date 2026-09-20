import { HarnessError } from "../domain/errors.js";
import {
  decideLifecycleTransition,
  type EvaluationVerdict,
  type ExecutionAttemptStatus,
  type LifecycleTransitionDecision,
  type TaskNodeExecutionStatus,
} from "../domain/execution.js";
import { newId, nowIso } from "../domain/ids.js";
import type { TaskNodeInput } from "../domain/task-tree.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";

interface EvaluationAttemptRow {
  id: string;
  project_id: string;
  tree_id: string;
  task_node_id: string;
  task_node_revision_id: string;
  status: ExecutionAttemptStatus;
  body_json: string;
  revision_tree_id: string;
  current_revision_id: string;
  node_status: TaskNodeExecutionStatus;
}

export interface EvaluationResultView {
  evaluationId: string;
  projectId: string;
  treeId: string;
  nodeId: string;
  nodeRevisionId: string;
  attemptId: string;
  verdict: EvaluationVerdict;
  evidenceRefs: string[];
  coveredRequiredEvidence: string[];
  missingRequiredEvidence: string[];
  riskSummary: string | null;
  createdAt: string;
}

export interface AppliedLifecycleTransition extends LifecycleTransitionDecision {
  evaluationId: string;
  fromStatus: TaskNodeExecutionStatus;
}

export class EvaluationService {
  constructor(private readonly database: RuntimeDatabase) {}

  evaluateAttempt(input: {
    projectId: string;
    attemptId: string;
    proposedVerdict: EvaluationVerdict;
    riskSummary: string | null;
  }): { evaluation: EvaluationResultView; transition: AppliedLifecycleTransition } {
    const attempt = this.requireAttempt(input.projectId, input.attemptId);
    const blockingDrift = this.hasUnresolvedBlockingDrift(attempt.project_id, attempt.tree_id, attempt.task_node_id);
    if (attempt.status !== "verifying" && !(attempt.status === "blocked" && blockingDrift)) {
      throw new HarnessError("evaluation_not_applicable", "only a verifying Execution Attempt can be evaluated");
    }

    const body = JSON.parse(attempt.body_json) as TaskNodeInput;
    const requiredKeys = (body.requiredEvidence ?? []).map((item) => item.key);
    const evidenceRows = this.database.all<{ required_evidence_key: string; trace_event_id: string }>(
      "SELECT required_evidence_key, trace_event_id FROM execution_attempt_evidence WHERE attempt_id = ? ORDER BY created_at, trace_event_id",
      attempt.id,
    );
    const coveredSet = new Set(evidenceRows.map((row) => row.required_evidence_key));
    const covered = requiredKeys.filter((key) => coveredSet.has(key));
    const missing = requiredKeys.filter((key) => !coveredSet.has(key));
    const dependenciesSucceeded = this.dependenciesSucceeded(attempt.tree_id, body.dependencies ?? []);
    const childrenSucceeded = this.childrenSucceeded(attempt.tree_id, attempt.task_node_id);
    const successConditionsMet = missing.length === 0 && dependenciesSucceeded && childrenSucceeded;
    const verdict: EvaluationVerdict = input.proposedVerdict === "succeeded" && (!successConditionsMet || blockingDrift)
      ? "uncertain"
      : input.proposedVerdict;
    const currentRevision = attempt.revision_tree_id === attempt.current_revision_id;
    const decision = decideLifecycleTransition({
      currentRevision,
      fromStatus: attempt.node_status,
      verdict,
      evidenceComplete: missing.length === 0,
      dependenciesSucceeded,
      childrenSucceeded,
      blockingDrift,
    });

    const evaluationId = newId();
    const transitionId = newId();
    const createdAt = nowIso();
    const evidenceRefs = [...new Set(evidenceRows.map((row) => row.trace_event_id))];
    this.database.transaction(() => {
      this.database.run(`
        INSERT INTO evaluations (
          id, project_id, tree_id, task_node_id, task_node_revision_id,
          execution_attempt_id, verdict, evidence_refs_json,
          covered_required_evidence_json, missing_required_evidence_json,
          risk_summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      evaluationId, attempt.project_id, attempt.tree_id, attempt.task_node_id, attempt.task_node_revision_id,
      attempt.id, verdict, canonicalJson(evidenceRefs), canonicalJson(covered), canonicalJson(missing),
      input.riskSummary ?? "", createdAt);
      this.database.run(`
        INSERT INTO lifecycle_transition_records (
          id, evaluation_id, task_node_id, policy_version, from_status,
          target_status, applied, rejection_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      transitionId, evaluationId, attempt.task_node_id, decision.policyVersion, attempt.node_status,
      decision.targetStatus, decision.applied ? 1 : 0, decision.rejectionCode, createdAt);

      if (!currentRevision) {
        this.database.run("UPDATE execution_attempts SET status = 'aborted', completed_at = ? WHERE id = ?", createdAt, attempt.id);
        this.database.run("UPDATE task_nodes SET status = 'needs_revalidation' WHERE id = ?", attempt.task_node_id);
      } else if (decision.applied) {
        this.database.run("UPDATE execution_attempts SET status = ?, completed_at = ? WHERE id = ?", decision.targetStatus, createdAt, attempt.id);
        this.database.run("UPDATE task_nodes SET status = ? WHERE id = ?", decision.targetStatus, attempt.task_node_id);
      }
    });

    return {
      evaluation: {
        evaluationId,
        projectId: attempt.project_id,
        treeId: attempt.tree_id,
        nodeId: attempt.task_node_id,
        nodeRevisionId: attempt.task_node_revision_id,
        attemptId: attempt.id,
        verdict,
        evidenceRefs,
        coveredRequiredEvidence: covered,
        missingRequiredEvidence: missing,
        riskSummary: input.riskSummary,
        createdAt,
      },
      transition: { evaluationId, fromStatus: attempt.node_status, ...decision },
    };
  }

  private requireAttempt(projectId: string, attemptId: string): EvaluationAttemptRow {
    const attempt = this.database.get<EvaluationAttemptRow>(`
      SELECT a.id, a.project_id, a.tree_id, a.task_node_id, a.task_node_revision_id, a.status,
             nr.body_json, nr.tree_revision_id AS revision_tree_id,
             t.current_revision_id, n.status AS node_status
      FROM execution_attempts a
      JOIN task_node_revisions nr ON nr.id = a.task_node_revision_id
      JOIN task_trees t ON t.id = a.tree_id
      JOIN task_nodes n ON n.id = a.task_node_id
      WHERE a.id = ? AND a.project_id = ?
    `, attemptId, projectId);
    if (!attempt) throw new HarnessError("not_found", "Execution Attempt was not found in this Project");
    return attempt;
  }

  private dependenciesSucceeded(treeId: string, dependencies: string[]): boolean {
    return dependencies.every((dependencyId) => this.database.get<{ status: string }>(
      `SELECT n.status
       FROM task_nodes n
       JOIN task_trees t ON t.id = n.tree_id
       JOIN task_node_revisions nr ON nr.node_id = n.id AND nr.tree_revision_id = t.current_revision_id
       WHERE n.id = ? AND n.tree_id = ?`,
      dependencyId, treeId,
    )?.status === "succeeded");
  }

  private childrenSucceeded(treeId: string, nodeId: string): boolean {
    return this.database.all<{ status: string }>(
      `SELECT n.status
       FROM task_nodes n
       JOIN task_trees t ON t.id = n.tree_id
       JOIN task_node_revisions nr ON nr.node_id = n.id AND nr.tree_revision_id = t.current_revision_id
       WHERE n.tree_id = ? AND n.parent_id = ?`,
      treeId, nodeId,
    ).every((child) => child.status === "succeeded");
  }

  private hasUnresolvedBlockingDrift(projectId: string, treeId: string, nodeId: string): boolean {
    return Boolean(this.database.get(`
      SELECT id FROM plan_drift_records
      WHERE project_id = ? AND tree_id = ? AND severity = 'blocking'
        AND resolution_status = 'pending_user_confirmation'
        AND (task_node_id = ? OR task_node_id IS NULL)
      LIMIT 1
    `, projectId, treeId, nodeId));
  }
}
