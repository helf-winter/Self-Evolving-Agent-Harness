import { HarnessError } from "../domain/errors.js";
import { deriveConfirmationStates, resolveConfirmationScope, type ConfirmationState } from "../domain/confirmation.js";
import { newId, nowIso } from "../domain/ids.js";
import { canonicalJson } from "../domain/trace.js";
import type { TaskTreeDocument } from "../domain/task-tree.js";
import { canTransitionWorkflow, type WorkflowStage } from "../domain/workflow.js";
import type { RuntimeDatabase } from "../storage/database.js";

interface WorkflowRow {
  id: string;
  tree_id: string;
  stage: WorkflowStage;
  revision: number;
}

interface ConfirmationRow {
  id: string;
  project_id: string;
  tree_id: string;
  scope_id: string;
  status: string;
  tree_revision_id: string;
  readiness_result_id: string;
  scope_kind: "tree" | "branch";
  scope_root_node_id: string | null;
  created_at: string;
}

export class WorkflowService {
  constructor(private readonly database: RuntimeDatabase) {}

  createConfirmationPrompt(input: {
    projectId: string;
    treeId: string;
    scopeId: string;
    scopeRootNodeId?: string;
    readinessResultId?: string;
    prompt: string;
    workflowRevision: number;
  }) {
    const workflow = this.requireWorkflow(input.projectId, input.treeId, input.workflowRevision);
    if (workflow.stage !== "branch_confirmation") {
      throw new HarnessError("workflow_transition_rejected", "scope confirmation is only valid at branch_confirmation");
    }
    if (!input.prompt.trim()) throw new HarnessError("invalid_input", "confirmation prompt is required");
    const tree = this.database.get<{ current_revision_id: string; document_json: string }>(`
      SELECT t.current_revision_id, r.document_json
      FROM task_trees t JOIN task_tree_revisions r ON r.id = t.current_revision_id
      WHERE t.id = ? AND t.project_id = ?
    `, input.treeId, input.projectId);
    if (!tree) throw new HarnessError("not_found", "current Task Tree revision was not found");
    const document = JSON.parse(tree.document_json) as TaskTreeDocument;
    const coveredNodeIds = resolveConfirmationScope(document, input.scopeRootNodeId);
    if (!coveredNodeIds) throw new HarnessError("not_found", "confirmation scope root was not found in the current Task Tree revision");
    const scopeKind = input.scopeRootNodeId ? "branch" as const : "tree" as const;
    const scopeRootNodeId = input.scopeRootNodeId ?? null;
    const readiness = input.readinessResultId
      ? this.database.get<{ id: string }>(`
          SELECT id FROM plan_readiness_results
          WHERE id = ? AND tree_id = ? AND revision_id = ? AND ready = 1 AND scope_kind = ?
            AND ((scope_root_node_id IS NULL AND ? IS NULL) OR scope_root_node_id = ?)
        `, input.readinessResultId, input.treeId, tree.current_revision_id, scopeKind, scopeRootNodeId, scopeRootNodeId)
      : this.database.get<{ id: string }>(`
          SELECT id FROM plan_readiness_results
          WHERE tree_id = ? AND revision_id = ? AND ready = 1 AND scope_kind = ?
            AND ((scope_root_node_id IS NULL AND ? IS NULL) OR scope_root_node_id = ?)
          ORDER BY created_at DESC LIMIT 1
        `, input.treeId, tree.current_revision_id, scopeKind, scopeRootNodeId, scopeRootNodeId);
    if (!readiness) throw new HarnessError("workflow_transition_rejected", "a current ready Plan Readiness result is required for this exact scope");
    const confirmationId = newId();
    this.database.run(
      `INSERT INTO runtime_confirmation_prompts (
        id, project_id, tree_id, scope_id, prompt, status, created_at,
        tree_revision_id, readiness_result_id, scope_kind, scope_root_node_id
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      confirmationId, input.projectId, input.treeId, input.scopeId, input.prompt.trim(), nowIso(),
      tree.current_revision_id, readiness.id, scopeKind, scopeRootNodeId,
    );
    return {
      confirmationId, status: "pending" as const, scopeId: input.scopeId, prompt: input.prompt.trim(),
      revisionId: tree.current_revision_id, readinessResultId: readiness.id, scopeKind, scopeRootNodeId, coveredNodeIds,
    };
  }

  confirmScope(input: {
    projectId: string;
    confirmationId: string;
    answer: "yes" | "no";
    answerTraceEventId: string;
    workflowRevision: number;
  }) {
    const confirmation = this.database.get<ConfirmationRow>(
      `SELECT id, project_id, tree_id, scope_id, status, tree_revision_id, readiness_result_id,
              scope_kind, scope_root_node_id, created_at
       FROM runtime_confirmation_prompts WHERE id = ? AND project_id = ?`,
      input.confirmationId, input.projectId,
    );
    if (!confirmation || confirmation.status !== "pending") throw new HarnessError("not_found", "pending confirmation was not found");
    const workflow = this.requireWorkflow(input.projectId, confirmation.tree_id, input.workflowRevision);
    const tree = this.database.get<{ current_revision_id: string; document_json: string }>(`
      SELECT t.current_revision_id, r.document_json
      FROM task_trees t JOIN task_tree_revisions r ON r.id = t.current_revision_id
      WHERE t.id = ? AND t.project_id = ?
    `, confirmation.tree_id, input.projectId);
    if (!tree) throw new HarnessError("not_found", "current Task Tree revision was not found");
    if (tree.current_revision_id !== confirmation.tree_revision_id) {
      throw new HarnessError("revision_conflict", "confirmation prompt belongs to an older Task Tree revision");
    }
    const evidence = this.database.get<{ id: string }>(
      `SELECT id FROM trace_events
       WHERE id = ? AND project_id = ? AND tree_id = ? AND event_name = 'UserPromptSubmit' AND occurred_at >= ?`,
      input.answerTraceEventId, input.projectId, confirmation.tree_id, confirmation.created_at,
    );
    if (!evidence) throw new HarnessError("workflow_transition_rejected", "a recorded user answer Trace Event is required");

    if (input.answer === "no") {
      this.database.run(
        "UPDATE runtime_confirmation_prompts SET status = 'rejected', answer = ?, answer_trace_event_id = ?, resolved_at = ? WHERE id = ?",
        input.answer, input.answerTraceEventId, nowIso(), confirmation.id,
      );
      return {
        stage: workflow.stage, workflowRevision: workflow.revision, status: "rejected" as const,
        scopeKind: confirmation.scope_kind, scopeRootNodeId: confirmation.scope_root_node_id,
      };
    }

    const document = JSON.parse(tree.document_json) as TaskTreeDocument;
    const coveredNodeIds = resolveConfirmationScope(document, confirmation.scope_root_node_id ?? undefined);
    if (!coveredNodeIds) throw new HarnessError("revision_conflict", "confirmation scope no longer exists in the current revision");
    const covered = new Set(coveredNodeIds);
    const confirmationRecordId = newId();
    const timestamp = nowIso();
    let allConfirmed = false;
    this.database.transaction(() => {
      this.database.run(
        "UPDATE runtime_confirmation_prompts SET status = 'confirmed', answer = ?, answer_trace_event_id = ?, resolved_at = ? WHERE id = ?",
        input.answer, input.answerTraceEventId, timestamp, confirmation.id,
      );
      this.database.run(`
        INSERT INTO scope_confirmation_records (
          id, project_id, tree_id, tree_revision_id, scope_kind, scope_root_node_id,
          covered_node_ids_json, confirmation_prompt_id, answer_trace_event_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, confirmationRecordId, input.projectId, confirmation.tree_id, confirmation.tree_revision_id,
      confirmation.scope_kind, confirmation.scope_root_node_id, canonicalJson(coveredNodeIds), confirmation.id,
      input.answerTraceEventId, timestamp);

      for (const taskNodeId of coveredNodeIds) {
        this.database.run(`
          UPDATE artifacts SET
            status = 'planned', planned_by_task_node_id = ?, plan_baseline_at = ?, updated_at = ?
          WHERE tree_id = ? AND status = 'draft' AND EXISTS (
            SELECT 1 FROM task_node_artifact_links l
            WHERE l.artifact_id = artifacts.id AND l.tree_revision_id = ? AND l.task_node_id = ?
          )
        `, taskNodeId, timestamp, timestamp, confirmation.tree_id, confirmation.tree_revision_id, taskNodeId);
      }

      const records = this.database.all<{ id: string; covered_node_ids_json: string }>(`
        SELECT id, covered_node_ids_json FROM scope_confirmation_records
        WHERE tree_id = ? AND tree_revision_id = ? ORDER BY created_at, id
      `, confirmation.tree_id, confirmation.tree_revision_id);
      const inheritedConfirmed = this.database.all<{ task_node_id: string; source_confirmation_id: string | null }>(`
        SELECT task_node_id, source_confirmation_id FROM task_node_confirmation_states
        WHERE tree_revision_id = ? AND state = 'confirmed'
      `, confirmation.tree_revision_id);
      const confirmedNodeIds = new Set(inheritedConfirmed.map((row) => row.task_node_id));
      const sourceByNode = new Map(inheritedConfirmed.flatMap((row) =>
        row.source_confirmation_id ? [[row.task_node_id, row.source_confirmation_id] as const] : []));
      for (const record of records) {
        for (const nodeId of JSON.parse(record.covered_node_ids_json) as string[]) {
          confirmedNodeIds.add(nodeId);
          sourceByNode.set(nodeId, record.id);
        }
      }
      const pendingNodeIds = new Set(this.database.all<{ task_node_id: string }>(`
        SELECT task_node_id FROM task_node_confirmation_states
        WHERE tree_revision_id = ? AND state = 'pending_user_confirmation'
      `, confirmation.tree_revision_id).map((row) => row.task_node_id).filter((nodeId) => !confirmedNodeIds.has(nodeId)));
      const states = deriveConfirmationStates(document, confirmedNodeIds, pendingNodeIds);
      for (const node of document.nodes) {
        const state = states[node.id] ?? "draft";
        this.database.run(`
          INSERT INTO task_node_confirmation_states (
            project_id, tree_id, tree_revision_id, task_node_id, state, source_confirmation_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tree_revision_id, task_node_id) DO UPDATE SET
            state = excluded.state, source_confirmation_id = excluded.source_confirmation_id, updated_at = excluded.updated_at
        `, input.projectId, confirmation.tree_id, confirmation.tree_revision_id, node.id, state,
        sourceByNode.get(node.id) ?? null, timestamp);

        const currentStatus = this.database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = ?", node.id)?.status;
        if (state === "confirmed") {
          const dependenciesConfirmed = (node.dependencies ?? []).every((dependencyId) => states[dependencyId] === "confirmed");
          if (["draft", "pending_user_confirmation", "blocked_by_unconfirmed_dependency"].includes(currentStatus ?? "")) {
            this.database.run("UPDATE task_nodes SET status = ? WHERE id = ?", dependenciesConfirmed ? "ready" : "blocked_by_unconfirmed_dependency", node.id);
          }
        } else if (["ready", "blocked_by_unconfirmed_dependency"].includes(currentStatus ?? "")) {
          this.database.run("UPDATE task_nodes SET status = 'pending_user_confirmation' WHERE id = ?", node.id);
        }
      }

      allConfirmed = document.nodes.every((node) => states[node.id] === "confirmed");
      if (allConfirmed) {
        const transition = canTransitionWorkflow(workflow.stage, "skeleton_pass", { confirmationId: confirmation.id });
        if (!transition.ok) throw new HarnessError(transition.code, transition.reason);
        this.database.run("UPDATE workflow_states SET stage = 'skeleton_pass', revision = revision + 1, updated_at = ? WHERE id = ?", timestamp, workflow.id);
        this.database.run("UPDATE task_trees SET status = 'confirmed', updated_at = ? WHERE id = ?", timestamp, confirmation.tree_id);
      } else {
        this.database.run("UPDATE task_trees SET status = 'partially_confirmed', updated_at = ? WHERE id = ?", timestamp, confirmation.tree_id);
      }
    });
    return {
      stage: allConfirmed ? "skeleton_pass" as const : workflow.stage,
      workflowRevision: allConfirmed ? workflow.revision + 1 : workflow.revision,
      status: "confirmed" as const,
      scopeKind: confirmation.scope_kind,
      scopeRootNodeId: confirmation.scope_root_node_id,
      coveredNodeIds: [...covered],
    };
  }

  transition(input: {
    projectId: string;
    treeId: string;
    workflowRevision: number;
    to: WorkflowStage;
    confirmationId?: string;
    skeletonGateEvidenceId?: string;
  }) {
    const workflow = this.requireWorkflow(input.projectId, input.treeId, input.workflowRevision);
    const evidence: { confirmationId?: string; skeletonGateEvidenceId?: string } = {};
    if (input.confirmationId) evidence.confirmationId = input.confirmationId;
    if (input.skeletonGateEvidenceId) evidence.skeletonGateEvidenceId = input.skeletonGateEvidenceId;
    const result = canTransitionWorkflow(workflow.stage, input.to, evidence);
    if (!result.ok) throw new HarnessError(result.code, result.reason);
    if (workflow.stage === "skeleton_gate") {
      const skeletonAttempt = this.database.get<{ body_json: string }>(`
        SELECT nr.body_json
        FROM execution_attempts a
        JOIN task_node_revisions nr ON nr.id = a.task_node_revision_id
        WHERE a.id = ? AND a.project_id = ? AND a.tree_id = ? AND a.status = 'succeeded'
      `, input.skeletonGateEvidenceId ?? "", input.projectId, input.treeId);
      const body = skeletonAttempt ? JSON.parse(skeletonAttempt.body_json) as { executionPhase?: string } : undefined;
      if (body?.executionPhase !== "skeleton") {
        throw new HarnessError("workflow_transition_rejected", "skeleton gate evidence must reference a succeeded skeleton Execution Attempt");
      }
      const currentNodes = this.database.all<{ status: string; body_json: string }>(`
        SELECT n.status, nr.body_json
        FROM task_nodes n
        JOIN task_trees t ON t.id = n.tree_id
        JOIN task_node_revisions nr ON nr.node_id = n.id AND nr.tree_revision_id = t.current_revision_id
        WHERE n.tree_id = ?
      `, input.treeId);
      const skeletonNodes = currentNodes.filter((node) => (JSON.parse(node.body_json) as { executionPhase?: string }).executionPhase === "skeleton");
      if (!skeletonNodes.length || skeletonNodes.some((node) => node.status !== "succeeded")) {
        throw new HarnessError("workflow_transition_rejected", "every current skeleton Task Node must succeed before implementation");
      }
    }
    this.database.run("UPDATE workflow_states SET stage = ?, revision = revision + 1, updated_at = ? WHERE id = ?", input.to, nowIso(), workflow.id);
    return { stage: input.to, workflowRevision: workflow.revision + 1 };
  }

  private requireWorkflow(projectId: string, treeId: string, expectedRevision: number): WorkflowRow {
    const workflow = this.database.get<WorkflowRow>(
      "SELECT id, tree_id, stage, revision FROM workflow_states WHERE project_id = ? AND tree_id = ? AND active = 1",
      projectId, treeId,
    );
    if (!workflow) throw new HarnessError("not_found", "active workflow was not found");
    if (workflow.revision !== expectedRevision) throw new HarnessError("revision_conflict", "workflow revision does not match current state");
    return workflow;
  }
}
