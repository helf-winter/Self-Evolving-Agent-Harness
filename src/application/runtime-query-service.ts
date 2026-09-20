import { HarnessError } from "../domain/errors.js";
import type { TaskNodeInput, TaskTreeDocument } from "../domain/task-tree.js";
import type { RuntimeDatabase } from "../storage/database.js";
import type { PlanDriftResolutionStatus, PlanDriftSeverity } from "./plan-drift-service.js";
import type { UserChangeType } from "../domain/runtime-action.js";
import type { FailureAvailabilityStatus, FailureMaturityLevel } from "../domain/failure-case.js";

interface TraceRow {
  id: string;
  tree_id: string | null;
  node_id: string | null;
  session_id: string;
  event_name: string;
  payload_json: string;
  occurred_at: string;
}

interface ArtifactRow {
  id: string;
  tree_id: string | null;
  kind: string;
  locator: string;
  status: string;
  metadata_json: string;
  granularity: string;
  artifact_type: string;
  path_or_name: string | null;
  parent_artifact_id: string | null;
  identity_strategy: string;
  confidence: string;
  planned_by_task_node_id: string | null;
  plan_baseline_at: string | null;
  current_hash_or_version: string | null;
  source_trace_event_id: string | null;
  source_planning_revision_id: string | null;
  created_at: string;
  updated_at: string;
}

interface DriftRow {
  id: string;
  tree_id: string;
  task_node_id: string | null;
  planned_artifact_id: string | null;
  actual_artifact_id: string | null;
  drift_type: string;
  severity: string;
  trace_event_id: string;
  drift_explanation: string;
  agent_recommendation: string | null;
  resolution_status: string;
  user_decision: string | null;
  description: string;
  created_at: string;
}

interface UserChangeRow {
  id: string;
  tree_id: string;
  task_node_id: string | null;
  change_type: UserChangeType;
  source_trace_event_id: string;
  expected_tree_revision_id: string;
  summary: string;
  change_impact_json: string;
  proposed_document_json: string | null;
  priority_target_node_id: string | null;
  prior_node_status: string | null;
  status: string;
  runtime_action_id: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
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
    const driftCounts = this.getDriftCounts(projectId, state?.selected_tree_id ?? workflow?.tree_id ?? null);
    const pendingConfirmationCount = this.database.get<{ count: number }>(
      "SELECT count(*) AS count FROM runtime_confirmation_prompts WHERE project_id = ? AND status = 'pending'",
      projectId,
    )?.count ?? 0;
    return {
      projectId,
      selectedTreeId: state?.selected_tree_id ?? null,
      selectedNodeId: state?.selected_node_id ?? null,
      workflow: workflow ? { treeId: workflow.tree_id, stage: workflow.stage, revision: workflow.revision } : null,
      pendingConfirmation: confirmation ? { confirmationId: confirmation.id, scopeId: confirmation.scope_id, prompt: confirmation.prompt } : null,
      pendingConfirmationCount,
      blockerCount: readiness ? (JSON.parse(readiness.blockers_json) as unknown[]).length : 0,
      activeAttemptCount,
      confirmationCounts,
      driftCounts,
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
    const artifactCounts = { total: artifacts.length };
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
      artifactCounts,
      driftCounts: this.getDriftCounts(projectId, treeId),
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

  getArtifactGraphSummary(projectId: string, query: { limit?: number; cursor?: string; treeId?: string }) {
    this.requireProject(projectId);
    if (query.treeId) this.requireTree(projectId, query.treeId);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = decodeCursor(query.cursor);
    const filters = ["project_id = ?"];
    const params: Array<string | number> = [projectId];
    if (query.treeId) { filters.push("tree_id = ?"); params.push(query.treeId); }
    const rows = this.database.all<ArtifactRow>(`
      SELECT id, tree_id, kind, locator, status, metadata_json, granularity, artifact_type, path_or_name,
             parent_artifact_id, identity_strategy, confidence, planned_by_task_node_id, plan_baseline_at,
             current_hash_or_version, source_trace_event_id, source_planning_revision_id, created_at, updated_at
      FROM artifacts WHERE ${filters.join(" AND ")}
      ORDER BY locator, id LIMIT ? OFFSET ?
    `, ...params, limit + 1, offset);
    const selected = rows.slice(0, limit);
    const associations = this.getArtifactAssociations(projectId, selected.map((row) => row.id));
    return {
      projectId,
      treeId: query.treeId ?? null,
      items: selected.map((row) => this.mapArtifact(row)),
      ...associations,
      nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
    };
  }

  getArtifactDetail(projectId: string, artifactId: string) {
    this.requireProject(projectId);
    const row = this.database.get<ArtifactRow>(`
      SELECT id, tree_id, kind, locator, status, metadata_json, granularity, artifact_type, path_or_name,
             parent_artifact_id, identity_strategy, confidence, planned_by_task_node_id, plan_baseline_at,
             current_hash_or_version, source_trace_event_id, source_planning_revision_id, created_at, updated_at
      FROM artifacts WHERE id = ? AND project_id = ?
    `, artifactId, projectId);
    if (!row) throw new HarnessError("not_found", "Artifact was not found in the current project");
    const associations = this.getArtifactAssociations(projectId, [artifactId]);
    const driftRows = this.database.all<DriftRow>(`
      SELECT id, tree_id, task_node_id, planned_artifact_id, actual_artifact_id, drift_type, severity,
             trace_event_id, drift_explanation, agent_recommendation, resolution_status, user_decision,
             description, created_at
      FROM plan_drift_records
      WHERE project_id = ? AND (planned_artifact_id = ? OR actual_artifact_id = ?)
      ORDER BY created_at DESC, id DESC
    `, projectId, artifactId, artifactId);
    const drifts = driftRows.map((drift) => this.mapDrift(drift));
    const traceEventIds = [...new Set([
      row.source_trace_event_id,
      ...associations.relations.map((relation) => relation.sourceTraceEventId),
      ...drifts.map((drift) => drift.traceEventId),
    ].filter((value): value is string => Boolean(value)))];
    return { artifact: this.mapArtifact(row), ...associations, drifts, traceEventIds };
  }

  getPlanDriftSummary(projectId: string, query: {
    treeId?: string;
    nodeId?: string;
    severity?: PlanDriftSeverity;
    resolutionStatus?: PlanDriftResolutionStatus;
    limit?: number;
    cursor?: string;
  }) {
    this.requireProject(projectId);
    if (query.treeId) this.requireTree(projectId, query.treeId);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = decodeCursor(query.cursor);
    const filters = ["project_id = ?"];
    const params: Array<string | number> = [projectId];
    if (query.treeId) { filters.push("tree_id = ?"); params.push(query.treeId); }
    if (query.nodeId) { filters.push("task_node_id = ?"); params.push(query.nodeId); }
    if (query.severity) { filters.push("severity = ?"); params.push(query.severity); }
    if (query.resolutionStatus) { filters.push("resolution_status = ?"); params.push(query.resolutionStatus); }
    const rows = this.database.all<DriftRow>(`
      SELECT id, tree_id, task_node_id, planned_artifact_id, actual_artifact_id, drift_type, severity,
             trace_event_id, drift_explanation, agent_recommendation, resolution_status, user_decision,
             description, created_at
      FROM plan_drift_records WHERE ${filters.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `, ...params, limit + 1, offset);
    return {
      items: rows.slice(0, limit).map((row) => this.mapDrift(row)),
      nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
    };
  }

  getWaitingItems(projectId: string, query: { promptType?: string; limit?: number; cursor?: string }) {
    this.requireProject(projectId);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = decodeCursor(query.cursor);
    const filters = ["c.project_id = ?", "c.status = 'pending'"];
    const params: Array<string | number> = [projectId];
    if (query.promptType) { filters.push("c.prompt_type = ?"); params.push(query.promptType); }
    const rows = this.database.all<{
      id: string; tree_id: string | null; scope_id: string; prompt: string; prompt_type: string;
      related_task_node_id: string | null; related_artifact_ids_json: string; options_json: string;
      runtime_action_id: string | null; action_status: string | null; created_at: string;
    }>(`
      SELECT c.id, c.tree_id, c.scope_id, c.prompt, c.prompt_type, c.related_task_node_id,
             c.related_artifact_ids_json, c.options_json, c.runtime_action_id,
             a.status AS action_status, c.created_at
      FROM runtime_confirmation_prompts c
      LEFT JOIN runtime_actions a ON a.id = c.runtime_action_id AND a.project_id = c.project_id
      WHERE ${filters.join(" AND ")}
      ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?
    `, ...params, limit + 1, offset);
    return {
      items: rows.slice(0, limit).map((row) => ({
        confirmationId: row.id, treeId: row.tree_id, scopeId: row.scope_id, prompt: row.prompt,
        promptType: row.prompt_type, relatedTaskNodeId: row.related_task_node_id,
        relatedArtifactIds: JSON.parse(row.related_artifact_ids_json) as string[],
        options: JSON.parse(row.options_json) as string[], runtimeActionId: row.runtime_action_id,
        actionStatus: row.action_status, createdAt: row.created_at,
      })),
      nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
    };
  }

  getUserChangeRequests(projectId: string, query: {
    treeId?: string;
    nodeId?: string;
    changeType?: UserChangeType;
    status?: string;
    limit?: number;
    cursor?: string;
  }) {
    this.requireProject(projectId);
    if (query.treeId) this.requireTree(projectId, query.treeId);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = decodeCursor(query.cursor);
    const filters = ["project_id = ?"];
    const params: Array<string | number> = [projectId];
    if (query.treeId) { filters.push("tree_id = ?"); params.push(query.treeId); }
    if (query.nodeId) { filters.push("task_node_id = ?"); params.push(query.nodeId); }
    if (query.changeType) { filters.push("change_type = ?"); params.push(query.changeType); }
    if (query.status) { filters.push("status = ?"); params.push(query.status); }
    const rows = this.database.all<UserChangeRow>(`
      SELECT id, tree_id, task_node_id, change_type, source_trace_event_id, expected_tree_revision_id,
             summary, change_impact_json, proposed_document_json, priority_target_node_id,
             prior_node_status, status, runtime_action_id, created_at, updated_at, resolved_at
      FROM user_change_requests WHERE ${filters.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `, ...params, limit + 1, offset);
    return {
      items: rows.slice(0, limit).map((row) => this.mapUserChange(row)),
      nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
    };
  }

  getRuntimeActionDetail(projectId: string, actionId: string) {
    this.requireProject(projectId);
    const action = this.database.get<{
      id: string; action_type: string | null; target_type: string | null; target_id: string | null;
      expected_revision: string | null; reason: string | null; source_message_ref: string | null;
      risk_level: string; confirmation_requirement: string; confirmation_prompt_id: string | null;
      status: string; input_json: string; result_json: string; created_at: string; committed_at: string | null;
    }>(`
      SELECT id, action_type, target_type, target_id, expected_revision, reason, source_message_ref,
             risk_level, confirmation_requirement, confirmation_prompt_id, status,
             input_json, result_json, created_at, committed_at
      FROM runtime_actions WHERE id = ? AND project_id = ?
    `, actionId, projectId);
    if (!action) throw new HarnessError("not_found", "Runtime Action was not found in the current project");
    const confirmation = this.database.get<{
      id: string; tree_id: string | null; scope_id: string; prompt: string; prompt_type: string;
      related_task_node_id: string | null; related_artifact_ids_json: string; options_json: string;
      status: string; answer: string | null; answer_trace_event_id: string | null; created_at: string; resolved_at: string | null;
    }>(`
      SELECT id, tree_id, scope_id, prompt, prompt_type, related_task_node_id,
             related_artifact_ids_json, options_json, status, answer, answer_trace_event_id, created_at, resolved_at
      FROM runtime_confirmation_prompts WHERE runtime_action_id = ? AND project_id = ?
    `, actionId, projectId);
    const change = this.database.get<UserChangeRow>(
      "SELECT * FROM user_change_requests WHERE runtime_action_id = ? AND project_id = ?", actionId, projectId,
    );
    const drift = action.target_type === "plan_drift" && action.target_id
      ? this.database.get<DriftRow>(`
          SELECT id, tree_id, task_node_id, planned_artifact_id, actual_artifact_id, drift_type, severity,
                 trace_event_id, drift_explanation, agent_recommendation, resolution_status, user_decision,
                 description, created_at
          FROM plan_drift_records WHERE id = ? AND project_id = ?
        `, action.target_id, projectId)
      : undefined;
    return {
      action: {
        actionId: action.id, actionType: action.action_type, targetType: action.target_type, targetId: action.target_id,
        expectedRevision: action.expected_revision, reason: action.reason, sourceMessageRef: action.source_message_ref,
        riskLevel: action.risk_level, confirmationRequirement: action.confirmation_requirement,
        confirmationId: action.confirmation_prompt_id, status: action.status,
        input: JSON.parse(action.input_json) as unknown, result: JSON.parse(action.result_json) as unknown,
        createdAt: action.created_at, committedAt: action.committed_at,
      },
      confirmation: confirmation ? {
        confirmationId: confirmation.id, treeId: confirmation.tree_id, scopeId: confirmation.scope_id,
        prompt: confirmation.prompt, promptType: confirmation.prompt_type,
        relatedTaskNodeId: confirmation.related_task_node_id,
        relatedArtifactIds: JSON.parse(confirmation.related_artifact_ids_json) as string[],
        options: JSON.parse(confirmation.options_json) as string[], status: confirmation.status,
        answer: confirmation.answer, answerTraceEventId: confirmation.answer_trace_event_id,
        createdAt: confirmation.created_at, resolvedAt: confirmation.resolved_at,
      } : null,
      userChange: change ? this.mapUserChange(change) : null,
      planDrift: drift ? this.mapDrift(drift) : null,
    };
  }

  getFailureCases(projectId: string, query: {
    treeId?: string;
    nodeId?: string;
    maturityLevel?: FailureMaturityLevel;
    availabilityStatus?: FailureAvailabilityStatus;
    limit?: number;
    cursor?: string;
  }) {
    this.requireProject(projectId);
    if (query.treeId) this.requireTree(projectId, query.treeId);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = decodeCursor(query.cursor);
    const filters = ["f.project_id = ?"];
    const params: Array<string | number> = [projectId];
    if (query.treeId) { filters.push("f.tree_id = ?"); params.push(query.treeId); }
    if (query.nodeId) { filters.push("f.source_task_node_id = ?"); params.push(query.nodeId); }
    if (query.maturityLevel) { filters.push("f.maturity_level = ?"); params.push(query.maturityLevel); }
    if (query.availabilityStatus) { filters.push("f.availability_status = ?"); params.push(query.availabilityStatus); }
    const rows = this.database.all<{
      id: string; tree_id: string; source_task_node_id: string | null; source_execution_attempt_id: string;
      source_evaluation_id: string; failure_goal: string; failure_signature: string;
      maturity_level: FailureMaturityLevel; availability_status: FailureAvailabilityStatus;
      current_reproduction_revision_id: string | null; related_artifact_ids_json: string;
      created_at: string; updated_at: string; occurrence_count: number; revision_count: number;
    }>(`
      SELECT f.id, f.tree_id, f.source_task_node_id, f.source_execution_attempt_id,
             f.source_evaluation_id, f.failure_goal, f.failure_signature, f.maturity_level,
             f.availability_status, f.current_reproduction_revision_id, f.related_artifact_ids_json,
             f.created_at, f.updated_at,
             (SELECT count(*) FROM failure_case_occurrences o WHERE o.failure_case_id = f.id) AS occurrence_count,
             (SELECT count(*) FROM failure_reproduction_revisions r WHERE r.failure_case_id = f.id) AS revision_count
      FROM failure_cases f WHERE ${filters.join(" AND ")}
      ORDER BY f.updated_at DESC, f.id DESC LIMIT ? OFFSET ?
    `, ...params, limit + 1, offset);
    return {
      items: rows.slice(0, limit).map((row) => ({
        failureCaseId: row.id, treeId: row.tree_id, sourceNodeId: row.source_task_node_id,
        sourceAttemptId: row.source_execution_attempt_id, sourceEvaluationId: row.source_evaluation_id,
        failureGoal: row.failure_goal, failureSignature: JSON.parse(row.failure_signature) as unknown,
        maturityLevel: row.maturity_level, availabilityStatus: row.availability_status,
        currentReproductionRevisionId: row.current_reproduction_revision_id,
        relatedArtifactIds: JSON.parse(row.related_artifact_ids_json) as string[],
        occurrenceCount: row.occurrence_count, revisionCount: row.revision_count,
        createdAt: row.created_at, updatedAt: row.updated_at,
      })),
      nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
    };
  }

  getFailureCaseDetail(projectId: string, failureCaseId: string) {
    this.requireProject(projectId);
    const failure = this.database.get<{
      id: string; tree_id: string; source_task_node_id: string | null; source_execution_attempt_id: string;
      source_evaluation_id: string; failure_goal: string; failure_signature: string;
      maturity_level: FailureMaturityLevel; availability_status: FailureAvailabilityStatus;
      current_reproduction_revision_id: string | null; related_artifact_ids_json: string;
      created_at: string; updated_at: string;
    }>(`
      SELECT id, tree_id, source_task_node_id, source_execution_attempt_id, source_evaluation_id,
             failure_goal, failure_signature, maturity_level, availability_status,
             current_reproduction_revision_id, related_artifact_ids_json, created_at, updated_at
      FROM failure_cases WHERE id = ? AND project_id = ?
    `, failureCaseId, projectId);
    if (!failure) throw new HarnessError("not_found", "Failure Case was not found in this Project");
    const occurrences = this.database.all<{
      id: string; execution_attempt_id: string; evaluation_id: string; evidence_refs_json: string; created_at: string;
    }>(`
      SELECT id, execution_attempt_id, evaluation_id, evidence_refs_json, created_at
      FROM failure_case_occurrences WHERE failure_case_id = ? AND project_id = ?
      ORDER BY created_at, id
    `, failureCaseId, projectId).map((row) => ({
      occurrenceId: row.id, attemptId: row.execution_attempt_id, evaluationId: row.evaluation_id,
      evidenceRefs: JSON.parse(row.evidence_refs_json) as string[], createdAt: row.created_at,
    }));
    const revisions = this.database.all<{
      id: string; revision_number: number; reproduction_mode: string; contract_json: string;
      validation_status: string; created_at: string;
    }>(`
      SELECT id, revision_number, reproduction_mode, contract_json, validation_status, created_at
      FROM failure_reproduction_revisions WHERE failure_case_id = ? AND project_id = ?
      ORDER BY revision_number
    `, failureCaseId, projectId).map((row) => ({
      reproductionRevisionId: row.id, revisionNumber: row.revision_number, mode: row.reproduction_mode,
      contract: JSON.parse(row.contract_json) as unknown, validationStatus: row.validation_status, createdAt: row.created_at,
    }));
    const validations = this.database.all<{
      id: string; reproduction_revision_id: string; observation_json: string; evidence_refs_json: string;
      maturity_promotion_verdict: string; rejection_reasons_json: string; created_at: string;
    }>(`
      SELECT id, reproduction_revision_id, observation_json, evidence_refs_json,
             maturity_promotion_verdict, rejection_reasons_json, created_at
      FROM reproduction_validation_results WHERE failure_case_id = ? AND project_id = ?
      ORDER BY created_at, id
    `, failureCaseId, projectId).map((row) => ({
      validationResultId: row.id, reproductionRevisionId: row.reproduction_revision_id,
      observation: JSON.parse(row.observation_json) as unknown,
      evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
      promotedMaturity: row.maturity_promotion_verdict,
      rejectionReasons: JSON.parse(row.rejection_reasons_json) as string[], createdAt: row.created_at,
    }));
    const artifactIds = JSON.parse(failure.related_artifact_ids_json) as string[];
    const relatedArtifacts = artifactIds.length === 0 ? [] : this.database.all<{
      id: string; artifact_type: string; granularity: string; locator: string; status: string;
    }>(`
      SELECT id, artifact_type, granularity, locator, status FROM artifacts
      WHERE project_id = ? AND id IN (${artifactIds.map(() => "?").join(", ")}) ORDER BY id
    `, projectId, ...artifactIds).map((row) => ({
      artifactId: row.id, artifactType: row.artifact_type, granularity: row.granularity,
      locator: row.locator, status: row.status,
    }));
    return {
      failureCase: {
        failureCaseId: failure.id, treeId: failure.tree_id, sourceNodeId: failure.source_task_node_id,
        sourceAttemptId: failure.source_execution_attempt_id, sourceEvaluationId: failure.source_evaluation_id,
        failureGoal: failure.failure_goal, failureSignature: JSON.parse(failure.failure_signature) as unknown,
        maturityLevel: failure.maturity_level, availabilityStatus: failure.availability_status,
        currentReproductionRevisionId: failure.current_reproduction_revision_id,
        relatedArtifactIds: artifactIds, createdAt: failure.created_at, updatedAt: failure.updated_at,
      },
      occurrences,
      reproductionRevisions: revisions,
      validationResults: validations,
      relatedArtifacts,
    };
  }

  private requireProject(projectId: string): void {
    if (!this.database.get("SELECT id FROM projects WHERE id = ?", projectId)) throw new HarnessError("not_found", "project was not found");
  }

  private requireTree(projectId: string, treeId: string): void {
    if (!this.database.get("SELECT id FROM task_trees WHERE id = ? AND project_id = ?", treeId, projectId)) {
      throw new HarnessError("not_found", "Task Tree was not found in the current project");
    }
  }

  private mapArtifact(row: ArtifactRow) {
    return {
      artifactId: row.id,
      treeId: row.tree_id,
      kind: row.kind,
      locator: row.locator,
      status: row.status,
      metadata: JSON.parse(row.metadata_json) as unknown,
      granularity: row.granularity,
      artifactType: row.artifact_type,
      pathOrName: row.path_or_name,
      parentArtifactId: row.parent_artifact_id,
      identityStrategy: row.identity_strategy,
      confidence: row.confidence,
      plannedByTaskNodeId: row.planned_by_task_node_id,
      planBaselineAt: row.plan_baseline_at,
      currentHashOrVersion: row.current_hash_or_version,
      sourceTraceEventId: row.source_trace_event_id,
      sourcePlanningRevisionId: row.source_planning_revision_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapDrift(row: DriftRow) {
    return {
      driftId: row.id,
      treeId: row.tree_id,
      nodeId: row.task_node_id,
      plannedArtifactId: row.planned_artifact_id,
      actualArtifactId: row.actual_artifact_id,
      driftType: row.drift_type,
      severity: row.severity,
      traceEventId: row.trace_event_id,
      explanation: row.drift_explanation,
      recommendation: row.agent_recommendation,
      resolutionStatus: row.resolution_status,
      userDecision: row.user_decision,
      description: row.description,
      createdAt: row.created_at,
    };
  }

  private mapUserChange(row: UserChangeRow) {
    return {
      userChangeId: row.id, treeId: row.tree_id, nodeId: row.task_node_id, changeType: row.change_type,
      sourceTraceEventId: row.source_trace_event_id, expectedTreeRevisionId: row.expected_tree_revision_id,
      summary: row.summary, changeImpact: JSON.parse(row.change_impact_json) as unknown,
      proposedDocument: row.proposed_document_json ? JSON.parse(row.proposed_document_json) as unknown : null,
      priorityTargetNodeId: row.priority_target_node_id, priorNodeStatus: row.prior_node_status,
      status: row.status, runtimeActionId: row.runtime_action_id,
      createdAt: row.created_at, updatedAt: row.updated_at, resolvedAt: row.resolved_at,
    };
  }

  private getArtifactAssociations(projectId: string, artifactIds: string[]) {
    if (artifactIds.length === 0) return { taskLinks: [], relations: [], contracts: [] };
    const placeholders = artifactIds.map(() => "?").join(", ");
    const taskLinks = this.database.all<{
      id: string; tree_id: string; tree_revision_id: string; task_node_id: string;
      task_node_revision_id: string; artifact_id: string; relation_type: string; source_planning_revision_id: string;
    }>(`
      SELECT l.id, l.tree_id, l.tree_revision_id, l.task_node_id, l.task_node_revision_id,
             l.artifact_id, l.relation_type, l.source_planning_revision_id
      FROM task_node_artifact_links l
      JOIN task_trees t ON t.id = l.tree_id AND t.current_revision_id = l.tree_revision_id
      WHERE l.project_id = ? AND l.artifact_id IN (${placeholders})
      ORDER BY l.task_node_id, l.artifact_id, l.relation_type
    `, projectId, ...artifactIds).map((row) => ({
      linkId: row.id, treeId: row.tree_id, treeRevisionId: row.tree_revision_id, nodeId: row.task_node_id,
      nodeRevisionId: row.task_node_revision_id, artifactId: row.artifact_id, relationType: row.relation_type,
      sourcePlanningRevisionId: row.source_planning_revision_id,
    }));
    const relationRows = this.database.all<{
      id: string; tree_id: string | null; tree_revision_id: string | null; from_artifact_id: string;
      to_artifact_id: string; kind: string; source_trace_event_id: string | null; source_planning_revision_id: string | null;
    }>(`
      SELECT r.id, r.tree_id, r.tree_revision_id, r.from_artifact_id, r.to_artifact_id, r.kind,
             r.source_trace_event_id, r.source_planning_revision_id
      FROM artifact_graph_relations r
      WHERE r.project_id = ? AND (r.from_artifact_id IN (${placeholders}) OR r.to_artifact_id IN (${placeholders}))
        AND (r.tree_revision_id IS NULL OR r.tree_revision_id IN (
          SELECT current_revision_id FROM task_trees WHERE project_id = ?
        ))
      ORDER BY r.from_artifact_id, r.to_artifact_id, r.kind
    `, projectId, ...artifactIds, ...artifactIds, projectId);
    const relations = relationRows.map((row) => ({
      relationId: row.id, treeId: row.tree_id, treeRevisionId: row.tree_revision_id,
      fromArtifactId: row.from_artifact_id, toArtifactId: row.to_artifact_id, kind: row.kind,
      sourceTraceEventId: row.source_trace_event_id, sourcePlanningRevisionId: row.source_planning_revision_id,
    }));
    const contracts = this.database.all<{
      contract_id: string; tree_id: string; tree_revision_id: string; artifact_id: string; contract_name: string;
      contract_version: string; compatibility_policy: string; schema_or_signature: string;
      provider_revision_ids_json: string; consumer_revision_ids_json: string; validation_refs_json: string;
    }>(`
      SELECT c.contract_id, c.tree_id, c.tree_revision_id, c.artifact_id, c.contract_name,
             c.contract_version, c.compatibility_policy, c.schema_or_signature,
             c.provider_revision_ids_json, c.consumer_revision_ids_json, c.validation_refs_json
      FROM artifact_contracts c
      JOIN task_trees t ON t.id = c.tree_id AND t.current_revision_id = c.tree_revision_id
      WHERE c.project_id = ? AND c.artifact_id IN (${placeholders})
      ORDER BY c.contract_name, c.contract_id
    `, projectId, ...artifactIds).map((row) => ({
      contractId: row.contract_id, treeId: row.tree_id, treeRevisionId: row.tree_revision_id,
      artifactId: row.artifact_id, name: row.contract_name, version: row.contract_version,
      compatibilityPolicy: row.compatibility_policy, schemaOrSignature: row.schema_or_signature,
      providerNodeRevisionIds: JSON.parse(row.provider_revision_ids_json) as string[],
      consumerNodeRevisionIds: JSON.parse(row.consumer_revision_ids_json) as string[],
      validationRefs: JSON.parse(row.validation_refs_json) as string[],
    }));
    return { taskLinks, relations, contracts };
  }

  private getDriftCounts(projectId: string, treeId: string | null) {
    const filters = ["project_id = ?", "severity IN ('warning', 'blocking')"];
    const params: string[] = [projectId];
    if (treeId) { filters.push("tree_id = ?"); params.push(treeId); }
    const rows = this.database.all<{ severity: string; count: number }>(`
      SELECT severity, count(*) AS count FROM plan_drift_records
      WHERE ${filters.join(" AND ")}
        AND (severity = 'warning' OR resolution_status = 'pending_user_confirmation')
      GROUP BY severity
    `, ...params);
    const counts = { warning: 0, blocking: 0 };
    for (const row of rows) {
      if (row.severity === "warning") counts.warning = row.count;
      else if (row.severity === "blocking") counts.blocking = row.count;
    }
    return counts;
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
