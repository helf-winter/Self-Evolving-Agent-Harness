import { HarnessError } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
import {
  evaluateSkeletonGate,
  type SkeletonGateBranchObservation,
  type SkeletonGateCheck,
  type SkeletonGateStatus,
} from "../domain/skeleton-gate.js";
import type { SkeletonAcceptanceInput, TaskNodeInput, TaskTreeDocument } from "../domain/task-tree.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";

interface WorkflowRow {
  id: string;
  stage: string;
  revision: number;
}

interface CurrentNodeRow {
  id: string;
  status: string;
  body_json: string;
  node_revision_id: string;
  confirmation_state: string;
}

interface AttemptRow {
  id: string;
  task_node_id: string;
}

interface ArtifactRow {
  id: string;
  locator: string;
  status: string;
  source_trace_event_id: string | null;
  source_node_id: string | null;
}

interface ContractRow {
  contract_id: string;
  artifact_id: string;
  artifact_status: string;
  source_trace_event_id: string | null;
  source_node_id: string | null;
  validation_refs_json: string;
}

interface GateResultRow {
  id: string;
  project_id: string;
  tree_id: string;
  tree_revision_id: string;
  workflow_revision: number;
  policy_version: string;
  status: SkeletonGateStatus;
  branch_results_json: string;
  blockers_json: string;
  attempt_ids_json: string;
  evidence_trace_ids_json: string;
  created_at: string;
}

const actualArtifactStatuses = new Set(["created", "modified", "verified"]);

export class SkeletonGateService {
  constructor(private readonly database: RuntimeDatabase) {}

  evaluate(input: { projectId: string; treeId: string; workflowRevision: number }) {
    return this.database.transaction(() => this.evaluateWithinTransaction(input));
  }

  private evaluateWithinTransaction(input: { projectId: string; treeId: string; workflowRevision: number }) {
    const workflow = this.database.get<WorkflowRow>(
      "SELECT id, stage, revision FROM workflow_states WHERE project_id = ? AND tree_id = ? AND active = 1",
      input.projectId, input.treeId,
    );
    if (!workflow) throw new HarnessError("not_found", "active Workflow was not found");
    if (workflow.revision !== input.workflowRevision) {
      throw new HarnessError("revision_conflict", "workflow revision does not match current state");
    }
    if (workflow.stage !== "skeleton_pass") {
      throw new HarnessError("workflow_transition_rejected", "Skeleton Gate can only be evaluated during skeleton_pass");
    }
    const tree = this.database.get<{ current_revision_id: string; document_json: string }>(`
      SELECT t.current_revision_id, r.document_json
      FROM task_trees t JOIN task_tree_revisions r ON r.id = t.current_revision_id
      WHERE t.id = ? AND t.project_id = ? AND t.archived_at IS NULL
    `, input.treeId, input.projectId);
    if (!tree) throw new HarnessError("not_found", "current Task Tree revision was not found");
    const document = JSON.parse(tree.document_json) as TaskTreeDocument;
    const structured = document.planningVersion === 1;
    const nodes = this.database.all<CurrentNodeRow>(`
      SELECT n.id, n.status, nr.body_json, nr.id AS node_revision_id,
             COALESCE(cs.state, 'draft') AS confirmation_state
      FROM task_nodes n
      JOIN task_node_revisions nr ON nr.node_id = n.id AND nr.tree_revision_id = ?
      LEFT JOIN task_node_confirmation_states cs
        ON cs.tree_revision_id = ? AND cs.task_node_id = n.id
      WHERE n.tree_id = ?
      ORDER BY n.id
    `, tree.current_revision_id, tree.current_revision_id, input.treeId);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const root = document.nodes.find((node) => node.parentId === null);
    const confirmedBranches = structured
      ? (root?.children ?? []).filter((nodeId) => nodeById.get(nodeId)?.confirmation_state === "confirmed")
      : root ? [root.id] : [];
    const attempts = this.database.all<AttemptRow>(`
      SELECT a.id, a.task_node_id
      FROM execution_attempts a
      JOIN task_node_revisions nr ON nr.id = a.task_node_revision_id
      WHERE a.project_id = ? AND a.tree_id = ? AND nr.tree_revision_id = ? AND a.status = 'succeeded'
      ORDER BY a.attempt_number DESC, a.id DESC
    `, input.projectId, input.treeId, tree.current_revision_id);
    const attemptByNode = new Map<string, string>();
    for (const attempt of attempts) if (!attemptByNode.has(attempt.task_node_id)) attemptByNode.set(attempt.task_node_id, attempt.id);
    const evidenceRows = this.database.all<{ attempt_id: string; required_evidence_key: string; trace_event_id: string }>(`
      SELECT e.attempt_id, e.required_evidence_key, e.trace_event_id
      FROM execution_attempt_evidence e
      JOIN execution_attempts a ON a.id = e.attempt_id
      JOIN task_node_revisions nr ON nr.id = a.task_node_revision_id
      WHERE a.project_id = ? AND a.tree_id = ? AND nr.tree_revision_id = ? AND a.status = 'succeeded'
      ORDER BY e.attempt_id, e.trace_event_id
    `, input.projectId, input.treeId, tree.current_revision_id);
    const evidenceByAttempt = new Map<string, Set<string>>();
    const evidenceKeysByAttempt = new Map<string, Set<string>>();
    for (const row of evidenceRows) {
      const values = evidenceByAttempt.get(row.attempt_id) ?? new Set<string>();
      values.add(row.trace_event_id);
      evidenceByAttempt.set(row.attempt_id, values);
      const keys = evidenceKeysByAttempt.get(row.attempt_id) ?? new Set<string>();
      keys.add(row.required_evidence_key);
      evidenceKeysByAttempt.set(row.attempt_id, keys);
    }
    const artifacts = this.database.all<ArtifactRow>(`
      SELECT a.id, a.locator, a.status, a.source_trace_event_id, te.node_id AS source_node_id
      FROM artifacts a LEFT JOIN trace_events te ON te.id = a.source_trace_event_id
      WHERE a.project_id = ? AND a.tree_id = ?
    `, input.projectId, input.treeId);
    const contracts = this.database.all<ContractRow>(`
      SELECT c.contract_id, c.artifact_id, a.status AS artifact_status,
             a.source_trace_event_id, te.node_id AS source_node_id, c.validation_refs_json
      FROM artifact_contracts c
      JOIN artifacts a ON a.id = c.artifact_id
      LEFT JOIN trace_events te ON te.id = a.source_trace_event_id
      WHERE c.project_id = ? AND c.tree_id = ? AND c.tree_revision_id = ?
    `, input.projectId, input.treeId, tree.current_revision_id);
    const blockingDriftIds = this.database.all<{ id: string }>(`
      SELECT id FROM plan_drift_records
      WHERE project_id = ? AND tree_id = ? AND severity = 'blocking'
        AND resolution_status = 'pending_user_confirmation'
      ORDER BY created_at, id
    `, input.projectId, input.treeId).map((row) => row.id);

    const branches = confirmedBranches.map((branchNodeId) => this.observeBranch({
      branchNodeId, structured, document, nodes, attemptByNode, evidenceByAttempt, evidenceKeysByAttempt, artifacts, contracts,
    }));
    const evaluated = evaluateSkeletonGate({ structured, branches, blockingDriftIds });
    const resultId = newId();
    const createdAt = nowIso();
    const attemptIds = [...new Set(branches.flatMap((branch) => branch.succeededAttemptIds))].sort();
    const traceIds = [...new Set(branches.flatMap((branch) => [
      ...branch.expectedArtifacts, ...branch.requiredContracts,
      ...branch.verificationCommands, ...branch.readinessConditions,
    ]).flatMap((check) => check.evidenceRefs))].sort();
    this.database.run(`
      INSERT INTO skeleton_gate_results (
        id, project_id, tree_id, tree_revision_id, workflow_revision, policy_version,
        status, branch_results_json, blockers_json, attempt_ids_json, evidence_trace_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, resultId, input.projectId, input.treeId, tree.current_revision_id, workflow.revision,
    structured ? "skeleton-gate-v1" : "skeleton-gate-legacy-v1", evaluated.status,
    canonicalJson(branches), canonicalJson(evaluated.blockers), canonicalJson(attemptIds), canonicalJson(traceIds), createdAt);
    if (evaluated.status === "passed") {
      this.database.run(
        "UPDATE workflow_states SET stage = 'branch_implementation', revision = revision + 1, updated_at = ? WHERE id = ?",
        createdAt, workflow.id,
      );
    }
    return {
      resultId, projectId: input.projectId, treeId: input.treeId, treeRevisionId: tree.current_revision_id,
      workflowRevision: workflow.revision, policyVersion: structured ? "skeleton-gate-v1" : "skeleton-gate-legacy-v1",
      status: evaluated.status, branches, blockers: evaluated.blockers, attemptIds, evidenceTraceIds: traceIds,
      workflow: { stage: evaluated.status === "passed" ? "branch_implementation" : "skeleton_pass", revision: workflow.revision + (evaluated.status === "passed" ? 1 : 0) },
      createdAt,
    };
  }

  list(projectId: string, options: { treeId?: string; resultId?: string } = {}) {
    const clauses = ["project_id = ?"];
    const params: string[] = [projectId];
    if (options.treeId) { clauses.push("tree_id = ?"); params.push(options.treeId); }
    if (options.resultId) { clauses.push("id = ?"); params.push(options.resultId); }
    return this.database.all<GateResultRow>(`
      SELECT * FROM skeleton_gate_results WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT 200
    `, ...params).map((row) => this.view(row));
  }

  private observeBranch(input: {
    branchNodeId: string;
    structured: boolean;
    document: TaskTreeDocument;
    nodes: CurrentNodeRow[];
    attemptByNode: Map<string, string>;
    evidenceByAttempt: Map<string, Set<string>>;
    evidenceKeysByAttempt: Map<string, Set<string>>;
    artifacts: ArtifactRow[];
    contracts: ContractRow[];
  }): SkeletonGateBranchObservation {
    const scope = this.descendants(input.document, input.branchNodeId);
    const skeletonNodes = input.nodes.filter((node) => {
      if (!scope.has(node.id)) return false;
      return (JSON.parse(node.body_json) as TaskNodeInput).executionPhase === "skeleton";
    });
    const succeededAttemptIds = skeletonNodes.flatMap((node) => {
      const attemptId = input.attemptByNode.get(node.id);
      return node.status === "succeeded" && attemptId ? [attemptId] : [];
    });
    const branchEvidence = new Set(succeededAttemptIds.flatMap((attemptId) => [...(input.evidenceByAttempt.get(attemptId) ?? [])]));
    const branchEvidenceKeys = new Set(succeededAttemptIds.flatMap((attemptId) => [...(input.evidenceKeysByAttempt.get(attemptId) ?? [])]));
    const skeletonNodeIds = new Set(skeletonNodes.map((node) => node.id));
    const criterion = input.structured
      ? input.document.skeletonCriteria?.find((value) => value.branchNodeId === input.branchNodeId)
      : undefined;
    const artifactCheck = (ref: string): SkeletonGateCheck => {
      const artifact = input.artifacts.find((value) => value.id === ref || value.locator === ref);
      const evidenceRefs = artifact?.source_trace_event_id ? [artifact.source_trace_event_id] : [];
      return {
        ref,
        satisfied: Boolean(artifact && actualArtifactStatuses.has(artifact.status)
          && artifact.source_trace_event_id && artifact.source_node_id && skeletonNodeIds.has(artifact.source_node_id)),
        evidenceRefs,
      };
    };
    const contractCheck = (ref: string): SkeletonGateCheck => {
      const contract = input.contracts.find((value) => value.contract_id === ref);
      const evidenceRefs = contract?.source_trace_event_id ? [contract.source_trace_event_id] : [];
      const validationRefs = contract ? JSON.parse(contract.validation_refs_json) as string[] : [];
      const validationSatisfied = validationRefs.length > 0 && validationRefs.every((validationRef) => {
        if (branchEvidenceKeys.has(validationRef) || branchEvidence.has(validationRef)) return true;
        const evidenceArtifact = input.artifacts.find((artifact) => artifact.id === validationRef || artifact.locator === validationRef);
        return Boolean(evidenceArtifact?.source_trace_event_id && branchEvidence.has(evidenceArtifact.source_trace_event_id));
      });
      return {
        ref,
        satisfied: Boolean(contract && (validationSatisfied || (actualArtifactStatuses.has(contract.artifact_status)
          && contract.source_trace_event_id && contract.source_node_id && skeletonNodeIds.has(contract.source_node_id)))),
        evidenceRefs: validationSatisfied ? [...branchEvidence].sort() : evidenceRefs,
      };
    };
    const commandCheck = (ref: string): SkeletonGateCheck => {
      const artifact = input.artifacts.find((value) => value.locator === ref && value.status === "verified");
      const traceId = artifact?.source_trace_event_id ?? null;
      return { ref, satisfied: Boolean(traceId && branchEvidence.has(traceId)), evidenceRefs: traceId ? [traceId] : [] };
    };
    const readinessCheck = (ref: string): SkeletonGateCheck => ({
      ref,
      satisfied: succeededAttemptIds.length > 0 && succeededAttemptIds.length === skeletonNodes.length,
      evidenceRefs: [...branchEvidence].sort(),
    });
    return {
      branchNodeId: input.branchNodeId,
      criterionId: criterion?.id ?? null,
      criterionComplete: input.structured ? this.criterionComplete(criterion) : true,
      skeletonNodeIds: [...skeletonNodeIds].sort(),
      succeededAttemptIds: [...succeededAttemptIds].sort(),
      expectedArtifacts: (criterion?.expectedArtifacts ?? []).map(artifactCheck),
      requiredContracts: (criterion?.requiredContracts ?? []).map(contractCheck),
      verificationCommands: (criterion?.verificationCommands ?? []).map(commandCheck),
      readinessConditions: (criterion?.readinessConditions ?? []).map(readinessCheck),
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

  private criterionComplete(value: SkeletonAcceptanceInput | undefined): boolean {
    return Boolean(value && value.expectedArtifacts.length && value.requiredContracts.length
      && value.verificationCommands.length && value.readinessConditions.length);
  }

  private view(row: GateResultRow) {
    return {
      resultId: row.id, projectId: row.project_id, treeId: row.tree_id, treeRevisionId: row.tree_revision_id,
      workflowRevision: row.workflow_revision, policyVersion: row.policy_version, status: row.status,
      branches: JSON.parse(row.branch_results_json) as SkeletonGateBranchObservation[],
      blockers: JSON.parse(row.blockers_json) as unknown[],
      attemptIds: JSON.parse(row.attempt_ids_json) as string[],
      evidenceTraceIds: JSON.parse(row.evidence_trace_ids_json) as string[], createdAt: row.created_at,
    };
  }
}
