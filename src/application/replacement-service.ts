import { HarnessError } from "../domain/errors.js";
import {
  compareContractBindings,
  computeDependencyImpactClosure,
  decideEffectDisposition,
  disposalCapability,
  validateEffectDefinition,
  type EffectDisposalCapability,
  type EffectDisposalStatus,
  type EffectDispositionAction,
  type TaskNodeEffectType,
} from "../domain/composition.js";
import { newId, nowIso } from "../domain/ids.js";
import { validateTaskTree, type TaskNodeInput, type TaskTreeDocument } from "../domain/task-tree.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";
import { TaskTreeService } from "./task-tree-service.js";

export interface TaskNodeEffectView {
  effectId: string;
  projectId: string;
  treeId: string;
  nodeId: string;
  ownerRevisionId: string;
  effectType: TaskNodeEffectType;
  targetRef: string;
  disposalStatus: EffectDisposalStatus;
  capability: EffectDisposalCapability;
  created: boolean;
  createdAt: string;
}

export class ReplacementService {
  private readonly taskTrees: TaskTreeService;

  constructor(private readonly database: RuntimeDatabase) {
    this.taskTrees = new TaskTreeService(database);
  }

  registerTaskNodeEffect(input: {
    projectId: string;
    ownerRevisionId: string;
    effectType: TaskNodeEffectType;
    targetRef: string;
    operation: string;
    baselineRef: string | null;
    inverseOperation: string | null;
    compensationOperation: string | null;
    evidenceRefs: string[];
  }): TaskNodeEffectView {
    const definition = {
      effectType: input.effectType,
      targetRef: input.targetRef.trim(), operation: input.operation.trim(),
      baselineRef: input.baselineRef?.trim() || null,
      inverseOperation: input.inverseOperation?.trim() || null,
      compensationOperation: input.compensationOperation?.trim() || null,
      evidenceRefs: [...new Set(input.evidenceRefs)].sort(),
    };
    const validationErrors = validateEffectDefinition(definition);
    if (validationErrors.length) throw new HarnessError("effect_invalid", "Task Node Effect definition is incomplete", validationErrors);
    const owner = this.database.get<{
      node_id: string; tree_id: string; tree_revision_id: string; created_at: string; current_revision_id: string;
    }>(`
      SELECT nr.node_id, n.tree_id, nr.tree_revision_id, nr.created_at, t.current_revision_id
      FROM task_node_revisions nr
      JOIN task_nodes n ON n.id = nr.node_id
      JOIN task_trees t ON t.id = n.tree_id
      WHERE nr.id = ? AND t.project_id = ?
    `, input.ownerRevisionId, input.projectId);
    if (!owner) throw new HarnessError("not_found", "owner Task Node revision was not found in this Project");
    if (owner.tree_revision_id !== owner.current_revision_id) {
      throw new HarnessError("effect_invalid", "new Effects can only be registered to the current active Task Node revision");
    }
    this.requireEvidence(input.projectId, owner.tree_id, owner.node_id, definition.evidenceRefs, owner.created_at);
    if (input.effectType === "version_reversible") {
      const artifactId = this.artifactId(definition.targetRef);
      const artifact = artifactId ? this.database.get<{ current_hash_or_version: string | null }>(
        "SELECT current_hash_or_version FROM artifacts WHERE id = ? AND project_id = ? AND tree_id = ?",
        artifactId, input.projectId, owner.tree_id,
      ) : undefined;
      if (!artifact) throw new HarnessError("effect_invalid", "version-reversible Effect target must be an Artifact in the owner Project and Tree");
      if (artifact.current_hash_or_version !== definition.baselineRef) {
        throw new HarnessError("effect_invalid", "version-reversible Effect baseline must match the recorded target version");
      }
    }
    const evidenceRefsJson = canonicalJson(definition.evidenceRefs);
    const existing = this.database.get<{
      id: string; disposal_status: EffectDisposalStatus; created_at: string;
    }>(`SELECT id, disposal_status, created_at FROM task_node_effects
        WHERE project_id = ? AND owner_revision_id = ? AND effect_type = ? AND target_ref = ?
          AND operation = ? AND ifnull(baseline_ref, '') = ifnull(?, '')
          AND ifnull(inverse_operation, '') = ifnull(?, '')
          AND ifnull(compensation_operation, '') = ifnull(?, '') AND evidence_refs_json = ?`,
    input.projectId, input.ownerRevisionId, input.effectType, definition.targetRef,
    definition.operation, definition.baselineRef, definition.inverseOperation,
    definition.compensationOperation, evidenceRefsJson);
    const capability = disposalCapability(input.effectType);
    if (existing) {
      return {
        effectId: existing.id, projectId: input.projectId, treeId: owner.tree_id, nodeId: owner.node_id,
        ownerRevisionId: input.ownerRevisionId, effectType: input.effectType, targetRef: definition.targetRef,
        disposalStatus: existing.disposal_status, capability, created: false, createdAt: existing.created_at,
      };
    }
    const effectId = newId();
    const createdAt = nowIso();
    this.database.run(`
      INSERT INTO task_node_effects (
        id, project_id, tree_id, task_node_id, owner_revision_id, effect_type,
        target_ref, operation, baseline_ref, inverse_operation, compensation_operation,
        evidence_refs_json, disposal_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `, effectId, input.projectId, owner.tree_id, owner.node_id, input.ownerRevisionId,
    input.effectType, definition.targetRef, definition.operation, definition.baselineRef,
    definition.inverseOperation, definition.compensationOperation, evidenceRefsJson, createdAt);
    return {
      effectId, projectId: input.projectId, treeId: owner.tree_id, nodeId: owner.node_id,
      ownerRevisionId: input.ownerRevisionId, effectType: input.effectType, targetRef: definition.targetRef,
      disposalStatus: "active", capability, created: true, createdAt,
    };
  }

  getEffectDisposalCapability(input: { projectId: string; effectId: string }) {
    const effect = this.database.get<{
      id: string; tree_id: string; task_node_id: string; owner_revision_id: string;
      effect_type: TaskNodeEffectType; target_ref: string; baseline_ref: string | null;
      disposal_status: EffectDisposalStatus;
    }>(`SELECT id, tree_id, task_node_id, owner_revision_id, effect_type, target_ref, baseline_ref, disposal_status
        FROM task_node_effects WHERE id = ? AND project_id = ?`, input.effectId, input.projectId);
    if (!effect) throw new HarnessError("not_found", "Task Node Effect was not found in this Project");
    const sharedCount = this.database.get<{ count: number }>(`
      SELECT count(*) AS count FROM task_node_effects
      WHERE project_id = ? AND target_ref = ? AND disposal_status = 'active' AND id <> ?
    `, input.projectId, effect.target_ref, effect.id)?.count ?? 0;
    let baselineMatches = true;
    if (effect.effect_type === "version_reversible") {
      const artifactId = this.artifactId(effect.target_ref);
      const artifact = artifactId ? this.database.get<{ current_hash_or_version: string | null }>(
        "SELECT current_hash_or_version FROM artifacts WHERE id = ? AND project_id = ? AND tree_id = ?",
        artifactId, input.projectId, effect.tree_id,
      ) : undefined;
      baselineMatches = Boolean(artifact && artifact.current_hash_or_version === effect.baseline_ref);
    }
    return {
      effectId: effect.id, ownerRevisionId: effect.owner_revision_id, nodeId: effect.task_node_id,
      effectType: effect.effect_type, targetRef: effect.target_ref, disposalStatus: effect.disposal_status,
      capability: disposalCapability(effect.effect_type), baselineMatches,
      hasSharedActiveOwner: sharedCount > 0,
    };
  }

  previewTaskNodeReplacement(input: {
    projectId: string;
    treeId: string;
    nodeId: string;
    expectedTreeRevisionId: string;
    candidateBody: TaskNodeInput;
    providesContractIds: string[];
    requiresContractIds: string[];
    reason: string;
    sourceMessageTraceEventId: string;
  }) {
    if (!input.reason.trim()) throw new HarnessError("replacement_invalid", "Replacement reason is required");
    const tree = this.database.get<{ current_revision_id: string; document_json: string }>(`
      SELECT t.current_revision_id, tr.document_json FROM task_trees t
      JOIN task_tree_revisions tr ON tr.id = t.current_revision_id
      WHERE t.id = ? AND t.project_id = ?
    `, input.treeId, input.projectId);
    if (!tree) throw new HarnessError("not_found", "Task Tree was not found in this Project");
    if (tree.current_revision_id !== input.expectedTreeRevisionId) {
      throw new HarnessError("revision_conflict", "Replacement preview was based on a stale Task Tree revision");
    }
    if (this.database.get(`SELECT id FROM task_node_replacement_records
      WHERE project_id = ? AND task_node_id = ? AND status IN ('pending_confirmation','suspending','disposing','activating')`,
    input.projectId, input.nodeId)) {
      throw new HarnessError("replacement_invalid", "Task Node already has an active Replacement");
    }
    const oldRevision = this.database.get<{ id: string; body_json: string; created_at: string }>(`
      SELECT nr.id, nr.body_json, nr.created_at FROM task_node_revisions nr
      JOIN task_nodes n ON n.id = nr.node_id
      WHERE nr.node_id = ? AND nr.tree_revision_id = ? AND n.tree_id = ?
    `, input.nodeId, tree.current_revision_id, input.treeId);
    if (!oldRevision) throw new HarnessError("not_found", "active Task Node revision was not found");
    const oldBody = JSON.parse(oldRevision.body_json) as TaskNodeInput;
    if (input.candidateBody.id !== oldBody.id || input.candidateBody.parentId !== oldBody.parentId
      || canonicalJson(input.candidateBody.children) !== canonicalJson(oldBody.children)) {
      throw new HarnessError("replacement_invalid", "Replacement must preserve Task Node identity and tree topology");
    }
    const document = JSON.parse(tree.document_json) as TaskTreeDocument;
    const candidateDocument: TaskTreeDocument = {
      ...document,
      nodes: document.nodes.map((node) => node.id === input.nodeId ? input.candidateBody : node),
    };
    const validation = validateTaskTree(candidateDocument);
    if (!validation.ok) throw new HarnessError("replacement_invalid", "candidate Task Node produces an invalid Task Tree", validation.errors);
    const source = this.database.get<{ occurred_at: string }>(`
      SELECT occurred_at FROM trace_events WHERE id = ? AND project_id = ? AND tree_id = ?
        AND event_name = 'UserPromptSubmit' AND (node_id = ? OR node_id IS NULL)
    `, input.sourceMessageTraceEventId, input.projectId, input.treeId, input.nodeId);
    if (!source) throw new HarnessError("evidence_scope_mismatch", "Replacement reason must reference a same-Project user message Trace");
    const contractRows = this.database.all<{
      contract_id: string; provider_revision_ids_json: string; consumer_revision_ids_json: string;
    }>(`SELECT contract_id, provider_revision_ids_json, consumer_revision_ids_json FROM artifact_contracts
        WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?`,
    input.projectId, input.treeId, tree.current_revision_id);
    const knownContracts = new Set(contractRows.map((row) => row.contract_id));
    const provides = [...new Set(input.providesContractIds)].sort();
    const requires = [...new Set(input.requiresContractIds)].sort();
    if ([...provides, ...requires].some((contractId) => !knownContracts.has(contractId))) {
      throw new HarnessError("replacement_invalid", "candidate references an Artifact Contract outside the current Task Tree revision");
    }
    const oldBinding = this.database.get<{ provides_contract_ids_json: string; requires_contract_ids_json: string }>(
      "SELECT provides_contract_ids_json, requires_contract_ids_json FROM task_node_revision_contract_bindings WHERE task_node_revision_id = ?",
      oldRevision.id,
    );
    const oldProvides = oldBinding
      ? JSON.parse(oldBinding.provides_contract_ids_json) as string[]
      : contractRows.filter((row) => (JSON.parse(row.provider_revision_ids_json) as string[]).includes(oldRevision.id)).map((row) => row.contract_id);
    const oldRequires = oldBinding
      ? JSON.parse(oldBinding.requires_contract_ids_json) as string[]
      : contractRows.filter((row) => (JSON.parse(row.consumer_revision_ids_json) as string[]).includes(oldRevision.id)).map((row) => row.contract_id);
    const revisionNodes = new Map(this.database.all<{ id: string; node_id: string }>(`
      SELECT nr.id, nr.node_id FROM task_node_revisions nr WHERE nr.tree_revision_id = ?
    `, tree.current_revision_id).map((row) => [row.id, row.node_id]));
    const availableProviderContracts = contractRows.flatMap((row) =>
      (JSON.parse(row.provider_revision_ids_json) as string[]).some((revisionId) => revisionNodes.get(revisionId) !== input.nodeId)
        ? [row.contract_id] : []);
    const contractDiff = compareContractBindings({
      oldProvides, oldRequires, candidateProvides: provides, candidateRequires: requires, availableProviderContracts,
    });
    const relations = this.database.all<{ from_node_id: string; to_node_id: string }>(
      "SELECT from_node_id, to_node_id FROM task_relation_edges WHERE tree_revision_id = ?",
      tree.current_revision_id,
    ).map((row) => ({ fromNodeId: row.from_node_id, toNodeId: row.to_node_id }));
    const contractConsumers = contractRows.flatMap((row) => {
      const providers = (JSON.parse(row.provider_revision_ids_json) as string[]).map((revisionId) => revisionNodes.get(revisionId)).filter((value): value is string => Boolean(value));
      const consumers = (JSON.parse(row.consumer_revision_ids_json) as string[]).map((revisionId) => revisionNodes.get(revisionId)).filter((value): value is string => Boolean(value));
      return providers.flatMap((providerNodeId) => consumers.map((consumerNodeId) => ({ providerNodeId, consumerNodeId })));
    });
    const impact = computeDependencyImpactClosure({ replacedNodeId: input.nodeId, relations, contractConsumers });
    const effects = this.database.all<{ id: string; effect_type: TaskNodeEffectType; target_ref: string }>(`
      SELECT id, effect_type, target_ref FROM task_node_effects
      WHERE project_id = ? AND owner_revision_id = ? AND disposal_status = 'active' ORDER BY id
    `, input.projectId, oldRevision.id);
    const effectRiskSummary = {
      total: effects.length,
      byType: Object.fromEntries(["reversible", "version_reversible", "compensatable", "irreversible"].map((type) => [
        type, effects.filter((effect) => effect.effect_type === type).length,
      ])),
      effects: effects.map((effect) => ({ effectId: effect.id, effectType: effect.effect_type, targetRef: effect.target_ref, capability: disposalCapability(effect.effect_type) })),
    };
    const candidateRevisionId = newId();
    const replacementId = newId();
    const actionId = newId();
    const confirmationId = newId();
    const createdAt = nowIso();
    const riskLevel = effects.some((effect) => effect.effect_type === "irreversible") ? "irreversible" : "high";
    this.database.transaction(() => {
      this.database.run(`INSERT INTO task_node_candidate_revisions (
        id, project_id, tree_id, task_node_id, base_tree_revision_id, base_node_revision_id,
        body_json, provides_contract_ids_json, requires_contract_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, candidateRevisionId, input.projectId, input.treeId,
      input.nodeId, tree.current_revision_id, oldRevision.id, canonicalJson(input.candidateBody),
      canonicalJson(provides), canonicalJson(requires), createdAt);
      this.database.run(`INSERT INTO runtime_actions (
        id, project_id, kind, input_json, result_json, created_at, action_type, target_type,
        target_id, expected_revision, reason, source_message_ref, risk_level,
        confirmation_requirement, confirmation_prompt_id, status
      ) VALUES (?, ?, 'replace_task_node', ?, '{}', ?, 'replace_task_node', 'replacement', ?, ?, ?, ?, ?, 'required', ?, 'pending_confirmation')`,
      actionId, input.projectId, canonicalJson({ candidateRevisionId, contractDiff, impact, effectRiskSummary }),
      createdAt, replacementId, tree.current_revision_id, input.reason.trim(), input.sourceMessageTraceEventId,
      riskLevel, confirmationId);
      this.database.run(`INSERT INTO runtime_confirmation_prompts (
        id, project_id, tree_id, scope_id, prompt, status, created_at, tree_revision_id,
        scope_kind, scope_root_node_id, prompt_type, related_task_node_id,
        related_artifact_ids_json, options_json, runtime_action_id
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 'branch', ?, 'high_risk_action', ?, ?, ?, ?)`,
      confirmationId, input.projectId, input.treeId, replacementId,
      `Replace ${oldBody.title} and suspend ${impact.affectedTaskNodeIds.length} affected Task Nodes?`,
      createdAt, tree.current_revision_id, input.nodeId, input.nodeId,
      canonicalJson(effects.flatMap((effect) => this.artifactId(effect.target_ref) ?? [])),
      canonicalJson(["yes", "no", "pause"]), actionId);
      this.database.run(`INSERT INTO task_node_replacement_records (
        id, project_id, tree_id, task_node_id, old_revision_id, candidate_revision_id,
        expected_tree_revision_id, affected_task_node_ids_json, suspension_order_json,
        contract_diff_json, effect_risk_summary_json, user_confirmation_ref, runtime_action_id,
        status, disposal_result_refs_json, trace_event_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_confirmation', '[]', ?, ?)`,
      replacementId, input.projectId, input.treeId, input.nodeId, oldRevision.id, candidateRevisionId,
      tree.current_revision_id, canonicalJson(impact.affectedTaskNodeIds), canonicalJson(impact.suspensionOrder),
      canonicalJson(contractDiff), canonicalJson(effectRiskSummary), confirmationId, actionId,
      canonicalJson([input.sourceMessageTraceEventId]), createdAt);
      for (const affectedNodeId of impact.affectedTaskNodeIds) this.ensureCompositionState(
        input.projectId, input.treeId, affectedNodeId, tree.current_revision_id, "active", null, createdAt,
      );
      this.setRuntimeWaiting(input.projectId, input.treeId, input.nodeId, confirmationId);
    });
    return {
      replacementId, candidateRevisionId, confirmationId, actionId,
      status: "pending_confirmation" as const, affectedTaskNodeIds: impact.affectedTaskNodeIds,
      suspensionOrder: impact.suspensionOrder, contractDiff, effectRiskSummary,
    };
  }

  confirmTaskNodeReplacement(input: {
    projectId: string;
    replacementId: string;
    answer: "yes" | "no" | "pause";
    answerTraceEventId: string;
  }) {
    const record = this.database.get<{
      id: string; tree_id: string; task_node_id: string; expected_tree_revision_id: string;
      affected_task_node_ids_json: string; suspension_order_json: string; user_confirmation_ref: string;
      runtime_action_id: string; status: string; created_at: string; prompt_created_at: string; prompt_status: string;
      trace_event_ids_json: string;
    }>(`SELECT r.id, r.tree_id, r.task_node_id, r.expected_tree_revision_id,
               r.affected_task_node_ids_json, r.suspension_order_json, r.user_confirmation_ref,
               r.runtime_action_id, r.status, r.created_at, r.trace_event_ids_json,
               p.created_at AS prompt_created_at, p.status AS prompt_status
        FROM task_node_replacement_records r
        JOIN runtime_confirmation_prompts p ON p.id = r.user_confirmation_ref
        WHERE r.id = ? AND r.project_id = ?`, input.replacementId, input.projectId);
    if (!record) throw new HarnessError("not_found", "Task Node Replacement was not found in this Project");
    if (record.status !== "pending_confirmation" || record.prompt_status !== "pending") {
      throw new HarnessError("confirmation_not_applicable", "Replacement confirmation is no longer pending");
    }
    const answerTrace = this.database.get<{ occurred_at: string }>(`
      SELECT occurred_at FROM trace_events WHERE id = ? AND project_id = ? AND tree_id = ?
        AND event_name = 'UserPromptSubmit' AND occurred_at >= ?
    `, input.answerTraceEventId, input.projectId, record.tree_id, record.prompt_created_at);
    if (!answerTrace) throw new HarnessError("evidence_scope_mismatch", "Replacement answer Trace is outside the pending prompt scope or lifetime");
    if (input.answer === "pause") {
      this.database.run("UPDATE runtime_actions SET result_json = ? WHERE id = ?", canonicalJson({ paused: true }), record.runtime_action_id);
      return { replacementId: record.id, status: "pending_confirmation" as const, suspendedNodeIds: [], paused: true };
    }
    const tree = this.database.get<{ current_revision_id: string }>(
      "SELECT current_revision_id FROM task_trees WHERE id = ? AND project_id = ?", record.tree_id, input.projectId,
    );
    if (!tree || tree.current_revision_id !== record.expected_tree_revision_id) {
      throw new HarnessError("revision_conflict", "Task Tree changed while Replacement confirmation was pending");
    }
    const resolvedAt = nowIso();
    const confirmationTraceIds = [...new Set([
      ...(JSON.parse(record.trace_event_ids_json) as string[]), input.answerTraceEventId,
    ])].sort();
    if (input.answer === "no") {
      this.database.transaction(() => {
        this.database.run("UPDATE runtime_confirmation_prompts SET status = 'rejected', answer = 'no', answer_trace_event_id = ?, resolved_at = ? WHERE id = ?", input.answerTraceEventId, resolvedAt, record.user_confirmation_ref);
        this.database.run("UPDATE runtime_actions SET status = 'rejected', result_json = ?, committed_at = ? WHERE id = ?", canonicalJson({ rejected: true }), resolvedAt, record.runtime_action_id);
        this.database.run("UPDATE task_node_replacement_records SET status = 'rolled_back', recovery_result_json = ?, trace_event_ids_json = ?, completed_at = ? WHERE id = ?", canonicalJson({ reason: "user_rejected_before_suspension" }), canonicalJson(confirmationTraceIds), resolvedAt, record.id);
        this.clearRuntimeWaiting(input.projectId, record.user_confirmation_ref);
      });
      return { replacementId: record.id, status: "rolled_back" as const, suspendedNodeIds: [] };
    }
    const suspensionOrder = JSON.parse(record.suspension_order_json) as string[];
    this.database.transaction(() => {
      const priorStatuses: Record<string, string> = {};
      for (const nodeId of suspensionOrder) {
        const node = this.database.get<{ status: string; revision_id: string }>(`
          SELECT n.status, nr.id AS revision_id FROM task_nodes n
          JOIN task_node_revisions nr ON nr.node_id = n.id AND nr.tree_revision_id = ?
          WHERE n.id = ? AND n.tree_id = ?
        `, tree.current_revision_id, nodeId, record.tree_id);
        if (!node) throw new HarnessError("replacement_invalid", "affected Task Node disappeared before suspension");
        priorStatuses[nodeId] = node.status;
        const priorComposition = this.database.get<{ composition_state: string }>(
          "SELECT composition_state FROM task_node_composition_states WHERE task_node_id = ?", nodeId,
        )?.composition_state ?? "active";
        this.database.run(`UPDATE task_node_composition_states SET active_revision_id = ?, composition_state = 'suspending', replacement_id = ?, updated_at = ? WHERE task_node_id = ?`,
          node.revision_id, record.id, resolvedAt, nodeId);
        this.database.run(`INSERT INTO task_node_composition_transitions (
          id, project_id, tree_id, task_node_id, task_node_revision_id, from_state, to_state,
          reason, replacement_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'suspending', 'replacement impact closure', ?, ?)`,
        newId(), input.projectId, record.tree_id, nodeId, node.revision_id, priorComposition, record.id, resolvedAt);
        this.database.run("UPDATE task_nodes SET status = 'blocked' WHERE id = ?", nodeId);
        this.database.run("UPDATE execution_attempts SET status = 'blocked', completed_at = ? WHERE task_node_id = ? AND status IN ('running','verifying')", resolvedAt, nodeId);
      }
      this.database.run("UPDATE runtime_confirmation_prompts SET status = 'accepted', answer = 'yes', answer_trace_event_id = ?, resolved_at = ? WHERE id = ?", input.answerTraceEventId, resolvedAt, record.user_confirmation_ref);
      this.database.run("UPDATE runtime_actions SET status = 'validated', result_json = ? WHERE id = ?", canonicalJson({ confirmed: true, suspendedNodeIds: suspensionOrder }), record.runtime_action_id);
      this.database.run("UPDATE task_node_replacement_records SET status = 'suspending', prior_execution_statuses_json = ?, trace_event_ids_json = ? WHERE id = ?", canonicalJson(priorStatuses), canonicalJson(confirmationTraceIds), record.id);
      this.clearRuntimeWaiting(input.projectId, record.user_confirmation_ref);
    });
    return { replacementId: record.id, status: "suspending" as const, suspendedNodeIds: suspensionOrder };
  }

  executeTaskNodeReplacement(input: {
    projectId: string;
    replacementId: string;
    dispositions: Array<{
      effectId: string;
      action: EffectDispositionAction;
      observedBaselineRef: string | null;
      evidenceRefs: string[];
      residualImpact: string;
    }>;
    activationVerdict: "succeeded" | "failed";
    activationEvidenceRefs: string[];
  }) {
    const record = this.database.get<{
      id: string; tree_id: string; task_node_id: string; old_revision_id: string;
      candidate_revision_id: string; expected_tree_revision_id: string;
      affected_task_node_ids_json: string; contract_diff_json: string;
      user_confirmation_ref: string; runtime_action_id: string; status: string;
      trace_event_ids_json: string; confirmation_resolved_at: string;
      candidate_body_json: string; provides_contract_ids_json: string; requires_contract_ids_json: string;
    }>(`SELECT r.id, r.tree_id, r.task_node_id, r.old_revision_id, r.candidate_revision_id,
               r.expected_tree_revision_id, r.affected_task_node_ids_json, r.contract_diff_json,
               r.user_confirmation_ref, r.runtime_action_id, r.status, r.trace_event_ids_json,
               p.resolved_at AS confirmation_resolved_at, c.body_json AS candidate_body_json,
               c.provides_contract_ids_json, c.requires_contract_ids_json
        FROM task_node_replacement_records r
        JOIN runtime_confirmation_prompts p ON p.id = r.user_confirmation_ref
        JOIN task_node_candidate_revisions c ON c.id = r.candidate_revision_id
        WHERE r.id = ? AND r.project_id = ?`, input.replacementId, input.projectId);
    if (!record) throw new HarnessError("not_found", "Task Node Replacement was not found in this Project");
    if (record.status !== "suspending" || !record.confirmation_resolved_at) {
      throw new HarnessError("replacement_invalid", "Replacement must be confirmed and suspended before execution");
    }
    const tree = this.database.get<{ current_revision_id: string; document_json: string }>(`
      SELECT t.current_revision_id, tr.document_json FROM task_trees t
      JOIN task_tree_revisions tr ON tr.id = t.current_revision_id
      WHERE t.id = ? AND t.project_id = ?
    `, record.tree_id, input.projectId);
    if (!tree || tree.current_revision_id !== record.expected_tree_revision_id) {
      throw new HarnessError("revision_conflict", "Task Tree changed after Replacement confirmation");
    }
    this.requireScopedEvidence(input.projectId, record.tree_id, input.activationEvidenceRefs, record.confirmation_resolved_at);
    const effects = this.database.all<{
      id: string; owner_revision_id: string; effect_type: TaskNodeEffectType; target_ref: string;
      baseline_ref: string | null; disposal_status: EffectDisposalStatus;
    }>(`SELECT id, owner_revision_id, effect_type, target_ref, baseline_ref, disposal_status
        FROM task_node_effects WHERE project_id = ? AND owner_revision_id = ? AND disposal_status = 'active' ORDER BY id`,
    input.projectId, record.old_revision_id);
    const dispositions = new Map(input.dispositions.map((item) => [item.effectId, item]));
    if (dispositions.size !== input.dispositions.length || effects.some((effect) => !dispositions.has(effect.id))
      || input.dispositions.some((item) => !effects.some((effect) => effect.id === item.effectId))) {
      throw new HarnessError("replacement_invalid", "Replacement execution requires exactly one disposition for every active owned Effect");
    }
    const decisions = effects.map((effect) => {
      const disposition = dispositions.get(effect.id)!;
      const evidenceRefs = [...new Set(disposition.evidenceRefs)].sort();
      this.requireScopedEvidence(input.projectId, record.tree_id, evidenceRefs, record.confirmation_resolved_at);
      const sharedCount = this.database.get<{ count: number }>(`
        SELECT count(*) AS count FROM task_node_effects
        WHERE project_id = ? AND target_ref = ? AND disposal_status = 'active' AND id <> ?
      `, input.projectId, effect.target_ref, effect.id)?.count ?? 0;
      let currentBaselineMatches = true;
      if (effect.effect_type === "version_reversible") {
        const artifactId = this.artifactId(effect.target_ref);
        const artifact = artifactId ? this.database.get<{ current_hash_or_version: string | null }>(
          "SELECT current_hash_or_version FROM artifacts WHERE id = ? AND project_id = ? AND tree_id = ?",
          artifactId, input.projectId, record.tree_id,
        ) : undefined;
        currentBaselineMatches = Boolean(artifact
          && artifact.current_hash_or_version === effect.baseline_ref
          && disposition.observedBaselineRef === effect.baseline_ref);
      }
      const decision = decideEffectDisposition({
        effectType: effect.effect_type, action: disposition.action,
        ownershipMatches: effect.owner_revision_id === record.old_revision_id,
        baselineMatches: currentBaselineMatches, hasSharedActiveOwner: sharedCount > 0,
        evidenceCount: evidenceRefs.length,
      });
      return { effect, disposition, evidenceRefs, decision };
    });
    const executedAt = nowIso();
    return this.database.transaction(() => {
      const disposalResultIds: string[] = [];
      const allTraceIds = new Set<string>([
        ...(JSON.parse(record.trace_event_ids_json) as string[]),
        ...input.activationEvidenceRefs,
        ...decisions.flatMap((item) => item.evidenceRefs),
      ]);
      this.database.run("UPDATE task_node_replacement_records SET status = 'disposing' WHERE id = ?", record.id);
      for (const item of decisions) {
        const resultId = newId();
        disposalResultIds.push(resultId);
        this.database.run(`INSERT INTO effect_disposal_results (
          id, project_id, replacement_id, task_node_effect_id, disposition_action,
          disposal_capability, disposal_status, observed_baseline_ref, evidence_refs_json,
          residual_impact, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        resultId, input.projectId, record.id, item.effect.id, item.disposition.action,
        item.decision.capability, item.decision.status, item.disposition.observedBaselineRef,
        canonicalJson(item.evidenceRefs), item.disposition.residualImpact.trim(), executedAt);
        this.database.run("UPDATE task_node_effects SET disposal_status = ?, disposed_at = ? WHERE id = ?",
          item.decision.status, item.decision.canProceed ? executedAt : null, item.effect.id);
      }
      const blockedEffectIds = decisions.filter((item) => !item.decision.canProceed).map((item) => item.effect.id);
      if (blockedEffectIds.length) {
        this.database.run(`UPDATE task_node_replacement_records SET status = 'disposing', disposal_result_refs_json = ?,
          trace_event_ids_json = ? WHERE id = ?`, canonicalJson(disposalResultIds), canonicalJson([...allTraceIds].sort()), record.id);
        return {
          replacementId: record.id, status: "disposing" as const, blockedEffectIds,
          activatedTreeRevisionId: null, activationVerdict: input.activationVerdict,
        };
      }
      this.database.run("UPDATE task_node_replacement_records SET status = 'activating', disposal_result_refs_json = ?, trace_event_ids_json = ? WHERE id = ?",
        canonicalJson(disposalResultIds), canonicalJson([...allTraceIds].sort()), record.id);
      if (input.activationVerdict === "failed") {
        this.database.run(`UPDATE task_node_replacement_records SET status = 'replacement_failed',
          recovery_result_json = ?, completed_at = ? WHERE id = ?`,
        canonicalJson({ activationVerdict: "failed", recoverable: decisions.every((item) =>
          item.effect.effect_type === "reversible" || item.effect.effect_type === "version_reversible") }), executedAt, record.id);
        this.database.run("UPDATE runtime_actions SET status = 'committed', result_json = ?, committed_at = ? WHERE id = ?",
          canonicalJson({ activationVerdict: "failed", replacementStatus: "replacement_failed" }), executedAt, record.runtime_action_id);
        return {
          replacementId: record.id, status: "replacement_failed" as const,
          blockedEffectIds: [], activatedTreeRevisionId: null, activationVerdict: "failed" as const,
        };
      }
      const document = JSON.parse(tree.document_json) as TaskTreeDocument;
      const candidateBody = JSON.parse(record.candidate_body_json) as TaskNodeInput;
      const candidateDocument: TaskTreeDocument = {
        ...document,
        nodes: document.nodes.map((node) => node.id === record.task_node_id ? candidateBody : node),
      };
      const activated = this.taskTrees.applyDraftChangeSetWithinTransaction({
        projectId: input.projectId, treeId: record.tree_id, baseRevisionId: tree.current_revision_id,
        operations: [{ op: "replace_document", document: candidateDocument }],
        affectedReferences: [record.task_node_id, ...effects.map((effect) => effect.target_ref)],
        decisionSummary: `Activate replacement ${record.id}`,
      });
      const activeRevisions = new Map(this.database.all<{ id: string; node_id: string }>(
        "SELECT id, node_id FROM task_node_revisions WHERE tree_revision_id = ?", activated.revisionId,
      ).map((row) => [row.node_id, row.id]));
      const candidateActiveRevisionId = activeRevisions.get(record.task_node_id)!;
      this.database.run(`INSERT INTO task_node_revision_contract_bindings (
        task_node_revision_id, project_id, tree_id, task_node_id, provides_contract_ids_json,
        requires_contract_ids_json, source_candidate_revision_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, candidateActiveRevisionId, input.projectId, record.tree_id,
      record.task_node_id, record.provides_contract_ids_json, record.requires_contract_ids_json,
      record.candidate_revision_id, executedAt);
      const diff = JSON.parse(record.contract_diff_json) as { compatibility: string; removedProvides: string[]; missingRequires: string[] };
      const affectedNodeIds = JSON.parse(record.affected_task_node_ids_json) as string[];
      for (const nodeId of affectedNodeIds) {
        const isTarget = nodeId === record.task_node_id;
        const nextComposition = isTarget && diff.missingRequires.length
          ? "pending_dependency"
          : !isTarget && diff.removedProvides.length ? "needs_replanning" : "active";
        const nextExecution = nextComposition === "needs_replanning"
          ? "pending_user_confirmation" : nextComposition === "pending_dependency" ? "blocked_by_unconfirmed_dependency" : "needs_revalidation";
        const activeRevisionId = activeRevisions.get(nodeId)!;
        this.database.run(`UPDATE task_node_composition_states SET active_revision_id = ?, composition_state = ?,
          replacement_id = ?, updated_at = ? WHERE task_node_id = ?`, activeRevisionId, nextComposition, record.id, executedAt, nodeId);
        this.database.run(`INSERT INTO task_node_composition_transitions (
          id, project_id, tree_id, task_node_id, task_node_revision_id, from_state, to_state,
          reason, replacement_id, created_at
        ) VALUES (?, ?, ?, ?, ?, 'suspending', ?, 'replacement activated', ?, ?)`,
        newId(), input.projectId, record.tree_id, nodeId, activeRevisionId, nextComposition, record.id, executedAt);
        this.database.run("UPDATE task_nodes SET status = ? WHERE id = ?", nextExecution, nodeId);
      }
      this.database.run(`UPDATE task_node_replacement_records SET status = 'completed', activated_tree_revision_id = ?,
        recovery_result_json = ?, completed_at = ? WHERE id = ?`, activated.revisionId,
      canonicalJson({ activationVerdict: "succeeded" }), executedAt, record.id);
      this.database.run("UPDATE runtime_actions SET status = 'committed', result_json = ?, committed_at = ? WHERE id = ?",
        canonicalJson({ activationVerdict: "succeeded", activatedTreeRevisionId: activated.revisionId }), executedAt, record.runtime_action_id);
      return {
        replacementId: record.id, status: "completed" as const, blockedEffectIds: [],
        activatedTreeRevisionId: activated.revisionId, activationVerdict: "succeeded" as const,
      };
    });
  }

  recoverTaskNodeReplacement(input: {
    projectId: string;
    replacementId: string;
    recoveryVerdict: "restored" | "failed";
    evidenceRefs: string[];
  }) {
    const record = this.database.get<{
      id: string; tree_id: string; old_revision_id: string; affected_task_node_ids_json: string;
      prior_execution_statuses_json: string; runtime_action_id: string; status: string;
      trace_event_ids_json: string; completed_at: string;
    }>(`SELECT id, tree_id, old_revision_id, affected_task_node_ids_json, prior_execution_statuses_json,
               runtime_action_id, status, trace_event_ids_json, completed_at
        FROM task_node_replacement_records WHERE id = ? AND project_id = ?`, input.replacementId, input.projectId);
    if (!record) throw new HarnessError("not_found", "Task Node Replacement was not found in this Project");
    if (record.status !== "replacement_failed") throw new HarnessError("replacement_invalid", "only a failed Replacement can be recovered");
    this.requireScopedEvidence(input.projectId, record.tree_id, input.evidenceRefs, record.completed_at);
    const irreversibleDispositions = this.database.get<{ count: number }>(`
      SELECT count(*) AS count FROM effect_disposal_results d
      JOIN task_node_effects e ON e.id = d.task_node_effect_id
      WHERE d.replacement_id = ? AND e.effect_type IN ('compensatable','irreversible')
    `, record.id)?.count ?? 0;
    const recoveredAt = nowIso();
    if (input.recoveryVerdict === "failed" || irreversibleDispositions > 0) {
      this.database.run("UPDATE task_node_replacement_records SET recovery_result_json = ?, trace_event_ids_json = ? WHERE id = ?",
        canonicalJson({ recoveryVerdict: "failed", reason: irreversibleDispositions ? "non_reversible_effects" : "recovery_validation_failed" }),
        canonicalJson([...new Set([...(JSON.parse(record.trace_event_ids_json) as string[]), ...input.evidenceRefs])].sort()), record.id);
      return { replacementId: record.id, status: "replacement_failed" as const, restored: false };
    }
    const affectedNodeIds = JSON.parse(record.affected_task_node_ids_json) as string[];
    const priorStatuses = JSON.parse(record.prior_execution_statuses_json) as Record<string, string>;
    this.database.transaction(() => {
      for (const nodeId of affectedNodeIds) {
        const state = this.database.get<{ active_revision_id: string; composition_state: string }>(
          "SELECT active_revision_id, composition_state FROM task_node_composition_states WHERE task_node_id = ?", nodeId,
        );
        if (!state) throw new HarnessError("replacement_invalid", "composition state is missing during recovery");
        this.database.run("UPDATE task_node_composition_states SET composition_state = 'active', replacement_id = ?, updated_at = ? WHERE task_node_id = ?",
          record.id, recoveredAt, nodeId);
        this.database.run(`INSERT INTO task_node_composition_transitions (
          id, project_id, tree_id, task_node_id, task_node_revision_id, from_state, to_state,
          reason, replacement_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', 'old revision restored', ?, ?)`,
        newId(), input.projectId, record.tree_id, nodeId, state.active_revision_id, state.composition_state, record.id, recoveredAt);
        this.database.run("UPDATE task_nodes SET status = ? WHERE id = ?", priorStatuses[nodeId] ?? "needs_revalidation", nodeId);
      }
      this.database.run(`UPDATE task_node_effects SET disposal_status = 'active', disposed_at = NULL
        WHERE id IN (SELECT task_node_effect_id FROM effect_disposal_results WHERE replacement_id = ?)`, record.id);
      this.database.run(`UPDATE task_node_replacement_records SET status = 'rolled_back', recovery_result_json = ?,
        trace_event_ids_json = ?, completed_at = ? WHERE id = ?`, canonicalJson({ recoveryVerdict: "restored" }),
      canonicalJson([...new Set([...(JSON.parse(record.trace_event_ids_json) as string[]), ...input.evidenceRefs])].sort()), recoveredAt, record.id);
      this.database.run("UPDATE runtime_actions SET result_json = ?, committed_at = ? WHERE id = ?",
        canonicalJson({ activationVerdict: "failed", recoveryVerdict: "restored" }), recoveredAt, record.runtime_action_id);
    });
    return { replacementId: record.id, status: "rolled_back" as const, restored: true };
  }

  private requireScopedEvidence(projectId: string, treeId: string, evidenceRefs: string[], notBefore: string): void {
    const refs = [...new Set(evidenceRefs)].sort();
    if (!refs.length) throw new HarnessError("evidence_not_found", "Replacement operation requires Trace evidence");
    const placeholders = refs.map(() => "?").join(", ");
    const count = this.database.get<{ count: number }>(`
      SELECT count(*) AS count FROM trace_events
      WHERE project_id = ? AND tree_id = ? AND id IN (${placeholders}) AND occurred_at >= ?
    `, projectId, treeId, ...refs, notBefore)?.count ?? 0;
    if (count !== refs.length) throw new HarnessError("evidence_scope_mismatch", "Replacement evidence is outside the Project, Tree, or confirmed lifetime");
  }

  private ensureCompositionState(projectId: string, treeId: string, nodeId: string, treeRevisionId: string, state: "active", replacementId: string | null, at: string): void {
    const revision = this.database.get<{ id: string }>(
      "SELECT id FROM task_node_revisions WHERE node_id = ? AND tree_revision_id = ?", nodeId, treeRevisionId,
    );
    if (!revision) throw new HarnessError("replacement_invalid", "affected Task Node revision was not found");
    this.database.run(`INSERT INTO task_node_composition_states (
      task_node_id, project_id, tree_id, active_revision_id, composition_state, replacement_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_node_id) DO NOTHING`,
    nodeId, projectId, treeId, revision.id, state, replacementId, at);
  }

  private setRuntimeWaiting(projectId: string, treeId: string, nodeId: string, confirmationId: string): void {
    const existing = this.database.get<{ state_json: string }>("SELECT state_json FROM runtime_states WHERE project_id = ?", projectId);
    const state = existing ? JSON.parse(existing.state_json) as Record<string, unknown> : {};
    const next = { ...state, state: "waiting_for_replacement_confirmation", waitingItemType: "high_risk_action", waitingItemId: confirmationId };
    this.database.run(`INSERT INTO runtime_states (project_id, selected_tree_id, selected_node_id, state_json, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET selected_tree_id = excluded.selected_tree_id,
      selected_node_id = excluded.selected_node_id, state_json = excluded.state_json, updated_at = excluded.updated_at`,
    projectId, treeId, nodeId, canonicalJson(next), nowIso());
  }

  private clearRuntimeWaiting(projectId: string, confirmationId: string): void {
    const existing = this.database.get<{ state_json: string }>("SELECT state_json FROM runtime_states WHERE project_id = ?", projectId);
    if (!existing) return;
    const state = JSON.parse(existing.state_json) as Record<string, unknown>;
    if (state.waitingItemId !== confirmationId) return;
    const next = { ...state, state: "active", waitingItemType: null, waitingItemId: null };
    this.database.run("UPDATE runtime_states SET state_json = ?, updated_at = ? WHERE project_id = ?", canonicalJson(next), nowIso(), projectId);
  }

  private artifactId(targetRef: string): string | null {
    return targetRef.startsWith("artifact:") && targetRef.length > "artifact:".length
      ? targetRef.slice("artifact:".length) : null;
  }

  private requireEvidence(projectId: string, treeId: string, nodeId: string, evidenceRefs: string[], notBefore: string): void {
    const placeholders = evidenceRefs.map(() => "?").join(", ");
    const count = this.database.get<{ count: number }>(`
      SELECT count(*) AS count FROM trace_events
      WHERE project_id = ? AND tree_id = ? AND node_id = ? AND id IN (${placeholders}) AND occurred_at >= ?
    `, projectId, treeId, nodeId, ...evidenceRefs, notBefore)?.count ?? 0;
    if (count !== evidenceRefs.length) {
      throw new HarnessError("evidence_scope_mismatch", "Effect evidence must belong to the owner Project, Tree, Node, and revision lifetime");
    }
  }
}
