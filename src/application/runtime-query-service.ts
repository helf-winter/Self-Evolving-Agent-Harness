import { HarnessError } from "../domain/errors.js";
import type { TaskNodeInput, TaskTreeDocument } from "../domain/task-tree.js";
import type { RuntimeDatabase } from "../storage/database.js";

interface TraceRow {
  id: string;
  tree_id: string | null;
  node_id: string | null;
  session_id: string;
  event_name: string;
  payload_json: string;
  occurred_at: string;
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(value) || value < 0) throw new HarnessError("invalid_input", "invalid pagination cursor");
  return value;
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset)).toString("base64url");
}

export class RuntimeQueryService {
  constructor(private readonly database: RuntimeDatabase) {}

  getRuntimeSnapshot(projectId: string) {
    this.requireProject(projectId);
    const state = this.database.get<{ selected_tree_id: string | null; selected_node_id: string | null }>(
      "SELECT selected_tree_id, selected_node_id FROM runtime_states WHERE project_id = ?", projectId,
    );
    const workflow = this.database.get<{ tree_id: string; stage: string; revision: number }>(
      "SELECT tree_id, stage, revision FROM workflow_states WHERE project_id = ? AND active = 1", projectId,
    );
    const confirmation = this.database.get<{ id: string; scope_id: string; prompt: string }>(
      "SELECT id, scope_id, prompt FROM runtime_confirmation_prompts WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1", projectId,
    );
    const readiness = workflow
      ? this.database.get<{ blockers_json: string }>("SELECT blockers_json FROM plan_readiness_results WHERE tree_id = ? ORDER BY created_at DESC LIMIT 1", workflow.tree_id)
      : undefined;
    const activeAttemptCount = this.database.get<{ count: number }>(
      "SELECT count(*) AS count FROM execution_attempts WHERE project_id = ? AND status IN ('running', 'verifying')",
      projectId,
    )?.count ?? 0;
    const confirmationCounts = this.getConfirmationCounts(projectId, state?.selected_tree_id ?? workflow?.tree_id ?? null);
    return {
      projectId,
      selectedTreeId: state?.selected_tree_id ?? null,
      selectedNodeId: state?.selected_node_id ?? null,
      workflow: workflow ? { treeId: workflow.tree_id, stage: workflow.stage, revision: workflow.revision } : null,
      pendingConfirmation: confirmation ? { confirmationId: confirmation.id, scopeId: confirmation.scope_id, prompt: confirmation.prompt } : null,
      blockerCount: readiness ? (JSON.parse(readiness.blockers_json) as unknown[]).length : 0,
      activeAttemptCount,
      confirmationCounts,
      availableActions: this.availableActions(workflow?.stage),
    };
  }

  getTaskTreeSummary(projectId: string, treeId: string) {
    const tree = this.database.get<{ id: string; title: string; status: string; current_revision_id: string }>(
      "SELECT id, title, status, current_revision_id FROM task_trees WHERE id = ? AND project_id = ?", treeId, projectId,
    );
    if (!tree) throw new HarnessError("not_found", "Task Tree was not found in the current project");
    const revision = this.database.get<{ revision: number; document_json: string }>("SELECT revision, document_json FROM task_tree_revisions WHERE id = ?", tree.current_revision_id)!;
    const document = JSON.parse(revision.document_json) as TaskTreeDocument;
    const artifacts = this.database.all<{ id: string; kind: string; locator: string; status: string }>(
      "SELECT id, kind, locator, status FROM artifacts WHERE project_id = ? AND tree_id = ? ORDER BY kind, locator", projectId, treeId,
    );
    const count = this.database.get<{ count: number }>("SELECT count(*) AS count FROM trace_events WHERE project_id = ? AND tree_id = ?", projectId, treeId)?.count ?? 0;
    const attemptCount = this.database.get<{ count: number }>("SELECT count(*) AS count FROM execution_attempts WHERE project_id = ? AND tree_id = ?", projectId, treeId)?.count ?? 0;
    const evaluationCount = this.database.get<{ count: number }>("SELECT count(*) AS count FROM evaluations WHERE project_id = ? AND tree_id = ?", projectId, treeId)?.count ?? 0;
    const confirmationRows = this.database.all<{ task_node_id: string; state: string }>(`
      SELECT task_node_id, state FROM task_node_confirmation_states
      WHERE tree_revision_id = ?
    `, tree.current_revision_id);
    const confirmationByNode = new Map(confirmationRows.map((row) => [row.task_node_id, row.state]));
    return {
      treeId: tree.id, title: tree.title, status: tree.status, revision: revision.revision,
      nodes: document.nodes.map((node) => ({
        id: node.id, parentId: node.parentId, title: node.title, children: node.children,
        confirmationState: confirmationByNode.get(node.id) ?? "draft",
      })),
      relations: document.relations,
      artifacts,
      traceCount: count,
      attemptCount,
      evaluationCount,
      confirmationCounts: this.getConfirmationCounts(projectId, treeId),
    };
  }

  getTaskNodeDetail(projectId: string, nodeId: string, options: {
    limit?: number;
    cursor?: string;
    attemptLimit?: number;
    attemptCursor?: string;
    evaluationLimit?: number;
    evaluationCursor?: string;
  }) {
    const row = this.database.get<{ tree_id: string; status: string; body_json: string; confirmation_state: string }>(
      `SELECT n.tree_id, n.status, nr.body_json, cs.state AS confirmation_state FROM task_nodes n
       JOIN task_trees t ON t.id = n.tree_id
       JOIN task_node_revisions nr ON nr.node_id = n.id
       JOIN task_tree_revisions tr ON tr.id = nr.tree_revision_id AND tr.id = t.current_revision_id
       JOIN task_node_confirmation_states cs ON cs.task_node_id = n.id AND cs.tree_revision_id = t.current_revision_id
       WHERE n.id = ? AND t.project_id = ?`, nodeId, projectId,
    );
    if (!row) throw new HarnessError("not_found", "Task Node was not found in the current project");
    const evidence = this.getTraceEvents(projectId, { ...options, nodeId });
    const attemptLimit = Math.min(Math.max(options.attemptLimit ?? 50, 1), 200);
    const attemptOffset = decodeCursor(options.attemptCursor);
    const attemptRows = this.database.all<{
      id: string; task_node_revision_id: string; attempt_number: number; status: string; started_at: string; completed_at: string | null;
    }>(`
      SELECT id, task_node_revision_id, attempt_number, status, started_at, completed_at
      FROM execution_attempts WHERE project_id = ? AND task_node_id = ?
      ORDER BY attempt_number DESC LIMIT ? OFFSET ?
    `, projectId, nodeId, attemptLimit + 1, attemptOffset);
    const attempts = attemptRows.slice(0, attemptLimit).map((attempt) => ({
      attemptId: attempt.id,
      nodeRevisionId: attempt.task_node_revision_id,
      attemptNumber: attempt.attempt_number,
      status: attempt.status,
      startedAt: attempt.started_at,
      completedAt: attempt.completed_at,
    }));
    const evaluationLimit = Math.min(Math.max(options.evaluationLimit ?? 50, 1), 200);
    const evaluationOffset = decodeCursor(options.evaluationCursor);
    const evaluationRows = this.database.all<{
      id: string; execution_attempt_id: string; task_node_revision_id: string; verdict: string;
      evidence_refs_json: string; covered_required_evidence_json: string; missing_required_evidence_json: string;
      risk_summary: string; created_at: string;
    }>(`
      SELECT id, execution_attempt_id, task_node_revision_id, verdict, evidence_refs_json,
             covered_required_evidence_json, missing_required_evidence_json, risk_summary, created_at
      FROM evaluations WHERE project_id = ? AND task_node_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `, projectId, nodeId, evaluationLimit + 1, evaluationOffset);
    const evaluations = evaluationRows.slice(0, evaluationLimit).map((evaluation) => ({
      evaluationId: evaluation.id,
      attemptId: evaluation.execution_attempt_id,
      nodeRevisionId: evaluation.task_node_revision_id,
      verdict: evaluation.verdict,
      evidenceRefs: JSON.parse(evaluation.evidence_refs_json) as string[],
      coveredRequiredEvidence: JSON.parse(evaluation.covered_required_evidence_json) as string[],
      missingRequiredEvidence: JSON.parse(evaluation.missing_required_evidence_json) as string[],
      riskSummary: evaluation.risk_summary || null,
      createdAt: evaluation.created_at,
    }));
    return {
      treeId: row.tree_id,
      status: row.status,
      confirmationState: row.confirmation_state,
      node: JSON.parse(row.body_json) as TaskNodeInput,
      attempts,
      attemptNextCursor: attemptRows.length > attemptLimit ? encodeCursor(attemptOffset + attemptLimit) : null,
      evaluations,
      evaluationNextCursor: evaluationRows.length > evaluationLimit ? encodeCursor(evaluationOffset + evaluationLimit) : null,
      evidence: evidence.items,
      nextCursor: evidence.nextCursor,
    };
  }

  getTraceEvents(projectId: string, query: { limit?: number; cursor?: string; treeId?: string; nodeId?: string }) {
    this.requireProject(projectId);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = decodeCursor(query.cursor);
    const filters = ["project_id = ?"];
    const params: Array<string | number> = [projectId];
    if (query.treeId) { filters.push("tree_id = ?"); params.push(query.treeId); }
    if (query.nodeId) { filters.push("node_id = ?"); params.push(query.nodeId); }
    const rows = this.database.all<TraceRow>(
      `SELECT id, tree_id, node_id, session_id, event_name, payload_json, occurred_at
       FROM trace_events WHERE ${filters.join(" AND ")} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`,
      ...params, limit + 1, offset,
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => ({
      eventId: row.id, treeId: row.tree_id, nodeId: row.node_id, sessionId: row.session_id,
      eventName: row.event_name, payload: JSON.parse(row.payload_json) as unknown, occurredAt: row.occurred_at,
    }));
    return { items, nextCursor: hasMore ? encodeCursor(offset + limit) : null };
  }

  private requireProject(projectId: string): void {
    if (!this.database.get("SELECT id FROM projects WHERE id = ?", projectId)) throw new HarnessError("not_found", "project was not found");
  }

  private getConfirmationCounts(projectId: string, treeId: string | null) {
    const counts = { draft: 0, pendingUserConfirmation: 0, confirmed: 0, partialConfirmed: 0 };
    if (!treeId) return counts;
    const rows = this.database.all<{ state: string; count: number }>(`
      SELECT cs.state, count(*) AS count
      FROM task_node_confirmation_states cs
      JOIN task_trees t ON t.id = cs.tree_id AND t.current_revision_id = cs.tree_revision_id
      WHERE cs.project_id = ? AND cs.tree_id = ?
      GROUP BY cs.state
    `, projectId, treeId);
    for (const row of rows) {
      if (row.state === "draft") counts.draft = row.count;
      else if (row.state === "pending_user_confirmation") counts.pendingUserConfirmation = row.count;
      else if (row.state === "confirmed") counts.confirmed = row.count;
      else if (row.state === "partial_confirmed") counts.partialConfirmed = row.count;
    }
    return counts;
  }

  private availableActions(stage?: string): string[] {
    if (!stage) return ["create_task_root"];
    if (stage === "draft_task_tree" || stage === "task_tree_refinement") return ["save_draft", "scan_readiness", "request_confirmation"];
    if (stage === "branch_confirmation") return ["confirm_scope", "refine_tree"];
    if (stage === "skeleton_pass") return ["execute_skeleton", "inspect_detail"];
    return ["inspect_detail", "record_evidence"];
  }
}
