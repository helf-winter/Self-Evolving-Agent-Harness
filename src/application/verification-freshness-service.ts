import { newId, nowIso } from "../domain/ids.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";

interface WorkflowRow {
  id: string;
  tree_id: string;
  stage: string;
  revision: number;
  active_branch_node_id: string | null;
  selected_node_id: string | null;
  current_revision_id: string;
}

const freshnessStages = new Set([
  "skeleton_pass", "skeleton_gate", "branch_implementation", "branch_verification", "root_verification", "final_report",
]);
const stageRank = new Map([
  ["skeleton_pass", 0], ["skeleton_gate", 0], ["branch_implementation", 1],
  ["branch_verification", 2], ["root_verification", 3], ["final_report", 4],
]);
const executionPhaseRank = new Map([["skeleton", 0], ["implementation", 1], ["verification", 2]]);

interface CurrentNodeRow {
  id: string;
  parent_id: string | null;
  status: string;
  body_json: string;
}

interface VerificationInvalidationRow {
  id: string;
  project_id: string;
  tree_id: string;
  tree_revision_id: string;
  source_trace_event_id: string;
  artifact_id: string | null;
  workflow_revision: number;
  prior_stage: string;
  next_stage: string;
  affected_node_ids_json: string;
  invalidated_evaluation_ids_json: string;
  invalidated_gate_result_ids_json: string;
  created_at: string;
}

export class VerificationFreshnessService {
  constructor(private readonly database: RuntimeDatabase) {}

  list(projectId: string, options: { treeId?: string; invalidationId?: string } = {}) {
    const clauses = ["project_id = ?"];
    const params: string[] = [projectId];
    if (options.treeId) { clauses.push("tree_id = ?"); params.push(options.treeId); }
    if (options.invalidationId) { clauses.push("id = ?"); params.push(options.invalidationId); }
    return this.database.all<VerificationInvalidationRow>(`
      SELECT * FROM verification_invalidations WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT 200
    `, ...params).map((row) => ({
      invalidationId: row.id,
      projectId: row.project_id,
      treeId: row.tree_id,
      treeRevisionId: row.tree_revision_id,
      sourceTraceEventId: row.source_trace_event_id,
      artifactId: row.artifact_id,
      workflowRevision: row.workflow_revision,
      priorStage: row.prior_stage,
      nextStage: row.next_stage,
      affectedNodeIds: JSON.parse(row.affected_node_ids_json) as string[],
      invalidatedEvaluationIds: JSON.parse(row.invalidated_evaluation_ids_json) as string[],
      invalidatedGateResultIds: JSON.parse(row.invalidated_gate_result_ids_json) as string[],
      createdAt: row.created_at,
    }));
  }

  invalidateMutationWithinTransaction(input: {
    projectId: string;
    treeId: string;
    sourceTraceEventId: string;
    artifactId?: string;
    fallbackNodeId?: string;
  }) {
    const workflow = this.database.get<WorkflowRow>(`
      SELECT w.id, w.tree_id, w.stage, w.revision, w.active_branch_node_id,
             r.selected_node_id, t.current_revision_id
      FROM workflow_states w
      JOIN task_trees t ON t.id = w.tree_id AND t.project_id = w.project_id
      LEFT JOIN runtime_states r ON r.project_id = w.project_id
      WHERE w.project_id = ? AND w.tree_id = ? AND w.active = 1
    `, input.projectId, input.treeId);
    if (!workflow || !freshnessStages.has(workflow.stage)) return null;

    const relatedArtifactIds = new Set(input.artifactId ? [input.artifactId] : []);
    if (input.artifactId) {
      const relations = this.database.all<{ from_artifact_id: string; to_artifact_id: string }>(`
        SELECT from_artifact_id, to_artifact_id FROM artifact_graph_relations
        WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?
      `, input.projectId, input.treeId, workflow.current_revision_id);
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const relation of relations) {
          if (relatedArtifactIds.has(relation.from_artifact_id) && !relatedArtifactIds.has(relation.to_artifact_id)) {
            relatedArtifactIds.add(relation.to_artifact_id);
            expanded = true;
          }
          if (relatedArtifactIds.has(relation.to_artifact_id) && !relatedArtifactIds.has(relation.from_artifact_id)) {
            relatedArtifactIds.add(relation.from_artifact_id);
            expanded = true;
          }
        }
      }
    }
    const artifactPlaceholders = [...relatedArtifactIds].map(() => "?").join(", ");
    const linkedNodeIds = relatedArtifactIds.size ? this.database.all<{ task_node_id: string }>(`
      SELECT DISTINCT task_node_id FROM task_node_artifact_links
      WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?
        AND artifact_id IN (${artifactPlaceholders})
      ORDER BY task_node_id
    `, input.projectId, input.treeId, workflow.current_revision_id,
    ...relatedArtifactIds).map((row) => row.task_node_id) : [];
    const candidateNodeIds = linkedNodeIds.length
      ? linkedNodeIds
      : [input.fallbackNodeId ?? workflow.selected_node_id].filter((value): value is string => Boolean(value));
    if (!candidateNodeIds.length) return null;

    const nodes = this.database.all<CurrentNodeRow>(`
      SELECT n.id, n.parent_id, n.status, nr.body_json
      FROM task_nodes n
      JOIN task_node_revisions nr ON nr.node_id = n.id AND nr.tree_revision_id = ?
      WHERE n.tree_id = ? ORDER BY n.id
    `, workflow.current_revision_id, input.treeId);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const impact = new Set(candidateNodeIds.filter((nodeId) => byId.has(nodeId)));
    const taskRelations = this.database.all<{ from_node_id: string; to_node_id: string; kind: string }>(`
      SELECT from_node_id, to_node_id, kind FROM task_relation_edges
      WHERE tree_revision_id = ?
    `, workflow.current_revision_id);
    const symmetricRelations = new Set(["exchanges_data_with", "data_exchange", "shares_artifact_with", "shares_contract", "coordinates_with"]);
    let taskImpactExpanded = true;
    while (taskImpactExpanded) {
      taskImpactExpanded = false;
      for (const relation of taskRelations) {
        if (impact.has(relation.to_node_id) && !impact.has(relation.from_node_id)) {
          impact.add(relation.from_node_id);
          taskImpactExpanded = true;
        }
        if (symmetricRelations.has(relation.kind)
          && impact.has(relation.from_node_id) && !impact.has(relation.to_node_id)) {
          impact.add(relation.to_node_id);
          taskImpactExpanded = true;
        }
      }
    }
    for (const nodeId of [...impact]) {
      let parentId = byId.get(nodeId)?.parent_id ?? null;
      while (parentId) {
        const parent = byId.get(parentId);
        if (!parent) break;
        const body = JSON.parse(parent.body_json) as { executionPhase?: string };
        if (body.executionPhase) impact.add(parent.id);
        parentId = parent.parent_id;
      }
    }
    const rootId = nodes.find((node) => node.parent_id === null)?.id ?? null;
    const branchFor = (nodeId: string): string | null => {
      let current = byId.get(nodeId);
      while (current?.parent_id && current.parent_id !== rootId) current = byId.get(current.parent_id);
      return current?.parent_id === rootId ? current.id : null;
    };
    const initiallyImpactedBranches = new Set([...impact].map(branchFor).filter((value): value is string => Boolean(value)));
    const initiallyImpactedPhases = new Set([...impact].map((nodeId) => {
      const body = JSON.parse(byId.get(nodeId)!.body_json) as { executionPhase?: string };
      return body.executionPhase;
    }));
    if (initiallyImpactedPhases.has("skeleton") || initiallyImpactedPhases.has("implementation")) {
      for (const node of nodes) {
        const body = JSON.parse(node.body_json) as { executionPhase?: string };
        const downstreamPhase = body.executionPhase === "verification"
          || (initiallyImpactedPhases.has("skeleton") && body.executionPhase === "implementation");
        if (downstreamPhase && initiallyImpactedBranches.has(branchFor(node.id) ?? "")) impact.add(node.id);
      }
    }
    const earliestImpactedPhaseRank = Math.min(...[...impact].map((nodeId) => {
      const body = JSON.parse(byId.get(nodeId)!.body_json) as { executionPhase?: string };
      return executionPhaseRank.get(body.executionPhase ?? "") ?? Number.POSITIVE_INFINITY;
    }));
    const forcedInvalidatedNodeIds = new Set<string>();
    const impactPlaceholders = [...impact].map(() => "?").join(", ");
    const staleActiveAttempts = impact.size && Number.isFinite(earliestImpactedPhaseRank)
      ? this.database.all<{ id: string; task_node_id: string; body_json: string }>(`
          SELECT a.id, a.task_node_id, nr.body_json
          FROM execution_attempts a
          JOIN task_node_revisions nr ON nr.id = a.task_node_revision_id
          WHERE a.project_id = ? AND a.tree_id = ? AND a.status IN ('running', 'verifying')
            AND a.task_node_id IN (${impactPlaceholders})
        `, input.projectId, input.treeId, ...impact).filter((attempt) => {
          const body = JSON.parse(attempt.body_json) as { executionPhase?: string };
          return (executionPhaseRank.get(body.executionPhase ?? "") ?? -1) > earliestImpactedPhaseRank;
        })
      : [];
    const createdAt = nowIso();
    for (const attempt of staleActiveAttempts) {
      this.database.run(
        "UPDATE execution_attempts SET status = 'aborted', completed_at = ? WHERE id = ?",
        createdAt, attempt.id,
      );
      this.database.run(
        "UPDATE task_nodes SET status = 'needs_revalidation' WHERE id = ?",
        attempt.task_node_id,
      );
      forcedInvalidatedNodeIds.add(attempt.task_node_id);
    }
    const affectedNodeIds = [...impact]
      .filter((nodeId) => byId.get(nodeId)?.status === "succeeded" || forcedInvalidatedNodeIds.has(nodeId))
      .sort();
    if (!affectedNodeIds.length) return null;

    const phases = new Set(affectedNodeIds.map((nodeId) => {
      const body = JSON.parse(byId.get(nodeId)!.body_json) as { executionPhase?: string };
      return body.executionPhase;
    }));
    const branchIds = new Set<string>();
    for (const nodeId of affectedNodeIds) {
      const branchId = branchFor(nodeId);
      if (branchId) branchIds.add(branchId);
    }
    const branchStates = this.database.all<{ branch_node_id: string; branch_order: number }>(`
      SELECT branch_node_id, branch_order FROM workflow_branch_states
      WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?
      ORDER BY branch_order
    `, input.projectId, input.treeId, workflow.current_revision_id);
    const affectedBranches = branchStates.filter((branch) => branchIds.has(branch.branch_node_id));
    const requiredStage = phases.has("skeleton")
      ? "skeleton_pass"
      : phases.has("implementation") && affectedBranches.length
        ? "branch_implementation"
        : phases.has("verification") && affectedBranches.length
          ? "branch_verification"
          : "root_verification";
    const nextStage = (stageRank.get(workflow.stage) ?? 4) <= (stageRank.get(requiredStage) ?? 4)
      ? workflow.stage === "skeleton_gate" ? "skeleton_pass" : workflow.stage
      : requiredStage;
    const activeAttempt = this.database.get<{ id: string }>(`
      SELECT id FROM execution_attempts
      WHERE project_id = ? AND tree_id = ? AND status IN ('running', 'verifying')
      ORDER BY started_at, id LIMIT 1
    `, input.projectId, input.treeId);
    const preserveActiveBranch = Boolean(activeAttempt && workflow.active_branch_node_id
      && (nextStage === "branch_implementation" || nextStage === "branch_verification"));
    const nextBranchNodeId = nextStage === "branch_implementation" || nextStage === "branch_verification"
      ? preserveActiveBranch ? workflow.active_branch_node_id : affectedBranches[0]?.branch_node_id ?? null
      : null;

    const affectedPlaceholders = affectedNodeIds.map(() => "?").join(", ");
    const invalidatedEvaluationIds = this.database.all<{ id: string }>(`
      SELECT e.id FROM evaluations e
      JOIN task_node_revisions nr ON nr.id = e.task_node_revision_id
      WHERE e.project_id = ? AND e.tree_id = ? AND nr.tree_revision_id = ?
        AND e.task_node_id IN (${affectedPlaceholders}) AND e.verdict = 'succeeded'
      ORDER BY e.created_at, e.id
    `, input.projectId, input.treeId, workflow.current_revision_id, ...affectedNodeIds).map((row) => row.id);
    const invalidatedGateResultIds = this.database.all<{ id: string }>(`
      SELECT id FROM workflow_phase_gate_results
      WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ? AND status = 'passed'
      ORDER BY created_at, id
    `, input.projectId, input.treeId, workflow.current_revision_id).map((row) => row.id);

    const invalidationId = newId();
    this.database.run(`
      INSERT INTO verification_invalidations (
        id, project_id, tree_id, tree_revision_id, source_trace_event_id, artifact_id,
        workflow_revision, prior_stage, next_stage, affected_node_ids_json,
        invalidated_evaluation_ids_json, invalidated_gate_result_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, invalidationId, input.projectId, input.treeId, workflow.current_revision_id,
    input.sourceTraceEventId, input.artifactId ?? null, workflow.revision,
    workflow.stage, nextStage,
    canonicalJson(affectedNodeIds), canonicalJson(invalidatedEvaluationIds),
    canonicalJson(invalidatedGateResultIds), createdAt);
    this.database.run(`
      UPDATE task_nodes SET status = 'needs_revalidation'
      WHERE tree_id = ? AND id IN (${affectedPlaceholders})
    `, input.treeId, ...affectedNodeIds);
    if (nextStage === "skeleton_pass") {
      this.database.run(
        "DELETE FROM workflow_branch_states WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?",
        input.projectId, input.treeId, workflow.current_revision_id,
      );
    } else if (nextBranchNodeId) {
      this.database.run(`
        UPDATE workflow_branch_states SET status = 'pending', updated_at = ?
        WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?
          AND status = 'active' AND branch_node_id <> ?
      `, createdAt, input.projectId, input.treeId, workflow.current_revision_id, nextBranchNodeId);
      for (const branch of affectedBranches) {
        this.database.run(`
          UPDATE workflow_branch_states SET status = ?, updated_at = ?
          WHERE tree_revision_id = ? AND branch_node_id = ?
        `, branch.branch_node_id === nextBranchNodeId ? "active" : "pending", createdAt,
        workflow.current_revision_id, branch.branch_node_id);
      }
    }
    this.database.run(`
      UPDATE workflow_states
      SET stage = ?, active_branch_node_id = ?,
          revision = revision + 1, updated_at = ?
      WHERE id = ?
    `, nextStage, nextBranchNodeId, createdAt, workflow.id);
    return {
      invalidationId, projectId: input.projectId, treeId: input.treeId,
      treeRevisionId: workflow.current_revision_id, sourceTraceEventId: input.sourceTraceEventId,
      artifactId: input.artifactId ?? null, workflowRevision: workflow.revision,
      priorStage: workflow.stage, nextStage, nextBranchNodeId,
      affectedNodeIds, invalidatedEvaluationIds, invalidatedGateResultIds, createdAt,
    };
  }
}
