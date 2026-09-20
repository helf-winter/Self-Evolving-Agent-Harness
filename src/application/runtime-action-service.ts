import { HarnessError } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
import {
  evaluateRuntimeActionSafety,
  type RuntimeConfirmationAnswer,
  type UserChangeType,
} from "../domain/runtime-action.js";
import { validateTaskTree, type TaskTreeDocument } from "../domain/task-tree.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";
import { PlanDriftService, type PlanDriftResolutionDecision } from "./plan-drift-service.js";
import { TaskTreeService } from "./task-tree-service.js";

interface DriftRow {
  id: string;
  tree_id: string;
  task_node_id: string | null;
  planned_artifact_id: string | null;
  actual_artifact_id: string | null;
  severity: string;
  resolution_status: string;
  agent_recommendation: string | null;
}

interface ConfirmationRow {
  id: string;
  project_id: string;
  tree_id: string;
  status: string;
  answer: string | null;
  answer_trace_event_id: string | null;
  created_at: string;
  prompt_type: string;
  runtime_action_id: string;
  action_type: "resolve_plan_drift" | "record_user_change";
  action_status: string;
  target_id: string;
  expected_revision: string;
  input_json: string;
  result_json: string;
}

export interface RuntimeActionView {
  actionId: string;
  actionType: "resolve_plan_drift" | "record_user_change";
  targetId: string;
  status: string;
  confirmationRequirement: "none" | "required";
  confirmationId: string | null;
  decision?: PlanDriftResolutionDecision;
  changeType?: UserChangeType;
  paused?: boolean;
}

export class RuntimeActionService {
  private readonly drifts: PlanDriftService;
  private readonly taskTrees: TaskTreeService;

  constructor(private readonly database: RuntimeDatabase, drifts?: PlanDriftService) {
    this.drifts = drifts ?? new PlanDriftService(database);
    this.taskTrees = new TaskTreeService(database);
  }

  proposePlanDriftResolution(input: {
    projectId: string;
    driftId: string;
    expectedTreeRevisionId: string;
    decision: PlanDriftResolutionDecision;
    reason: string;
    sourceMessageTraceEventId: string;
  }): RuntimeActionView & { confirmationId: string } {
    const safety = evaluateRuntimeActionSafety({
      actionType: "resolve_plan_drift",
      reason: input.reason,
      sourceMessageRef: input.sourceMessageTraceEventId,
    });
    const drift = this.database.get<DriftRow>(`
      SELECT id, tree_id, task_node_id, planned_artifact_id, actual_artifact_id,
             severity, resolution_status, agent_recommendation
      FROM plan_drift_records WHERE id = ? AND project_id = ?
    `, input.driftId, input.projectId);
    if (!drift) throw new HarnessError("not_found", "Plan Drift was not found in this Project");
    if (drift.severity !== "blocking" || drift.resolution_status !== "pending_user_confirmation" || !drift.task_node_id) {
      throw new HarnessError("confirmation_not_applicable", "only a pending blocking Plan Drift can be resolved");
    }
    const tree = this.database.get<{ current_revision_id: string }>(
      "SELECT current_revision_id FROM task_trees WHERE id = ? AND project_id = ?", drift.tree_id, input.projectId,
    );
    if (!tree) throw new HarnessError("not_found", "Task Tree was not found in this Project");
    if (tree.current_revision_id !== input.expectedTreeRevisionId) {
      throw new HarnessError("revision_conflict", "Runtime Action was proposed against a stale Task Tree revision");
    }
    this.requireUserMessage(input.projectId, drift.tree_id, input.sourceMessageTraceEventId);
    if (!(new Set<PlanDriftResolutionDecision>(["accepted", "rejected", "branch_cancelled"])).has(input.decision)) {
      throw new HarnessError("invalid_input", "unsupported Plan Drift resolution decision");
    }

    const actionId = newId();
    const confirmationId = newId();
    const createdAt = nowIso();
    const actionInput = {
      driftId: drift.id,
      decision: input.decision,
      recommendation: drift.agent_recommendation,
    };
    this.database.transaction(() => {
      this.database.run(`
        INSERT INTO runtime_actions (
          id, project_id, kind, input_json, result_json, created_at, action_type, target_type,
          target_id, expected_revision, reason, source_message_ref, risk_level,
          confirmation_requirement, confirmation_prompt_id, status
        ) VALUES (?, ?, 'resolve_plan_drift', ?, '{}', ?, 'resolve_plan_drift', 'plan_drift', ?, ?, ?, ?, 'high', ?, ?, 'pending_confirmation')
      `, actionId, input.projectId, canonicalJson(actionInput), createdAt, drift.id,
      input.expectedTreeRevisionId, input.reason.trim(), input.sourceMessageTraceEventId,
      safety.confirmationRequirement, confirmationId);
      this.database.run(`
        INSERT INTO runtime_confirmation_prompts (
          id, project_id, tree_id, scope_id, prompt, status, created_at, tree_revision_id,
          scope_kind, scope_root_node_id, prompt_type, related_task_node_id,
          related_artifact_ids_json, options_json, runtime_action_id
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 'branch', ?, 'drift_resolution', ?, ?, ?, ?)
      `, confirmationId, input.projectId, drift.tree_id, drift.id,
      `Resolve blocking Plan Drift as ${input.decision}?`, createdAt, input.expectedTreeRevisionId,
      drift.task_node_id, drift.task_node_id,
      canonicalJson([drift.planned_artifact_id, drift.actual_artifact_id].filter(Boolean)),
      canonicalJson(["yes", "no", "pause"]), actionId);
      this.setRuntimeWaiting(input.projectId, drift.tree_id, drift.task_node_id, {
        state: "waiting_for_drift_resolution", waitingItemType: "drift_resolution", waitingItemId: confirmationId,
      });
    });
    return {
      actionId, actionType: "resolve_plan_drift", targetId: drift.id,
      status: "pending_confirmation", confirmationRequirement: "required", confirmationId,
      decision: input.decision,
    };
  }

  proposeUserChange(input: {
    projectId: string;
    treeId: string;
    nodeId?: string | null;
    expectedTreeRevisionId: string;
    changeType: UserChangeType;
    summary: string;
    changeImpact: Record<string, unknown>;
    sourceMessageTraceEventId: string;
    proposedDocument?: TaskTreeDocument;
    priorityTargetNodeId?: string;
  }): RuntimeActionView {
    const safety = evaluateRuntimeActionSafety({
      actionType: "record_user_change", userChangeType: input.changeType,
      reason: input.summary, sourceMessageRef: input.sourceMessageTraceEventId,
    });
    const tree = this.database.get<{ current_revision_id: string }>(
      "SELECT current_revision_id FROM task_trees WHERE id = ? AND project_id = ?", input.treeId, input.projectId,
    );
    if (!tree) throw new HarnessError("not_found", "Task Tree was not found in this Project");
    if (tree.current_revision_id !== input.expectedTreeRevisionId) {
      throw new HarnessError("revision_conflict", "User Change was proposed against a stale Task Tree revision");
    }
    const sourceTrace = this.requireUserMessage(input.projectId, input.treeId, input.sourceMessageTraceEventId);
    const nodeId = input.nodeId ?? null;
    const node = nodeId
      ? this.database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = ? AND tree_id = ?", nodeId, input.treeId)
      : undefined;
    if (nodeId && !node) throw new HarnessError("not_found", "Task Node was not found in this Task Tree");
    if (input.changeType === "scope_change") {
      if (!nodeId || !input.proposedDocument) {
        throw new HarnessError("invalid_input", "scope_change requires an affected Task Node and proposed Task Tree document");
      }
      const validation = validateTaskTree(input.proposedDocument);
      if (!validation.ok) throw new HarnessError("invalid_tree_structure", "scope_change proposed document is invalid", validation.errors);
    } else if (input.proposedDocument) {
      throw new HarnessError("invalid_input", "only scope_change can carry a proposed Task Tree document");
    }
    if (input.changeType === "priority_change") {
      if (!input.priorityTargetNodeId || !this.database.get(
        "SELECT id FROM task_nodes WHERE id = ? AND tree_id = ?", input.priorityTargetNodeId, input.treeId,
      )) {
        throw new HarnessError("invalid_input", "priority_change requires a target Task Node in the same Task Tree");
      }
    } else if (input.priorityTargetNodeId) {
      throw new HarnessError("invalid_input", "only priority_change can select a priority target Task Node");
    }

    const actionId = newId();
    const userChangeId = newId();
    const confirmationId = safety.confirmationRequirement === "required" ? newId() : null;
    const createdAt = nowIso();
    const status = confirmationId ? "pending_confirmation" : "committed";
    const riskLevel = input.changeType === "scope_change" ? "high" : input.changeType === "priority_change" ? "medium" : "low";
    const actionInput = {
      userChangeId, changeType: input.changeType, nodeId,
      priorityTargetNodeId: input.priorityTargetNodeId ?? null,
    };
    this.database.transaction(() => {
      this.database.run(`
        INSERT INTO runtime_actions (
          id, project_id, kind, input_json, result_json, created_at, action_type, target_type,
          target_id, expected_revision, reason, source_message_ref, risk_level,
          confirmation_requirement, confirmation_prompt_id, status, committed_at
        ) VALUES (?, ?, 'record_user_change', ?, ?, ?, 'record_user_change', 'user_change', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, actionId, input.projectId, canonicalJson(actionInput),
      confirmationId ? "{}" : canonicalJson({ userChangeId, changeType: input.changeType }),
      createdAt, userChangeId, input.expectedTreeRevisionId, input.summary.trim(), input.sourceMessageTraceEventId,
      riskLevel, safety.confirmationRequirement, confirmationId, status, confirmationId ? null : createdAt);
      this.database.run(`
        INSERT INTO user_change_requests (
          id, project_id, tree_id, task_node_id, change_type, source_trace_event_id,
          expected_tree_revision_id, summary, change_impact_json, proposed_document_json,
          priority_target_node_id, prior_node_status, status, runtime_action_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, userChangeId, input.projectId, input.treeId, nodeId, input.changeType, input.sourceMessageTraceEventId,
      input.expectedTreeRevisionId, input.summary.trim(), canonicalJson(input.changeImpact),
      input.proposedDocument ? canonicalJson(input.proposedDocument) : null,
      input.priorityTargetNodeId ?? null, node?.status ?? null,
      confirmationId ? "pending_confirmation" : "applied", actionId, createdAt, createdAt);
      this.database.run(`
        INSERT INTO trace_events (
          id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, 'user_change_request', ?, ?, ?)
      `, newId(), input.projectId, input.treeId, nodeId, sourceTrace.session_id,
      canonicalJson({ actionId, userChangeId, changeType: input.changeType, summary: input.summary.trim(),
        changeImpact: input.changeImpact, sourceMessageTraceEventId: input.sourceMessageTraceEventId }),
      createdAt, `user-change:${actionId}:proposed`);

      if (input.changeType === "priority_change") {
        this.database.run(
          "UPDATE runtime_states SET selected_tree_id = ?, selected_node_id = ?, updated_at = ? WHERE project_id = ?",
          input.treeId, input.priorityTargetNodeId!, createdAt, input.projectId,
        );
      }
      if (input.changeType === "scope_change" && confirmationId) {
        this.database.run(
          "UPDATE execution_attempts SET status = 'aborted', completed_at = ? WHERE project_id = ? AND tree_id = ? AND task_node_id = ? AND status IN ('running', 'verifying')",
          createdAt, input.projectId, input.treeId, nodeId,
        );
        this.database.run("UPDATE task_nodes SET status = 'pending_user_confirmation' WHERE id = ? AND tree_id = ?", nodeId, input.treeId);
        this.database.run(`
          INSERT INTO runtime_confirmation_prompts (
            id, project_id, tree_id, scope_id, prompt, status, created_at, tree_revision_id,
            scope_kind, scope_root_node_id, prompt_type, related_task_node_id,
            related_artifact_ids_json, options_json, runtime_action_id
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 'branch', ?, 'change_confirmation', ?, '[]', ?, ?)
        `, confirmationId, input.projectId, input.treeId, userChangeId,
        `Apply scope change: ${input.summary.trim()}?`, createdAt, input.expectedTreeRevisionId,
        nodeId, nodeId, canonicalJson(["yes", "no", "pause"]), actionId);
        this.setRuntimeWaiting(input.projectId, input.treeId, nodeId, {
          state: "waiting_for_change_confirmation", waitingItemType: "change_confirmation", waitingItemId: confirmationId,
        });
      }
    });
    return {
      actionId, actionType: "record_user_change", targetId: userChangeId, status,
      confirmationRequirement: safety.confirmationRequirement, confirmationId, changeType: input.changeType,
    };
  }

  resolveConfirmation(input: {
    projectId: string;
    confirmationId: string;
    answer: RuntimeConfirmationAnswer;
    answerTraceEventId: string;
  }): RuntimeActionView {
    const confirmation = this.database.get<ConfirmationRow>(`
      SELECT c.id, c.project_id, c.tree_id, c.status, c.answer, c.answer_trace_event_id,
             c.created_at, c.prompt_type, c.runtime_action_id,
             a.action_type, a.status AS action_status, a.target_id, a.expected_revision, a.input_json, a.result_json
      FROM runtime_confirmation_prompts c
      JOIN runtime_actions a ON a.id = c.runtime_action_id
      WHERE c.id = ? AND c.project_id = ?
    `, input.confirmationId, input.projectId);
    if (!confirmation) throw new HarnessError("not_found", "Runtime confirmation was not found in this Project");
    if (confirmation.prompt_type !== "drift_resolution" && confirmation.prompt_type !== "change_confirmation") {
      throw new HarnessError("confirmation_not_applicable", "this confirmation is owned by another Runtime flow");
    }
    if (confirmation.status !== "pending") {
      if (confirmation.answer === input.answer && confirmation.answer_trace_event_id === input.answerTraceEventId) {
        return this.resolvedView(confirmation);
      }
      throw new HarnessError("confirmation_not_applicable", "Runtime confirmation is no longer pending");
    }
    this.requireUserMessage(input.projectId, confirmation.tree_id, input.answerTraceEventId, confirmation.created_at);

    if (confirmation.prompt_type === "change_confirmation") {
      return this.resolveUserChangeConfirmation(confirmation, input.answer, input.answerTraceEventId);
    }

    const actionInput = JSON.parse(confirmation.input_json) as { decision: PlanDriftResolutionDecision };
    if (input.answer === "pause") {
      this.database.transaction(() => {
        this.database.run(
          "UPDATE runtime_confirmation_prompts SET answer = ?, answer_trace_event_id = ? WHERE id = ?",
          input.answer, input.answerTraceEventId, confirmation.id,
        );
        this.setRuntimeWaiting(input.projectId, confirmation.tree_id, null, {
          state: "paused", waitingItemType: "drift_resolution", waitingItemId: confirmation.id,
        });
      });
      return {
        actionId: confirmation.runtime_action_id, actionType: "resolve_plan_drift",
        targetId: confirmation.target_id, status: "pending_confirmation",
        confirmationRequirement: "required", confirmationId: confirmation.id,
        decision: actionInput.decision, paused: true,
      };
    }

    const resolvedAt = nowIso();
    if (input.answer === "no") {
      this.database.transaction(() => {
        this.database.run(
          "UPDATE runtime_confirmation_prompts SET status = 'rejected', answer = ?, answer_trace_event_id = ?, resolved_at = ? WHERE id = ?",
          input.answer, input.answerTraceEventId, resolvedAt, confirmation.id,
        );
        this.database.run(
          "UPDATE runtime_actions SET status = 'rejected', result_json = ? WHERE id = ?",
          canonicalJson({ answer: "no" }), confirmation.runtime_action_id,
        );
        this.clearRuntimeWaiting(input.projectId);
      });
      return {
        actionId: confirmation.runtime_action_id, actionType: "resolve_plan_drift",
        targetId: confirmation.target_id, status: "rejected", confirmationRequirement: "required",
        confirmationId: confirmation.id, decision: actionInput.decision,
      };
    }

    const result = this.database.transaction(() => {
      const resolution = this.drifts.resolveDriftWithinTransaction({
        projectId: input.projectId, driftId: confirmation.target_id, decision: actionInput.decision,
      });
      const answerTrace = this.requireUserMessage(input.projectId, confirmation.tree_id, input.answerTraceEventId, confirmation.created_at);
      const resolutionTraceId = newId();
      this.database.run(`
        INSERT INTO trace_events (
          id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, 'plan_drift_resolved', ?, ?, ?)
      `, resolutionTraceId, input.projectId, resolution.treeId, resolution.nodeId, answerTrace.session_id,
      canonicalJson({ actionId: confirmation.runtime_action_id, driftId: confirmation.target_id,
        decision: resolution.decision, answerTraceEventId: input.answerTraceEventId }),
      resolvedAt, `runtime-action:${confirmation.runtime_action_id}:committed`);
      this.database.run(
        "UPDATE runtime_confirmation_prompts SET status = 'confirmed', answer = ?, answer_trace_event_id = ?, resolved_at = ? WHERE id = ?",
        input.answer, input.answerTraceEventId, resolvedAt, confirmation.id,
      );
      this.database.run(
        "UPDATE runtime_actions SET status = 'committed', result_json = ?, committed_at = ? WHERE id = ?",
        canonicalJson({ decision: resolution.decision, resolutionTraceEventId: resolutionTraceId }),
        resolvedAt, confirmation.runtime_action_id,
      );
      this.clearRuntimeWaiting(input.projectId);
      return resolution;
    });
    return {
      actionId: confirmation.runtime_action_id, actionType: "resolve_plan_drift",
      targetId: confirmation.target_id, status: "committed", confirmationRequirement: "required",
      confirmationId: confirmation.id, decision: result.decision,
    };
  }

  private requireUserMessage(projectId: string, treeId: string, traceEventId: string, notBefore?: string) {
    const trace = this.database.get<{ id: string; session_id: string; occurred_at: string }>(`
      SELECT id, session_id, occurred_at FROM trace_events
      WHERE id = ? AND project_id = ? AND tree_id = ? AND event_name = 'UserPromptSubmit'
    `, traceEventId, projectId, treeId);
    if (!trace || (notBefore && trace.occurred_at < notBefore)) {
      throw new HarnessError("runtime_action_rejected", "a recorded user message Trace from this Runtime flow is required");
    }
    return trace;
  }

  private resolveUserChangeConfirmation(
    confirmation: ConfirmationRow,
    answer: RuntimeConfirmationAnswer,
    answerTraceEventId: string,
  ): RuntimeActionView {
    const change = this.database.get<{
      id: string; project_id: string; tree_id: string; task_node_id: string | null; change_type: UserChangeType;
      expected_tree_revision_id: string; summary: string; change_impact_json: string;
      proposed_document_json: string | null; prior_node_status: string | null; status: string;
    }>(`
      SELECT id, project_id, tree_id, task_node_id, change_type, expected_tree_revision_id,
             summary, change_impact_json, proposed_document_json, prior_node_status, status
      FROM user_change_requests WHERE runtime_action_id = ? AND project_id = ?
    `, confirmation.runtime_action_id, confirmation.project_id);
    if (!change || change.change_type !== "scope_change" || !change.task_node_id || !change.proposed_document_json) {
      throw new HarnessError("confirmation_not_applicable", "scope change confirmation has no valid User Change candidate");
    }
    if (answer === "pause") {
      this.database.transaction(() => {
        this.database.run("UPDATE runtime_confirmation_prompts SET answer = ?, answer_trace_event_id = ? WHERE id = ?", answer, answerTraceEventId, confirmation.id);
        this.database.run("UPDATE user_change_requests SET status = 'paused', updated_at = ? WHERE id = ?", nowIso(), change.id);
        this.setRuntimeWaiting(change.project_id, change.tree_id, change.task_node_id, {
          state: "paused", waitingItemType: "change_confirmation", waitingItemId: confirmation.id,
        });
      });
      return {
        actionId: confirmation.runtime_action_id, actionType: "record_user_change", targetId: change.id,
        status: "pending_confirmation", confirmationRequirement: "required", confirmationId: confirmation.id,
        changeType: change.change_type, paused: true,
      };
    }
    const resolvedAt = nowIso();
    if (answer === "no") {
      const restoredStatus = ["running", "verifying", "blocked", "pending_user_confirmation"].includes(change.prior_node_status ?? "")
        ? "ready"
        : change.prior_node_status ?? "ready";
      this.database.transaction(() => {
        this.database.run("UPDATE runtime_confirmation_prompts SET status = 'rejected', answer = ?, answer_trace_event_id = ?, resolved_at = ? WHERE id = ?", answer, answerTraceEventId, resolvedAt, confirmation.id);
        this.database.run("UPDATE runtime_actions SET status = 'rejected', result_json = ? WHERE id = ?", canonicalJson({ answer: "no", userChangeId: change.id }), confirmation.runtime_action_id);
        this.database.run("UPDATE user_change_requests SET status = 'rejected', updated_at = ?, resolved_at = ? WHERE id = ?", resolvedAt, resolvedAt, change.id);
        this.database.run("UPDATE task_nodes SET status = ? WHERE id = ? AND tree_id = ?", restoredStatus, change.task_node_id, change.tree_id);
        this.clearRuntimeWaiting(change.project_id);
      });
      return {
        actionId: confirmation.runtime_action_id, actionType: "record_user_change", targetId: change.id,
        status: "rejected", confirmationRequirement: "required", confirmationId: confirmation.id,
        changeType: change.change_type,
      };
    }

    const tree = this.database.get<{ current_revision_id: string }>(
      "SELECT current_revision_id FROM task_trees WHERE id = ? AND project_id = ?", change.tree_id, change.project_id,
    );
    if (!tree || tree.current_revision_id !== change.expected_tree_revision_id) {
      this.database.transaction(() => {
        this.database.run("UPDATE runtime_actions SET status = 'revision_conflict', result_json = ? WHERE id = ?", canonicalJson({ expectedRevision: change.expected_tree_revision_id, actualRevision: tree?.current_revision_id ?? null }), confirmation.runtime_action_id);
        this.database.run("UPDATE user_change_requests SET status = 'revision_conflict', updated_at = ?, resolved_at = ? WHERE id = ?", resolvedAt, resolvedAt, change.id);
        this.database.run("UPDATE runtime_confirmation_prompts SET status = 'cancelled', answer = ?, answer_trace_event_id = ?, resolved_at = ? WHERE id = ?", answer, answerTraceEventId, resolvedAt, confirmation.id);
        this.clearRuntimeWaiting(change.project_id);
      });
      throw new HarnessError("revision_conflict", "scope change confirmation belongs to an older Task Tree revision");
    }

    const answerTrace = this.requireUserMessage(change.project_id, change.tree_id, answerTraceEventId, confirmation.created_at);
    const result = this.database.transaction(() => {
      const impact = JSON.parse(change.change_impact_json) as { changedNodes?: unknown };
      const affectedReferences = Array.isArray(impact.changedNodes)
        ? impact.changedNodes.filter((value): value is string => typeof value === "string")
        : [change.task_node_id!];
      const revision = this.taskTrees.applyDraftChangeSetWithinTransaction({
        projectId: change.project_id, treeId: change.tree_id, baseRevisionId: change.expected_tree_revision_id,
        operations: [{ op: "replace_document", document: JSON.parse(change.proposed_document_json!) as TaskTreeDocument }],
        affectedReferences, decisionSummary: change.summary,
      });
      const workflow = this.database.get<{ stage: string }>("SELECT stage FROM workflow_states WHERE project_id = ? AND tree_id = ? AND active = 1", change.project_id, change.tree_id);
      if (workflow?.stage !== "task_tree_refinement") {
        this.database.run("UPDATE workflow_states SET stage = 'task_tree_refinement', revision = revision + 1, updated_at = ? WHERE project_id = ? AND tree_id = ? AND active = 1", resolvedAt, change.project_id, change.tree_id);
      }
      const traceEventId = newId();
      this.database.run(`
        INSERT INTO trace_events (
          id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, 'user_change_applied', ?, ?, ?)
      `, traceEventId, change.project_id, change.tree_id, change.task_node_id, answerTrace.session_id,
      canonicalJson({ actionId: confirmation.runtime_action_id, userChangeId: change.id,
        revisionId: revision.revisionId, answerTraceEventId }), resolvedAt,
      `runtime-action:${confirmation.runtime_action_id}:committed`);
      this.database.run("UPDATE runtime_confirmation_prompts SET status = 'confirmed', answer = ?, answer_trace_event_id = ?, resolved_at = ? WHERE id = ?", answer, answerTraceEventId, resolvedAt, confirmation.id);
      this.database.run("UPDATE runtime_actions SET status = 'committed', result_json = ?, committed_at = ? WHERE id = ?", canonicalJson({ userChangeId: change.id, revisionId: revision.revisionId, traceEventId }), resolvedAt, confirmation.runtime_action_id);
      this.database.run("UPDATE user_change_requests SET status = 'applied', updated_at = ?, resolved_at = ? WHERE id = ?", resolvedAt, resolvedAt, change.id);
      this.clearRuntimeWaiting(change.project_id);
      return revision;
    });
    return {
      actionId: confirmation.runtime_action_id, actionType: "record_user_change", targetId: change.id,
      status: "committed", confirmationRequirement: "required", confirmationId: confirmation.id,
      changeType: change.change_type,
    };
  }

  private setRuntimeWaiting(
    projectId: string,
    treeId: string,
    nodeId: string | null,
    waiting: { state: string; waitingItemType: string; waitingItemId: string },
  ): void {
    const current = this.database.get<{ state_json: string }>("SELECT state_json FROM runtime_states WHERE project_id = ?", projectId);
    const state = { ...(current ? JSON.parse(current.state_json) as Record<string, unknown> : {}), ...waiting };
    this.database.run(`
      INSERT INTO runtime_states (project_id, selected_tree_id, selected_node_id, state_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
    `, projectId, treeId, nodeId, canonicalJson(state), nowIso());
  }

  private clearRuntimeWaiting(projectId: string): void {
    const current = this.database.get<{ state_json: string }>("SELECT state_json FROM runtime_states WHERE project_id = ?", projectId);
    const state = current ? JSON.parse(current.state_json) as Record<string, unknown> : {};
    this.database.run(
      "UPDATE runtime_states SET state_json = ?, updated_at = ? WHERE project_id = ?",
      canonicalJson({ ...state, state: "idle", waitingItemType: null, waitingItemId: null }), nowIso(), projectId,
    );
  }

  private resolvedView(confirmation: ConfirmationRow): RuntimeActionView {
    const actionInput = JSON.parse(confirmation.input_json) as { decision?: PlanDriftResolutionDecision; changeType?: UserChangeType };
    return {
      actionId: confirmation.runtime_action_id,
      actionType: confirmation.action_type,
      targetId: confirmation.target_id,
      status: confirmation.action_status,
      confirmationRequirement: "required",
      confirmationId: confirmation.id,
      ...(actionInput.decision ? { decision: actionInput.decision } : {}),
      ...(actionInput.changeType ? { changeType: actionInput.changeType } : {}),
    };
  }
}
