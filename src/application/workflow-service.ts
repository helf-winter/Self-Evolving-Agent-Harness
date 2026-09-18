import { HarnessError } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
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
}

export class WorkflowService {
  constructor(private readonly database: RuntimeDatabase) {}

  createConfirmationPrompt(input: {
    projectId: string;
    treeId: string;
    scopeId: string;
    prompt: string;
    workflowRevision: number;
  }) {
    const workflow = this.requireWorkflow(input.projectId, input.treeId, input.workflowRevision);
    if (workflow.stage !== "branch_confirmation") {
      throw new HarnessError("workflow_transition_rejected", "scope confirmation is only valid at branch_confirmation");
    }
    if (!input.prompt.trim()) throw new HarnessError("invalid_input", "confirmation prompt is required");
    const confirmationId = newId();
    this.database.run(
      "INSERT INTO runtime_confirmation_prompts (id, project_id, tree_id, scope_id, prompt, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
      confirmationId, input.projectId, input.treeId, input.scopeId, input.prompt.trim(), nowIso(),
    );
    return { confirmationId, status: "pending" as const, scopeId: input.scopeId, prompt: input.prompt.trim() };
  }

  confirmScope(input: {
    projectId: string;
    confirmationId: string;
    answer: "yes" | "no";
    answerTraceEventId: string;
    workflowRevision: number;
  }) {
    const confirmation = this.database.get<ConfirmationRow>(
      "SELECT id, project_id, tree_id, scope_id, status FROM runtime_confirmation_prompts WHERE id = ? AND project_id = ?",
      input.confirmationId, input.projectId,
    );
    if (!confirmation || confirmation.status !== "pending") throw new HarnessError("not_found", "pending confirmation was not found");
    const workflow = this.requireWorkflow(input.projectId, confirmation.tree_id, input.workflowRevision);
    const evidence = this.database.get<{ id: string }>(
      "SELECT id FROM trace_events WHERE id = ? AND project_id = ? AND event_name = 'UserPromptSubmit'",
      input.answerTraceEventId, input.projectId,
    );
    if (!evidence) throw new HarnessError("workflow_transition_rejected", "a recorded user answer Trace Event is required");

    if (input.answer === "no") {
      this.database.run(
        "UPDATE runtime_confirmation_prompts SET status = 'rejected', answer = ?, answer_trace_event_id = ?, resolved_at = ? WHERE id = ?",
        input.answer, input.answerTraceEventId, nowIso(), confirmation.id,
      );
      return { stage: workflow.stage, workflowRevision: workflow.revision, status: "rejected" as const };
    }

    const transition = canTransitionWorkflow(workflow.stage, "skeleton_pass", { confirmationId: confirmation.id });
    if (!transition.ok) throw new HarnessError(transition.code, transition.reason);
    const timestamp = nowIso();
    this.database.transaction(() => {
      this.database.run(
        "UPDATE runtime_confirmation_prompts SET status = 'confirmed', answer = ?, answer_trace_event_id = ?, resolved_at = ? WHERE id = ?",
        input.answer, input.answerTraceEventId, timestamp, confirmation.id,
      );
      this.database.run("UPDATE artifacts SET status = 'planned', updated_at = ? WHERE tree_id = ? AND status = 'draft'", timestamp, confirmation.tree_id);
      this.database.run("UPDATE workflow_states SET stage = 'skeleton_pass', revision = revision + 1, updated_at = ? WHERE id = ?", timestamp, workflow.id);
      this.database.run("UPDATE task_trees SET status = 'confirmed', updated_at = ? WHERE id = ?", timestamp, confirmation.tree_id);
      this.database.run(`
        UPDATE task_nodes SET status = 'ready'
        WHERE tree_id = ? AND status IN ('draft', 'pending_user_confirmation')
          AND EXISTS (
            SELECT 1 FROM task_trees t
            JOIN task_node_revisions nr ON nr.node_id = task_nodes.id AND nr.tree_revision_id = t.current_revision_id
            WHERE t.id = task_nodes.tree_id
          )
      `, confirmation.tree_id);
    });
    return { stage: "skeleton_pass" as const, workflowRevision: workflow.revision + 1, status: "confirmed" as const };
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
