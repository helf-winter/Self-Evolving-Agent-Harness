import { HarnessError } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
import {
  evaluateRuntimeActionSafety,
  type RuntimeConfirmationAnswer,
} from "../domain/runtime-action.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";
import { PlanDriftService, type PlanDriftResolutionDecision } from "./plan-drift-service.js";

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
  paused?: boolean;
}

export class RuntimeActionService {
  private readonly drifts: PlanDriftService;

  constructor(private readonly database: RuntimeDatabase, drifts?: PlanDriftService) {
    this.drifts = drifts ?? new PlanDriftService(database);
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

  resolveConfirmation(input: {
    projectId: string;
    confirmationId: string;
    answer: RuntimeConfirmationAnswer;
    answerTraceEventId: string;
  }): RuntimeActionView {
    const confirmation = this.database.get<ConfirmationRow>(`
      SELECT c.id, c.project_id, c.tree_id, c.status, c.answer, c.answer_trace_event_id,
             c.created_at, c.prompt_type, c.runtime_action_id,
             a.status AS action_status, a.target_id, a.expected_revision, a.input_json, a.result_json
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
    const actionInput = JSON.parse(confirmation.input_json) as { decision?: PlanDriftResolutionDecision };
    return {
      actionId: confirmation.runtime_action_id,
      actionType: "resolve_plan_drift",
      targetId: confirmation.target_id,
      status: confirmation.action_status,
      confirmationRequirement: "required",
      confirmationId: confirmation.id,
      ...(actionInput.decision ? { decision: actionInput.decision } : {}),
    };
  }
}
