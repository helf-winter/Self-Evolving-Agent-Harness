import { HarnessError } from "../domain/errors.js";
import {
  disposalCapability,
  validateEffectDefinition,
  type EffectDisposalCapability,
  type EffectDisposalStatus,
  type TaskNodeEffectType,
} from "../domain/composition.js";
import { newId, nowIso } from "../domain/ids.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";

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
  constructor(private readonly database: RuntimeDatabase) {}

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
