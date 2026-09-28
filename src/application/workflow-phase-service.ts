import { HarnessError } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
import type { TaskNodeInput, TaskTreeDocument } from "../domain/task-tree.js";
import { canonicalJson } from "../domain/trace.js";
import type { WorkflowStage } from "../domain/workflow.js";
import type { RuntimeDatabase } from "../storage/database.js";

type PhaseStage = "branch_implementation" | "branch_verification" | "root_verification";
type GateStatus = "passed" | "failed" | "uncertain";

interface WorkflowRow {
  id: string;
  stage: WorkflowStage;
  revision: number;
  active_branch_node_id: string | null;
}

interface PhaseResultRow {
  id: string; project_id: string; tree_id: string; tree_revision_id: string; workflow_revision: number;
  stage: PhaseStage; branch_node_id: string | null; status: GateStatus; required_node_ids_json: string;
  incomplete_node_ids_json: string; blocking_drift_ids_json: string; blocker_codes_json: string;
  next_stage: string; next_branch_node_id: string | null; created_at: string;
}

export class WorkflowPhaseService {
  constructor(private readonly database: RuntimeDatabase) {}

  evaluate(input: { projectId: string; treeId: string; workflowRevision: number }) {
    return this.database.transaction(() => this.evaluateWithinTransaction(input));
  }

  list(projectId: string, options: { treeId?: string; resultId?: string } = {}) {
    const clauses = ["project_id = ?"];
    const params: string[] = [projectId];
    if (options.treeId) { clauses.push("tree_id = ?"); params.push(options.treeId); }
    if (options.resultId) { clauses.push("id = ?"); params.push(options.resultId); }
    return this.database.all<PhaseResultRow>(`
      SELECT * FROM workflow_phase_gate_results WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT 200
    `, ...params).map((row) => this.view(row));
  }

  private evaluateWithinTransaction(input: { projectId: string; treeId: string; workflowRevision: number }) {
    const workflow = this.database.get<WorkflowRow>(`
      SELECT id, stage, revision, active_branch_node_id
      FROM workflow_states WHERE project_id = ? AND tree_id = ? AND active = 1
    `, input.projectId, input.treeId);
    if (!workflow) throw new HarnessError("not_found", "active Workflow was not found");
    if (workflow.revision !== input.workflowRevision) throw new HarnessError("revision_conflict", "workflow revision does not match current state");
    if (!(["branch_implementation", "branch_verification", "root_verification"] as string[]).includes(workflow.stage)) {
      throw new HarnessError("workflow_transition_rejected", "the current Workflow stage has no executable phase gate");
    }
    const stage = workflow.stage as PhaseStage;
    const tree = this.database.get<{ current_revision_id: string; document_json: string }>(`
      SELECT t.current_revision_id, r.document_json FROM task_trees t
      JOIN task_tree_revisions r ON r.id = t.current_revision_id
      WHERE t.id = ? AND t.project_id = ? AND t.archived_at IS NULL
    `, input.treeId, input.projectId);
    if (!tree) throw new HarnessError("not_found", "current Task Tree revision was not found");
    const document = JSON.parse(tree.document_json) as TaskTreeDocument;
    const root = document.nodes.find((node) => node.parentId === null);
    if (!root) throw new HarnessError("invalid_input", "Task Tree root was not found");
    const branchNodeId = stage === "root_verification" ? null : workflow.active_branch_node_id;
    if (stage !== "root_verification" && !branchNodeId) {
      throw new HarnessError("workflow_transition_rejected", "the Workflow has no active branch");
    }
    const scope = stage === "root_verification" ? new Set([root.id]) : this.descendants(document, branchNodeId!);
    const expectedPhase = stage === "branch_implementation" ? "implementation" : "verification";
    const rows = this.database.all<{ id: string; status: string; body_json: string; confirmation_state: string }>(`
      SELECT n.id, n.status, nr.body_json, COALESCE(cs.state, 'draft') AS confirmation_state
      FROM task_nodes n
      JOIN task_node_revisions nr ON nr.node_id = n.id AND nr.tree_revision_id = ?
      LEFT JOIN task_node_confirmation_states cs ON cs.tree_revision_id = ? AND cs.task_node_id = n.id
      WHERE n.tree_id = ? ORDER BY n.id
    `, tree.current_revision_id, tree.current_revision_id, input.treeId);
    const requiredNodeIds = rows.filter((row) => scope.has(row.id)
      && row.confirmation_state === "confirmed"
      && (JSON.parse(row.body_json) as TaskNodeInput).executionPhase === expectedPhase).map((row) => row.id);
    const statuses = new Map(rows.map((row) => [row.id, row.status]));
    const incompleteNodeIds = requiredNodeIds.filter((nodeId) => statuses.get(nodeId) !== "succeeded");
    const blockingDriftIds = this.database.all<{ id: string; task_node_id: string | null }>(`
      SELECT id, task_node_id FROM plan_drift_records
      WHERE project_id = ? AND tree_id = ? AND severity = 'blocking'
        AND resolution_status = 'pending_user_confirmation'
      ORDER BY created_at, id
    `, input.projectId, input.treeId).filter((drift) => stage === "root_verification" || drift.task_node_id === null || scope.has(drift.task_node_id)).map((drift) => drift.id);
    const blockerCodes: Array<{ code: string; ref: string }> = [];
    if (!requiredNodeIds.length && stage !== "branch_implementation") {
      blockerCodes.push({ code: stage === "root_verification" ? "root_verification_node_missing" : "branch_verification_node_missing", ref: branchNodeId ?? root.id });
    }
    for (const nodeId of incompleteNodeIds) blockerCodes.push({ code: "phase_node_incomplete", ref: nodeId });
    for (const driftId of blockingDriftIds) blockerCodes.push({ code: "blocking_drift", ref: driftId });
    const status: GateStatus = blockerCodes.some((blocker) => blocker.code.endsWith("_missing"))
      ? "uncertain" : blockerCodes.length ? "failed" : "passed";
    let nextStage: WorkflowStage = stage;
    let nextBranchNodeId = branchNodeId;
    if (status === "passed") {
      if (stage === "branch_implementation") {
        nextStage = "branch_verification";
        this.database.run(`UPDATE workflow_branch_states SET status = 'implemented', updated_at = ?
          WHERE tree_revision_id = ? AND branch_node_id = ?`, nowIso(), tree.current_revision_id, branchNodeId!);
      } else if (stage === "branch_verification") {
        this.database.run(`UPDATE workflow_branch_states SET status = 'verified', updated_at = ?
          WHERE tree_revision_id = ? AND branch_node_id = ?`, nowIso(), tree.current_revision_id, branchNodeId!);
        const next = this.database.get<{ branch_node_id: string }>(`
          SELECT branch_node_id FROM workflow_branch_states
          WHERE tree_revision_id = ? AND status = 'pending' ORDER BY branch_order LIMIT 1
        `, tree.current_revision_id);
        if (next) {
          nextStage = "branch_implementation";
          nextBranchNodeId = next.branch_node_id;
          this.database.run(`UPDATE workflow_branch_states SET status = 'active', updated_at = ?
            WHERE tree_revision_id = ? AND branch_node_id = ?`, nowIso(), tree.current_revision_id, next.branch_node_id);
        } else {
          nextStage = "root_verification";
          nextBranchNodeId = null;
        }
      } else {
        nextStage = "final_report";
        nextBranchNodeId = null;
      }
    }
    const resultId = newId();
    const createdAt = nowIso();
    this.database.run(`
      INSERT INTO workflow_phase_gate_results (
        id, project_id, tree_id, tree_revision_id, workflow_revision, stage, branch_node_id,
        status, required_node_ids_json, incomplete_node_ids_json, blocking_drift_ids_json,
        blocker_codes_json, next_stage, next_branch_node_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, resultId, input.projectId, input.treeId, tree.current_revision_id, workflow.revision, stage, branchNodeId,
    status, canonicalJson(requiredNodeIds), canonicalJson(incompleteNodeIds), canonicalJson(blockingDriftIds),
    canonicalJson(blockerCodes), nextStage, nextBranchNodeId, createdAt);
    if (status === "passed") {
      this.database.run(`UPDATE workflow_states SET stage = ?, active_branch_node_id = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?`, nextStage, nextBranchNodeId, createdAt, workflow.id);
    }
    return {
      resultId, projectId: input.projectId, treeId: input.treeId, treeRevisionId: tree.current_revision_id,
      workflowRevision: workflow.revision, stage, branchNodeId, status, requiredNodeIds, incompleteNodeIds,
      blockingDriftIds, blockerCodes, nextStage, nextBranchNodeId,
      workflow: { stage: status === "passed" ? nextStage : stage, revision: workflow.revision + (status === "passed" ? 1 : 0), activeBranchNodeId: status === "passed" ? nextBranchNodeId : branchNodeId },
      createdAt,
    };
  }

  private descendants(document: TaskTreeDocument, rootId: string): Set<string> {
    const byId = new Map(document.nodes.map((node) => [node.id, node]));
    const result = new Set<string>();
    const visit = (id: string) => {
      if (result.has(id)) return;
      result.add(id);
      for (const child of byId.get(id)?.children ?? []) visit(child);
    };
    visit(rootId);
    return result;
  }

  private view(row: PhaseResultRow) {
    return {
      resultId: row.id, projectId: row.project_id, treeId: row.tree_id, treeRevisionId: row.tree_revision_id,
      workflowRevision: row.workflow_revision, stage: row.stage, branchNodeId: row.branch_node_id, status: row.status,
      requiredNodeIds: JSON.parse(row.required_node_ids_json) as string[],
      incompleteNodeIds: JSON.parse(row.incomplete_node_ids_json) as string[],
      blockingDriftIds: JSON.parse(row.blocking_drift_ids_json) as string[],
      blockerCodes: JSON.parse(row.blocker_codes_json) as unknown[], nextStage: row.next_stage,
      nextBranchNodeId: row.next_branch_node_id, createdAt: row.created_at,
    };
  }
}
