import { HarnessError } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";

interface FinalReportRow {
  id: string;
  project_id: string;
  tree_id: string;
  tree_revision_id: string;
  workflow_revision: number;
  root_phase_gate_result_id: string;
  status: "completed";
  summary_json: string;
  evidence_refs_json: string;
  idempotency_key: string;
  created_at: string;
}

interface StatusCountRow {
  status: string;
  count: number;
}

export class FinalReportService {
  constructor(private readonly database: RuntimeDatabase) {}

  finalize(input: {
    projectId: string;
    treeId: string;
    workflowRevision: number;
    idempotencyKey: string;
  }) {
    if (!input.idempotencyKey.trim()) {
      throw new HarnessError("invalid_input", "final report idempotency key is required");
    }
    return this.database.transaction(() => this.finalizeWithinTransaction(input));
  }

  list(projectId: string, options: { treeId?: string; reportId?: string } = {}) {
    const clauses = ["project_id = ?"];
    const params: string[] = [projectId];
    if (options.treeId) { clauses.push("tree_id = ?"); params.push(options.treeId); }
    if (options.reportId) { clauses.push("id = ?"); params.push(options.reportId); }
    return this.database.all<FinalReportRow>(`
      SELECT * FROM final_reports WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT 200
    `, ...params).map((row) => this.view(row, false));
  }

  private finalizeWithinTransaction(input: {
    projectId: string;
    treeId: string;
    workflowRevision: number;
    idempotencyKey: string;
  }) {
    const existing = this.database.get<FinalReportRow>(
      "SELECT * FROM final_reports WHERE project_id = ? AND idempotency_key = ?",
      input.projectId, input.idempotencyKey,
    );
    if (existing) {
      if (existing.tree_id !== input.treeId || existing.workflow_revision !== input.workflowRevision) {
        throw new HarnessError("invalid_input", "final report idempotency key was already used for another completion");
      }
      return this.view(existing, false);
    }

    const tree = this.database.get<{
      id: string; title: string; status: string; current_revision_id: string;
    }>(
      "SELECT id, title, status, current_revision_id FROM task_trees WHERE id = ? AND project_id = ?",
      input.treeId, input.projectId,
    );
    if (!tree) throw new HarnessError("not_found", "Task Tree was not found in the current Project");
    if (tree.status === "completed") {
      throw new HarnessError("task_tree_transition_rejected", "Task Tree already has a completed final report");
    }
    if (tree.status === "archived") {
      throw new HarnessError("task_tree_transition_rejected", "an archived Task Tree cannot be completed");
    }

    const workflow = this.database.get<{ id: string; stage: string; revision: number; active: number }>(`
      SELECT id, stage, revision, active FROM workflow_states
      WHERE project_id = ? AND tree_id = ? ORDER BY active DESC, updated_at DESC, id DESC LIMIT 1
    `, input.projectId, input.treeId);
    if (!workflow) throw new HarnessError("not_found", "Task Tree Workflow was not found");
    if (workflow.revision !== input.workflowRevision) {
      throw new HarnessError("revision_conflict", "workflow revision does not match current state");
    }
    if (workflow.active !== 1 || workflow.stage !== "final_report") {
      throw new HarnessError("workflow_transition_rejected", "Task Tree is not at the active final_report stage");
    }

    const rootGate = this.database.get<{ id: string }>(`
      SELECT id FROM workflow_phase_gate_results
      WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?
        AND workflow_revision = ? AND stage = 'root_verification'
        AND status = 'passed' AND next_stage = 'final_report'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `, input.projectId, input.treeId, tree.current_revision_id, workflow.revision - 1);

    const taskNodes = this.statusCounts(`
      SELECT n.status, count(*) AS count FROM task_nodes n
      JOIN task_node_revisions nr ON nr.node_id = n.id
      WHERE n.tree_id = ? AND nr.tree_revision_id = ? GROUP BY n.status
    `, input.treeId, tree.current_revision_id);
    const branches = this.statusCounts(`
      SELECT status, count(*) AS count FROM workflow_branch_states
      WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ? GROUP BY status
    `, input.projectId, input.treeId, tree.current_revision_id);
    const activeAttempts = this.count(`
      SELECT count(*) AS count FROM execution_attempts
      WHERE project_id = ? AND tree_id = ? AND status IN ('running', 'verifying')
    `, input.projectId, input.treeId);
    const blockingDrifts = this.count(`
      SELECT count(*) AS count FROM plan_drift_records
      WHERE project_id = ? AND tree_id = ? AND severity = 'blocking'
        AND resolution_status = 'pending_user_confirmation'
    `, input.projectId, input.treeId);
    const pendingConfirmations = this.count(`
      SELECT count(*) AS count FROM runtime_confirmation_prompts
      WHERE project_id = ? AND tree_id = ? AND status = 'pending'
    `, input.projectId, input.treeId);
    const pendingChanges = this.count(`
      SELECT count(*) AS count FROM user_change_requests
      WHERE project_id = ? AND tree_id = ? AND status IN ('proposed', 'pending_confirmation', 'paused')
    `, input.projectId, input.treeId);

    const blockers: Array<{ code: string; ref: string }> = [];
    if (!rootGate) blockers.push({ code: "root_verification_gate_missing", ref: tree.current_revision_id });
    for (const [status, count] of taskNodes) {
      if (status !== "succeeded") blockers.push({ code: "task_node_incomplete", ref: `${status}:${count}` });
    }
    for (const [status, count] of branches) {
      if (status !== "verified") blockers.push({ code: "branch_not_verified", ref: `${status}:${count}` });
    }
    if (activeAttempts) blockers.push({ code: "active_attempt", ref: String(activeAttempts) });
    if (blockingDrifts) blockers.push({ code: "blocking_drift", ref: String(blockingDrifts) });
    if (pendingConfirmations) blockers.push({ code: "pending_confirmation", ref: String(pendingConfirmations) });
    if (pendingChanges) blockers.push({ code: "pending_change", ref: String(pendingChanges) });
    if (blockers.length) {
      throw new HarnessError("workflow_transition_rejected", "Task Tree cannot be finalized while lifecycle blockers remain", { blockers });
    }

    const phaseGates = this.statusCounts(`
      SELECT status, count(*) AS count FROM workflow_phase_gate_results
      WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ? GROUP BY status
    `, input.projectId, input.treeId, tree.current_revision_id);
    const artifacts = this.statusCounts(`
      SELECT status, count(*) AS count FROM artifacts WHERE project_id = ? AND tree_id = ? GROUP BY status
    `, input.projectId, input.treeId);
    const evaluations = this.statusCounts(`
      SELECT e.verdict AS status, count(*) AS count FROM evaluations e
      JOIN task_node_revisions nr ON nr.id = e.task_node_revision_id
      WHERE e.project_id = ? AND e.tree_id = ? AND nr.tree_revision_id = ? GROUP BY e.verdict
    `, input.projectId, input.treeId, tree.current_revision_id);
    const traceCount = this.count(
      "SELECT count(*) AS count FROM trace_events WHERE project_id = ? AND tree_id = ?",
      input.projectId, input.treeId,
    );

    const phaseGateResultIds = this.ids(`
      SELECT id FROM workflow_phase_gate_results
      WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ? AND status = 'passed'
      ORDER BY created_at, id
    `, input.projectId, input.treeId, tree.current_revision_id);
    const evaluationIds = this.ids(`
      SELECT e.id FROM evaluations e JOIN task_node_revisions nr ON nr.id = e.task_node_revision_id
      WHERE e.project_id = ? AND e.tree_id = ? AND nr.tree_revision_id = ? AND e.verdict = 'succeeded'
      ORDER BY e.created_at, e.id
    `, input.projectId, input.treeId, tree.current_revision_id);
    const traceEventIds = this.ids(`
      SELECT DISTINCT ae.trace_event_id AS id FROM execution_attempt_evidence ae
      JOIN execution_attempts a ON a.id = ae.attempt_id
      JOIN task_node_revisions nr ON nr.id = a.task_node_revision_id
      WHERE a.project_id = ? AND a.tree_id = ? AND nr.tree_revision_id = ?
      ORDER BY id
    `, input.projectId, input.treeId, tree.current_revision_id);
    const artifactIds = this.ids(`
      SELECT id FROM artifacts WHERE project_id = ? AND tree_id = ?
        AND status IN ('created', 'modified', 'verified', 'observed') ORDER BY id
    `, input.projectId, input.treeId);

    const summary = {
      tree: { title: tree.title, revisionId: tree.current_revision_id },
      taskNodes: {
        total: this.total(taskNodes), succeeded: taskNodes.get("succeeded") ?? 0,
        failed: taskNodes.get("failed") ?? 0, blocked: taskNodes.get("blocked") ?? 0,
      },
      branches: { total: this.total(branches), verified: branches.get("verified") ?? 0 },
      phaseGates: {
        total: this.total(phaseGates), passed: phaseGates.get("passed") ?? 0,
        failed: phaseGates.get("failed") ?? 0, uncertain: phaseGates.get("uncertain") ?? 0,
      },
      artifacts: { total: this.total(artifacts), verified: artifacts.get("verified") ?? 0 },
      evaluations: {
        total: this.total(evaluations), succeeded: evaluations.get("succeeded") ?? 0,
        failed: evaluations.get("failed") ?? 0, blocked: evaluations.get("blocked") ?? 0,
        uncertain: evaluations.get("uncertain") ?? 0,
      },
      traces: { total: traceCount },
      unresolved: { activeAttempts, blockingDrifts, pendingConfirmations, pendingChanges },
    };
    const evidenceRefs = { phaseGateResultIds, evaluationIds, traceEventIds, artifactIds };
    const reportId = newId();
    const createdAt = nowIso();
    this.database.run(`
      INSERT INTO final_reports (
        id, project_id, tree_id, tree_revision_id, workflow_revision,
        root_phase_gate_result_id, status, summary_json, evidence_refs_json,
        idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)
    `, reportId, input.projectId, input.treeId, tree.current_revision_id, workflow.revision,
    rootGate!.id, canonicalJson(summary), canonicalJson(evidenceRefs), input.idempotencyKey, createdAt);
    this.database.run(
      "UPDATE task_trees SET status = 'completed', updated_at = ? WHERE id = ?",
      createdAt, input.treeId,
    );
    this.database.run(
      "UPDATE workflow_states SET active = 0, updated_at = ? WHERE id = ?",
      createdAt, workflow.id,
    );
    return {
      reportId, projectId: input.projectId, treeId: input.treeId,
      treeRevisionId: tree.current_revision_id, workflowRevision: workflow.revision,
      rootPhaseGateResultId: rootGate!.id, status: "completed" as const,
      summary, evidenceRefs, idempotencyKey: input.idempotencyKey, createdAt, created: true,
    };
  }

  private count(sql: string, ...params: string[]): number {
    return this.database.get<{ count: number }>(sql, ...params)?.count ?? 0;
  }

  private ids(sql: string, ...params: string[]): string[] {
    return this.database.all<{ id: string }>(sql, ...params).map((row) => row.id);
  }

  private statusCounts(sql: string, ...params: string[]): Map<string, number> {
    return new Map(this.database.all<StatusCountRow>(sql, ...params).map((row) => [row.status, row.count]));
  }

  private total(counts: Map<string, number>): number {
    return [...counts.values()].reduce((total, count) => total + count, 0);
  }

  private view(row: FinalReportRow, created: boolean) {
    return {
      reportId: row.id, projectId: row.project_id, treeId: row.tree_id,
      treeRevisionId: row.tree_revision_id, workflowRevision: row.workflow_revision,
      rootPhaseGateResultId: row.root_phase_gate_result_id, status: row.status,
      summary: JSON.parse(row.summary_json) as Record<string, unknown>,
      evidenceRefs: JSON.parse(row.evidence_refs_json) as Record<string, unknown>,
      idempotencyKey: row.idempotency_key, createdAt: row.created_at, created,
    };
  }
}
