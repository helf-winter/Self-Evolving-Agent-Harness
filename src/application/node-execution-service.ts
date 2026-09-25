import { HarnessError } from "../domain/errors.js";
import type { ExecutionAttemptStatus } from "../domain/execution.js";
import { newId, nowIso } from "../domain/ids.js";
import type { RequiredEvidence, TaskNodeInput } from "../domain/task-tree.js";
import type { WorkflowStage } from "../domain/workflow.js";
import type { RuntimeDatabase } from "../storage/database.js";

interface ExecutableNodeRow {
  node_id: string;
  tree_id: string;
  node_status: string;
  current_revision_id: string;
  node_revision_id: string;
  body_json: string;
  workflow_stage: WorkflowStage;
  confirmation_state: string;
}

interface AttemptRow {
  id: string;
  project_id: string;
  tree_id: string;
  task_node_id: string;
  task_node_revision_id: string;
  attempt_number: number;
  status: ExecutionAttemptStatus;
  started_at: string;
  completed_at: string | null;
}

interface TraceRow {
  id: string;
  project_id: string;
  tree_id: string | null;
  node_id: string | null;
  occurred_at: string;
}

export interface ExecutionAttemptView {
  attemptId: string;
  projectId: string;
  treeId: string;
  nodeId: string;
  nodeRevisionId: string;
  attemptNumber: number;
  status: ExecutionAttemptStatus;
  startedAt: string;
  completedAt: string | null;
}

export interface AttemptEvidenceView {
  attemptId: string;
  requiredEvidenceKey: string;
  traceEventId: string;
  createdAt: string;
}

const stagePhase: Partial<Record<WorkflowStage, TaskNodeInput["executionPhase"]>> = {
  skeleton_pass: "skeleton",
  branch_implementation: "implementation",
  branch_verification: "verification",
  root_verification: "verification",
};

export class NodeExecutionService {
  constructor(private readonly database: RuntimeDatabase) {}

  startAttempt(input: { projectId: string; nodeId: string; expectedTreeRevisionId: string }): ExecutionAttemptView {
    const attemptId = newId();
    const startedAt = nowIso();
    this.database.transaction(() => {
      const node = this.requireExecutableNode(input.projectId, input.nodeId);
      if (node.current_revision_id !== input.expectedTreeRevisionId) {
        throw new HarnessError("revision_conflict", "Task Tree revision does not match current state");
      }
      if (this.database.get("SELECT id FROM execution_attempts WHERE task_node_id = ? AND status IN ('running', 'verifying')", node.node_id)) {
        throw new HarnessError("attempt_already_active", "Task Node already has an active attempt");
      }
      if (!(["ready", "failed", "needs_revalidation"] as string[]).includes(node.node_status)) {
        throw new HarnessError("attempt_not_executable", `Task Node status ${node.node_status} is not executable`);
      }
      if (node.confirmation_state !== "confirmed") {
        throw new HarnessError("attempt_not_executable", "current Task Node revision is not confirmed");
      }
      const body = JSON.parse(node.body_json) as TaskNodeInput;
      if (!body.requiredEvidence?.length) {
        throw new HarnessError("attempt_not_executable", "an executable Task Node must declare required evidence");
      }
      if (stagePhase[node.workflow_stage] !== body.executionPhase) {
        throw new HarnessError("attempt_not_executable", `Task Node phase ${body.executionPhase ?? "undefined"} is not allowed during ${node.workflow_stage}`);
      }
      this.requireSucceededDependencies(node.tree_id, body.dependencies ?? []);
      if (body.executionPhase === "verification") {
        this.requireSucceededCurrentChildren(node.tree_id, node.node_id);
      }
      const attemptNumber = (this.database.get<{ maximum: number | null }>(
        "SELECT MAX(attempt_number) AS maximum FROM execution_attempts WHERE task_node_revision_id = ?",
        node.node_revision_id,
      )?.maximum ?? 0) + 1;
      this.database.run(
        "INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)",
        attemptId, input.projectId, node.tree_id, node.node_id, node.node_revision_id, attemptNumber, startedAt,
      );
      this.database.run("UPDATE task_nodes SET status = 'running' WHERE id = ?", node.node_id);
      this.database.run(
        "UPDATE runtime_states SET selected_tree_id = ?, selected_node_id = ?, updated_at = ? WHERE project_id = ?",
        node.tree_id, node.node_id, startedAt, input.projectId,
      );
    });
    return this.requireAttempt(input.projectId, attemptId);
  }

  beginVerification(input: { projectId: string; attemptId: string; expectedStatus: "running" }): ExecutionAttemptView {
    const attempt = this.requireAttemptRow(input.projectId, input.attemptId);
    this.assertAttemptStatus(attempt, input.expectedStatus);
    this.database.transaction(() => {
      this.database.run("UPDATE execution_attempts SET status = 'verifying' WHERE id = ?", attempt.id);
      this.database.run("UPDATE task_nodes SET status = 'verifying' WHERE id = ?", attempt.task_node_id);
    });
    return this.requireAttempt(input.projectId, input.attemptId);
  }

  attachEvidence(input: { projectId: string; attemptId: string; requiredEvidenceKey: string; traceEventId: string }): AttemptEvidenceView {
    const attempt = this.requireAttemptRow(input.projectId, input.attemptId);
    if (!(["running", "verifying"] as ExecutionAttemptStatus[]).includes(attempt.status)) {
      throw new HarnessError("attempt_state_conflict", "evidence can only be attached to an active attempt");
    }
    const nodeRevision = this.database.get<{ body_json: string }>("SELECT body_json FROM task_node_revisions WHERE id = ?", attempt.task_node_revision_id);
    const requiredEvidence = (JSON.parse(nodeRevision?.body_json ?? "{}") as TaskNodeInput).requiredEvidence ?? [];
    if (!requiredEvidence.some((item: RequiredEvidence) => item.key === input.requiredEvidenceKey)) {
      throw new HarnessError("invalid_input", "required evidence key is not declared by this Task Node revision");
    }
    const trace = this.database.get<TraceRow>("SELECT id, project_id, tree_id, node_id, occurred_at FROM trace_events WHERE id = ?", input.traceEventId);
    if (!trace) throw new HarnessError("evidence_not_found", "Trace evidence was not found");
    if (trace.project_id !== attempt.project_id || trace.tree_id !== attempt.tree_id || trace.node_id !== attempt.task_node_id || trace.occurred_at < attempt.started_at) {
      throw new HarnessError("evidence_scope_mismatch", "Trace evidence must belong to this Task Node attempt and occur after it starts");
    }
    const createdAt = nowIso();
    this.database.run(
      "INSERT INTO execution_attempt_evidence (attempt_id, required_evidence_key, trace_event_id, created_at) VALUES (?, ?, ?, ?)",
      attempt.id, input.requiredEvidenceKey, trace.id, createdAt,
    );
    return { attemptId: attempt.id, requiredEvidenceKey: input.requiredEvidenceKey, traceEventId: trace.id, createdAt };
  }

  abortAttempt(input: { projectId: string; attemptId: string; expectedStatus: "running" | "verifying" }): ExecutionAttemptView {
    const attempt = this.requireAttemptRow(input.projectId, input.attemptId);
    this.assertAttemptStatus(attempt, input.expectedStatus);
    const completedAt = nowIso();
    this.database.transaction(() => {
      this.database.run("UPDATE execution_attempts SET status = 'aborted', completed_at = ? WHERE id = ?", completedAt, attempt.id);
      const current = this.database.get<{ current_revision_id: string }>("SELECT current_revision_id FROM task_trees WHERE id = ?", attempt.tree_id);
      const revision = this.database.get<{ tree_revision_id: string }>("SELECT tree_revision_id FROM task_node_revisions WHERE id = ?", attempt.task_node_revision_id);
      this.database.run("UPDATE task_nodes SET status = ? WHERE id = ?", current?.current_revision_id === revision?.tree_revision_id ? "ready" : "needs_revalidation", attempt.task_node_id);
    });
    return this.requireAttempt(input.projectId, input.attemptId);
  }

  private requireExecutableNode(projectId: string, nodeId: string): ExecutableNodeRow {
    const row = this.database.get<ExecutableNodeRow>(`
      SELECT n.id AS node_id, n.tree_id, n.status AS node_status,
             t.current_revision_id, nr.id AS node_revision_id, nr.body_json,
             w.stage AS workflow_stage, cs.state AS confirmation_state
      FROM task_nodes n
      JOIN task_trees t ON t.id = n.tree_id
      JOIN task_node_revisions nr ON nr.node_id = n.id AND nr.tree_revision_id = t.current_revision_id
      JOIN task_node_confirmation_states cs ON cs.task_node_id = n.id AND cs.tree_revision_id = t.current_revision_id
      JOIN workflow_states w ON w.tree_id = t.id AND w.project_id = t.project_id AND w.active = 1
      WHERE n.id = ? AND t.project_id = ?
    `, nodeId, projectId);
    if (!row) throw new HarnessError("not_found", "current Task Node revision was not found in this Project");
    return row;
  }

  private requireSucceededDependencies(treeId: string, dependencyIds: string[]): void {
    for (const dependencyId of dependencyIds) {
      const dependency = this.database.get<{ status: string }>(`
        SELECT n.status
        FROM task_nodes n
        JOIN task_trees t ON t.id = n.tree_id
        JOIN task_node_revisions nr ON nr.node_id = n.id AND nr.tree_revision_id = t.current_revision_id
        WHERE n.id = ? AND n.tree_id = ?
      `, dependencyId, treeId);
      if (dependency?.status !== "succeeded") {
        throw new HarnessError("attempt_not_executable", `dependency ${dependencyId} has not succeeded`);
      }
    }
  }

  private requireSucceededCurrentChildren(treeId: string, parentNodeId: string): void {
    const incompleteChild = this.database.get<{ id: string; status: string }>(`
      SELECT n.id, n.status
      FROM task_nodes n
      JOIN task_trees t ON t.id = n.tree_id
      JOIN task_node_revisions nr ON nr.node_id = n.id AND nr.tree_revision_id = t.current_revision_id
      WHERE n.tree_id = ? AND n.parent_id = ? AND n.status <> 'succeeded'
      ORDER BY n.id LIMIT 1
    `, treeId, parentNodeId);
    if (incompleteChild) {
      throw new HarnessError(
        "attempt_not_executable",
        `child ${incompleteChild.id} has not succeeded and parent verification cannot start`,
        { childNodeId: incompleteChild.id, childStatus: incompleteChild.status },
      );
    }
  }

  private requireAttemptRow(projectId: string, attemptId: string): AttemptRow {
    const attempt = this.database.get<AttemptRow>(`
      SELECT id, project_id, tree_id, task_node_id, task_node_revision_id,
             attempt_number, status, started_at, completed_at
      FROM execution_attempts WHERE id = ? AND project_id = ?
    `, attemptId, projectId);
    if (!attempt) throw new HarnessError("not_found", "Execution Attempt was not found in this Project");
    return attempt;
  }

  private requireAttempt(projectId: string, attemptId: string): ExecutionAttemptView {
    const attempt = this.requireAttemptRow(projectId, attemptId);
    return {
      attemptId: attempt.id,
      projectId: attempt.project_id,
      treeId: attempt.tree_id,
      nodeId: attempt.task_node_id,
      nodeRevisionId: attempt.task_node_revision_id,
      attemptNumber: attempt.attempt_number,
      status: attempt.status,
      startedAt: attempt.started_at,
      completedAt: attempt.completed_at,
    };
  }

  private assertAttemptStatus(attempt: AttemptRow, expectedStatus: ExecutionAttemptStatus): void {
    if (attempt.status !== expectedStatus) {
      throw new HarnessError("attempt_state_conflict", `expected attempt status ${expectedStatus}, received ${attempt.status}`);
    }
  }
}
