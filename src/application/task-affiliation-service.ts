import { HarnessError } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
import {
  statusForAffiliationChoice,
  validateAffiliationRecommendation,
  type TaskAffiliationChoice,
  type TaskAffiliationRecommendation,
} from "../domain/task-affiliation.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";
import { TaskTreeService } from "./task-tree-service.js";

interface AffiliationRow {
  id: string;
  project_id: string;
  request_trace_event_id: string;
  request_title: string;
  candidate_query: string;
  candidate_snapshot_json: string;
  recommendation: TaskAffiliationRecommendation;
  recommended_tree_id: string | null;
  status: "pending" | "new_tree" | "merged" | "paused";
  confirmation_prompt_id: string;
  runtime_action_id: string;
  answer_trace_event_id: string | null;
  resolved_tree_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

export class TaskAffiliationService {
  private readonly trees: TaskTreeService;

  constructor(private readonly database: RuntimeDatabase) {
    this.trees = new TaskTreeService(database);
  }

  propose(input: {
    projectId: string;
    requestTitle: string;
    candidateQuery?: string;
    recommendation: TaskAffiliationRecommendation;
    recommendedTreeId?: string | null;
    runId?: string;
  }) {
    const requestTitle = input.requestTitle.trim();
    const candidateQuery = (input.candidateQuery ?? requestTitle).trim();
    if (!requestTitle || !candidateQuery) {
      throw new HarnessError("invalid_input", "request title and candidate query are required");
    }
    validateAffiliationRecommendation(input);
    if (!this.database.get("SELECT id FROM projects WHERE id = ?", input.projectId)) {
      throw new HarnessError("not_found", "Project was not found");
    }
    if (this.database.get("SELECT id FROM task_affiliation_decisions WHERE project_id = ? AND status = 'pending'", input.projectId)) {
      throw new HarnessError("confirmation_required", "this Project already has a pending Task affiliation decision");
    }
    const candidates = this.trees.listTaskTreeCandidates({ projectId: input.projectId, query: candidateQuery });
    if (input.recommendation === "merge" && !candidates.some((candidate) => candidate.treeId === input.recommendedTreeId)) {
      throw new HarnessError("not_found", "recommended Task Tree is not present in the deterministic candidate snapshot");
    }
    const decisionId = newId();
    const traceEventId = newId();
    const actionId = newId();
    const confirmationId = newId();
    const createdAt = nowIso();
    const options = candidates.length ? ["new_tree", "merge", "pause"] : ["new_tree", "pause"];
    this.database.transaction(() => {
      this.database.run(`
        INSERT INTO trace_events (
          id, project_id, tree_id, node_id, session_id, event_name, payload_json,
          execution_context_json, occurred_at, idempotency_key
        ) VALUES (?, ?, NULL, NULL, ?, 'task_affiliation_requested', ?, '{}', ?, ?)
      `, traceEventId, input.projectId, input.runId?.trim() || "runtime:task-affiliation", canonicalJson({
        decisionId, requestTitle, candidateQuery, recommendation: input.recommendation,
        recommendedTreeId: input.recommendedTreeId ?? null,
        candidateTreeIds: candidates.map((candidate) => candidate.treeId),
      }), createdAt, `task-affiliation:${decisionId}:requested`);
      this.database.run(`
        INSERT INTO runtime_actions (
          id, project_id, kind, input_json, result_json, created_at, action_type, target_type,
          target_id, reason, source_message_ref, risk_level, confirmation_requirement,
          confirmation_prompt_id, status
        ) VALUES (?, ?, 'decide_task_affiliation', ?, '{}', ?, 'decide_task_affiliation',
          'task_affiliation', ?, ?, ?, 'high', 'required', ?, 'pending_confirmation')
      `, actionId, input.projectId, canonicalJson({ decisionId, recommendation: input.recommendation }),
      createdAt, decisionId, `Choose Task Tree affiliation for ${requestTitle}`, traceEventId, confirmationId);
      this.database.run(`
        INSERT INTO runtime_confirmation_prompts (
          id, project_id, tree_id, scope_id, prompt, status, created_at,
          prompt_type, related_artifact_ids_json, options_json, runtime_action_id
        ) VALUES (?, ?, NULL, ?, ?, 'pending', ?, 'high_risk_action', '[]', ?, ?)
      `, confirmationId, input.projectId, decisionId,
      `Should "${requestTitle}" create a new Task Tree or merge into an existing candidate?`,
      createdAt, canonicalJson(options), actionId);
      this.database.run(`
        INSERT INTO task_affiliation_decisions (
          id, project_id, request_trace_event_id, request_title, candidate_query,
          candidate_snapshot_json, recommendation, recommended_tree_id, status,
          confirmation_prompt_id, runtime_action_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `, decisionId, input.projectId, traceEventId, requestTitle, candidateQuery,
      canonicalJson(candidates), input.recommendation, input.recommendedTreeId ?? null,
      confirmationId, actionId, createdAt);
    });
    return {
      decisionId, requestTraceEventId: traceEventId, actionId, confirmationId,
      requestTitle, candidates, recommendation: input.recommendation,
      recommendedTreeId: input.recommendedTreeId ?? null, options, status: "pending" as const, createdAt,
    };
  }

  async resolve(input: {
    projectId: string;
    decisionId: string;
    choice: TaskAffiliationChoice;
    answerTraceEventId: string;
    chosenTreeId?: string | null;
  }) {
    const chosenTreeId = input.chosenTreeId ?? null;
    if (input.choice === "merge" && !chosenTreeId) {
      throw new HarnessError("invalid_input", "merge requires a chosen Task Tree");
    }
    if (input.choice !== "merge" && chosenTreeId) {
      throw new HarnessError("invalid_input", `${input.choice} cannot specify an existing Task Tree`);
    }
    return this.database.transaction(() => {
      const decision = this.requireDecision(input.projectId, input.decisionId);
      const requestedStatus = statusForAffiliationChoice(input.choice);
      if (decision.status !== "pending") {
        if (decision.status !== requestedStatus || (input.choice === "merge" && decision.resolved_tree_id !== chosenTreeId)) {
          throw new HarnessError("confirmation_not_applicable", "Task affiliation decision was already resolved differently");
        }
        return this.mapDecision(decision);
      }
      const answer = this.database.get<{ occurred_at: string }>(`
        SELECT occurred_at FROM trace_events
        WHERE id = ? AND project_id = ? AND event_name = 'UserPromptSubmit'
      `, input.answerTraceEventId, input.projectId);
      if (!answer || answer.occurred_at < decision.created_at) {
        throw new HarnessError("evidence_scope_mismatch", "affiliation answer must be a later UserPromptSubmit in the same Project");
      }

      let resolvedTreeId: string | null = null;
      let result: unknown = { paused: true };
      if (input.choice === "new_tree") {
        const created = this.trees.createTaskRootWithinTransaction({
          projectId: input.projectId,
          title: decision.request_title,
        });
        resolvedTreeId = created.treeId;
        result = created;
      } else if (input.choice === "merge") {
        const mergeTreeId = chosenTreeId!;
        const candidateTreeIds = (JSON.parse(decision.candidate_snapshot_json) as Array<{ treeId: string }>).map((candidate) => candidate.treeId);
        if (!candidateTreeIds.includes(mergeTreeId)) {
          throw new HarnessError("not_found", "merge target is not present in the confirmed candidate snapshot");
        }
        const tree = this.database.get<{ id: string; status: string }>(
          "SELECT id, status FROM task_trees WHERE id = ? AND project_id = ?", mergeTreeId, input.projectId,
        );
        if (!tree || tree.status === "archived") throw new HarnessError("not_found", "merge target is not an active Task Tree in this Project");
        result = this.trees.selectTaskTreeWithinTransaction({ projectId: input.projectId, treeId: mergeTreeId });
        resolvedTreeId = mergeTreeId;
      }

      const resolvedAt = nowIso();
      this.database.run(`
        UPDATE task_affiliation_decisions
        SET status = ?, answer_trace_event_id = ?, resolved_tree_id = ?, resolved_at = ?
        WHERE id = ? AND project_id = ? AND status = 'pending'
      `, requestedStatus, input.answerTraceEventId, resolvedTreeId, resolvedAt, input.decisionId, input.projectId);
      this.database.run(
        "UPDATE runtime_confirmation_prompts SET status = ?, answer = ?, answer_trace_event_id = ?, resolved_at = ? WHERE id = ?",
        input.choice === "pause" ? "cancelled" : "confirmed", input.choice, input.answerTraceEventId, resolvedAt, decision.confirmation_prompt_id,
      );
      this.database.run(
        "UPDATE runtime_actions SET result_json = ?, status = 'committed', committed_at = ? WHERE id = ?",
        canonicalJson({ choice: input.choice, resolvedTreeId, result }), resolvedAt, decision.runtime_action_id,
      );
      this.database.run(`
        INSERT INTO trace_events (
          id, project_id, tree_id, node_id, session_id, event_name, payload_json,
          execution_context_json, occurred_at, idempotency_key
        ) SELECT ?, project_id, ?, NULL, session_id, 'task_affiliation_resolved', ?, '{}', ?, ?
          FROM trace_events WHERE id = ?
      `, newId(), resolvedTreeId, canonicalJson({ decisionId: input.decisionId, choice: input.choice, resolvedTreeId }),
      resolvedAt, `task-affiliation:${input.decisionId}:resolved`, input.answerTraceEventId);
      return this.mapDecision(this.requireDecision(input.projectId, input.decisionId));
    });
  }

  list(projectId: string) {
    return this.database.all<AffiliationRow>(`
      SELECT * FROM task_affiliation_decisions WHERE project_id = ? ORDER BY created_at DESC, id DESC
    `, projectId).map((row) => this.mapDecision(row));
  }

  get(projectId: string, decisionId: string) {
    return this.mapDecision(this.requireDecision(projectId, decisionId));
  }

  private requireDecision(projectId: string, decisionId: string): AffiliationRow {
    const row = this.database.get<AffiliationRow>(
      "SELECT * FROM task_affiliation_decisions WHERE id = ? AND project_id = ?", decisionId, projectId,
    );
    if (!row) throw new HarnessError("not_found", "Task affiliation decision was not found in this Project");
    return row;
  }

  private mapDecision(row: AffiliationRow) {
    return {
      decisionId: row.id, projectId: row.project_id, requestTraceEventId: row.request_trace_event_id,
      requestTitle: row.request_title, candidateQuery: row.candidate_query,
      candidates: JSON.parse(row.candidate_snapshot_json) as unknown[], recommendation: row.recommendation,
      recommendedTreeId: row.recommended_tree_id, status: row.status,
      confirmationId: row.confirmation_prompt_id, actionId: row.runtime_action_id,
      answerTraceEventId: row.answer_trace_event_id, resolvedTreeId: row.resolved_tree_id,
      createdAt: row.created_at, resolvedAt: row.resolved_at,
    };
  }
}

