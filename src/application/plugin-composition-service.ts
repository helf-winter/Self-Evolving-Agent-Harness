import { HarnessError } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
import {
  comparePluginContracts,
  computePluginDependencyImpactClosure,
  contractKey,
  decideRegistrationDisposal,
  validatePluginManifest,
  type PluginCompositionState,
  type PluginRegistrationDisposalAction,
  type PluginRevisionManifest,
} from "../domain/plugin-composition.js";
import {
  decideEffectDisposition,
  type EffectDispositionAction,
} from "../domain/composition.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";

interface PluginRow {
  id: string;
  current_revision_id: string | null;
  composition_state: PluginCompositionState;
  missing_requirements_json: string;
  created_at: string;
  updated_at: string;
}

interface RevisionRow {
  id: string;
  plugin_id: string;
  revision: string;
  manifest_json: string;
  status: string;
  created_at: string;
}

interface ReplacementRow {
  id: string;
  plugin_id: string;
  old_revision_id: string;
  candidate_revision_id: string;
  contract_diff_json: string;
  affected_plugin_ids_json: string;
  suspension_order_json: string;
  effect_risk_summary_json: string;
  prior_plugin_states_json: string;
  status: string;
  disposal_result_refs_json: string;
  activation_evidence_refs_json: string;
  recovery_result_json: string | null;
  created_at: string;
  completed_at: string | null;
}

interface RegistrationDispositionInput {
  registrationId: string;
  action: PluginRegistrationDisposalAction;
  evidenceRefs: string[];
  residualImpact: string;
}

interface EffectDispositionInput {
  effectId: string;
  action: EffectDispositionAction;
  observedBaselineRef: string | null;
  evidenceRefs: string[];
  residualImpact: string;
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(value) || value < 0) throw new HarnessError("invalid_input", "invalid pagination cursor");
  return value;
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset)).toString("base64url");
}

export class PluginCompositionService {
  constructor(private readonly database: RuntimeDatabase) {}

  registerRevision(input: { pluginId: string; manifest: PluginRevisionManifest }) {
    const pluginId = input.pluginId.trim();
    if (!pluginId) throw new HarnessError("plugin_composition_invalid", "Plugin ID is required");
    const errors = validatePluginManifest(input.manifest);
    if (errors.length) throw new HarnessError("plugin_composition_invalid", "Plugin manifest is invalid", { errors });
    const manifestJson = canonicalJson(input.manifest);
    const existingRevision = this.database.get<RevisionRow>(
      "SELECT * FROM runtime_plugin_revisions WHERE plugin_id = ? AND revision = ?",
      pluginId, input.manifest.revision,
    );
    if (existingRevision) {
      if (existingRevision.manifest_json !== manifestJson) {
        throw new HarnessError("plugin_composition_invalid", "Plugin revision is immutable and already has different content");
      }
      this.reconcile();
      return { ...this.summary(pluginId), revisionId: existingRevision.id, created: false };
    }
    const existingPlugin = this.database.get<PluginRow>("SELECT * FROM runtime_plugins WHERE id = ?", pluginId);
    if (existingPlugin?.current_revision_id) {
      throw new HarnessError("plugin_composition_invalid", "Plugin already has a current revision; use replacement preview");
    }

    const revisionId = newId();
    const timestamp = nowIso();
    this.database.transaction(() => {
      if (!existingPlugin) {
        this.database.run(`INSERT INTO runtime_plugins (
          id, current_revision_id, composition_state, missing_requirements_json, created_at, updated_at
        ) VALUES (?, NULL, 'pending_dependency', '[]', ?, ?)`, pluginId, timestamp, timestamp);
      }
      this.database.run(`INSERT INTO runtime_plugin_revisions (
        id, plugin_id, revision, manifest_json, status, created_at
      ) VALUES (?, ?, ?, ?, 'candidate', ?)`, revisionId, pluginId, input.manifest.revision, manifestJson, timestamp);
      this.database.run(
        "UPDATE runtime_plugins SET current_revision_id = ?, updated_at = ? WHERE id = ?",
        revisionId, timestamp, pluginId,
      );
      this.insertManifestChildren(revisionId, input.manifest, timestamp);
      this.transition(pluginId, revisionId, null, "pending_dependency", "revision_registered", null, timestamp);
    });
    this.reconcile();
    return { ...this.summary(pluginId), revisionId, created: true };
  }

  previewReplacement(input: { pluginId: string; manifest: PluginRevisionManifest }) {
    const plugin = this.requirePlugin(input.pluginId);
    if (!plugin.current_revision_id || ["disposed", "replacing", "needs_recovery"].includes(plugin.composition_state)) {
      throw new HarnessError("plugin_composition_invalid", "Plugin is not available for replacement preview");
    }
    const errors = validatePluginManifest(input.manifest);
    if (errors.length) throw new HarnessError("plugin_composition_invalid", "Plugin manifest is invalid", { errors });
    if (this.database.get(
      "SELECT id FROM runtime_plugin_revisions WHERE plugin_id = ? AND revision = ?",
      input.pluginId, input.manifest.revision,
    )) throw new HarnessError("plugin_composition_invalid", "Plugin revision already exists");
    const oldRevision = this.database.get<RevisionRow>(
      "SELECT * FROM runtime_plugin_revisions WHERE id = ?", plugin.current_revision_id,
    )!;
    const oldManifest = JSON.parse(oldRevision.manifest_json) as PluginRevisionManifest;
    const available = this.database.all<{ contract_id: string; contract_version: string }>(`
      SELECT c.contract_id, c.contract_version FROM runtime_plugin_contracts c
      JOIN runtime_plugin_revisions r ON r.id = c.plugin_revision_id
      JOIN runtime_plugins p ON p.current_revision_id = r.id
      WHERE c.direction = 'provides' AND p.composition_state = 'active' AND p.id <> ?
      ORDER BY c.contract_id, c.contract_version
    `, input.pluginId).map((row) => ({ contractId: row.contract_id, version: row.contract_version }));
    const contractDiff = comparePluginContracts({
      oldProvides: oldManifest.provides, oldRequires: oldManifest.requires,
      candidateProvides: input.manifest.provides, candidateRequires: input.manifest.requires,
      availableProviderContracts: available,
    });
    const edges = this.database.all<{ provider_plugin_id: string; consumer_plugin_id: string }>(
      "SELECT provider_plugin_id, consumer_plugin_id FROM runtime_plugin_dependency_edges WHERE active = 1",
    ).map((row) => ({ providerPluginId: row.provider_plugin_id, consumerPluginId: row.consumer_plugin_id }));
    const impact = computePluginDependencyImpactClosure({ replacedPluginId: input.pluginId, dependencyEdges: edges });
    const effectRows = this.database.all<{ effect_type: string }>(
      "SELECT effect_type FROM runtime_plugin_effects WHERE plugin_revision_id = ? AND disposal_status = 'active'",
      plugin.current_revision_id,
    );
    const effectRiskSummary = effectRows.reduce<Record<string, number>>((summary, row) => {
      summary[row.effect_type] = (summary[row.effect_type] ?? 0) + 1;
      return summary;
    }, {});
    const priorStates = Object.fromEntries(impact.affectedPluginIds.map((pluginId) => {
      const row = this.requirePlugin(pluginId);
      return [pluginId, row.composition_state];
    }));
    const candidateRevisionId = newId();
    const replacementId = newId();
    const timestamp = nowIso();
    this.database.transaction(() => {
      this.database.run(`INSERT INTO runtime_plugin_revisions (
        id, plugin_id, revision, manifest_json, status, created_at
      ) VALUES (?, ?, ?, ?, 'candidate', ?)`, candidateRevisionId, input.pluginId,
      input.manifest.revision, canonicalJson(input.manifest), timestamp);
      this.insertManifestChildren(candidateRevisionId, input.manifest, timestamp);
      this.database.run(`INSERT INTO runtime_plugin_replacement_records (
        id, plugin_id, old_revision_id, candidate_revision_id, contract_diff_json,
        affected_plugin_ids_json, suspension_order_json, effect_risk_summary_json,
        prior_plugin_states_json, status, disposal_result_refs_json,
        activation_evidence_refs_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'previewed', '[]', '[]', ?)`,
      replacementId, input.pluginId, plugin.current_revision_id, candidateRevisionId,
      canonicalJson(contractDiff), canonicalJson(impact.affectedPluginIds), canonicalJson(impact.suspensionOrder),
      canonicalJson(effectRiskSummary), canonicalJson(priorStates), timestamp);
    });
    return {
      replacementId, pluginId: input.pluginId, oldRevisionId: plugin.current_revision_id,
      candidateRevisionId, status: "previewed", contractDiff,
      affectedPluginIds: impact.affectedPluginIds, suspensionOrder: impact.suspensionOrder,
      effectRiskSummary,
    };
  }

  executeReplacement(input: {
    replacementId: string;
    registrationDispositions: RegistrationDispositionInput[];
    effectDispositions: EffectDispositionInput[];
    activationVerdict: "succeeded" | "failed";
    activationEvidenceRefs: string[];
  }) {
    if (!input.activationEvidenceRefs.length) {
      throw new HarnessError("plugin_composition_invalid", "Plugin activation evidence is required");
    }
    const replacement = this.requireReplacement(input.replacementId);
    if (!["previewed", "disposing"].includes(replacement.status)) {
      throw new HarnessError("plugin_composition_invalid", "Plugin replacement is not executable in its current state");
    }
    const oldRegistrations = this.database.all<{ id: string; disposer_ref: string }>(
      "SELECT id, disposer_ref FROM runtime_plugin_registrations WHERE plugin_revision_id = ? ORDER BY id",
      replacement.old_revision_id,
    );
    const oldEffects = this.database.all<{
      id: string; effect_type: "reversible" | "version_reversible" | "compensatable" | "irreversible";
      target_ref: string; baseline_ref: string | null;
    }>("SELECT id, effect_type, target_ref, baseline_ref FROM runtime_plugin_effects WHERE plugin_revision_id = ? ORDER BY id",
      replacement.old_revision_id);
    this.requireCompleteDispositionSet(oldRegistrations.map((row) => row.id), input.registrationDispositions.map((row) => row.registrationId), "registration");
    this.requireCompleteDispositionSet(oldEffects.map((row) => row.id), input.effectDispositions.map((row) => row.effectId), "effect");

    const outcome = this.database.transaction(() => {
      const createdAt = nowIso();
      const resultIds: string[] = [];
      const blockedRegistrationIds: string[] = [];
      const blockedEffectIds: string[] = [];
      for (const registration of oldRegistrations) {
        const disposition = input.registrationDispositions.find((item) => item.registrationId === registration.id)!;
        const decision = decideRegistrationDisposal({
          disposerDeclared: Boolean(registration.disposer_ref.trim()), action: disposition.action,
          evidenceCount: disposition.evidenceRefs.length,
        });
        const resultId = newId(); resultIds.push(resultId);
        this.database.run(`INSERT INTO runtime_plugin_registration_disposals (
          id, replacement_id, plugin_registration_id, disposition_action, disposal_status,
          evidence_refs_json, residual_impact, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, resultId, input.replacementId, registration.id,
        disposition.action, decision.status, canonicalJson(disposition.evidenceRefs), disposition.residualImpact, createdAt);
        if (!decision.canProceed) blockedRegistrationIds.push(registration.id);
      }
      for (const effect of oldEffects) {
        const disposition = input.effectDispositions.find((item) => item.effectId === effect.id)!;
        const sharedOwnerCount = this.database.get<{ count: number }>(`
          SELECT count(*) AS count FROM runtime_plugin_effects e
          JOIN runtime_plugin_revisions r ON r.id = e.plugin_revision_id
          JOIN runtime_plugins p ON p.current_revision_id = r.id
          WHERE e.id <> ? AND e.target_ref = ? AND e.disposal_status = 'active' AND p.composition_state = 'active'
        `, effect.id, effect.target_ref)?.count ?? 0;
        const decision = decideEffectDisposition({
          effectType: effect.effect_type, action: disposition.action, ownershipMatches: true,
          baselineMatches: effect.effect_type !== "version_reversible" || effect.baseline_ref === disposition.observedBaselineRef,
          hasSharedActiveOwner: sharedOwnerCount > 0, evidenceCount: disposition.evidenceRefs.length,
        });
        const resultId = newId(); resultIds.push(resultId);
        this.database.run(`INSERT INTO runtime_plugin_effect_disposals (
          id, replacement_id, plugin_effect_id, disposition_action, disposal_capability,
          disposal_status, observed_baseline_ref, evidence_refs_json, residual_impact, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, resultId, input.replacementId, effect.id,
        disposition.action, decision.capability, decision.status, disposition.observedBaselineRef,
        canonicalJson(disposition.evidenceRefs), disposition.residualImpact, createdAt);
        if (!decision.canProceed) blockedEffectIds.push(effect.id);
      }
      if (blockedRegistrationIds.length || blockedEffectIds.length) {
        this.database.run(`UPDATE runtime_plugin_replacement_records
          SET status = 'disposing', disposal_result_refs_json = ? WHERE id = ?`,
        canonicalJson(resultIds), input.replacementId);
        return { status: "disposing", activated: false, needsRecovery: false, blockedRegistrationIds, blockedEffectIds };
      }

      const suspensionOrder = JSON.parse(replacement.suspension_order_json) as string[];
      for (const pluginId of suspensionOrder) {
        const plugin = this.requirePlugin(pluginId);
        if (plugin.composition_state === "disposed") continue;
        const toState: PluginCompositionState = pluginId === replacement.plugin_id ? "replacing" : "suspending";
        if (plugin.composition_state !== toState) {
          this.database.run("UPDATE runtime_plugins SET composition_state = ?, updated_at = ? WHERE id = ?", toState, createdAt, pluginId);
          this.transition(pluginId, plugin.current_revision_id, plugin.composition_state, toState,
            "plugin_replacement_suspension", input.replacementId, createdAt);
        }
      }
      this.applyDispositionStatuses(input.registrationDispositions, input.effectDispositions, createdAt);
      this.database.run(`UPDATE runtime_plugin_replacement_records SET status = 'activating',
        disposal_result_refs_json = ?, activation_evidence_refs_json = ? WHERE id = ?`,
      canonicalJson(resultIds), canonicalJson(input.activationEvidenceRefs), input.replacementId);

      if (input.activationVerdict === "failed") {
        const needsRecovery = input.registrationDispositions.some((item) => item.action === "disposed")
          || input.effectDispositions.some((item) => item.action !== "retain");
        this.database.run("UPDATE runtime_plugin_revisions SET status = 'failed' WHERE id = ?", replacement.candidate_revision_id);
        this.database.run(`UPDATE runtime_plugin_replacement_records
          SET status = 'replacement_failed', completed_at = ? WHERE id = ?`, createdAt, input.replacementId);
        const current = this.requirePlugin(replacement.plugin_id);
        const target: PluginCompositionState = needsRecovery ? "needs_recovery" : "active";
        this.database.run("UPDATE runtime_plugins SET composition_state = ?, updated_at = ? WHERE id = ?", target, createdAt, replacement.plugin_id);
        this.transition(replacement.plugin_id, replacement.old_revision_id, current.composition_state, target,
          "candidate_activation_failed", input.replacementId, createdAt);
        return { status: "replacement_failed", activated: false, needsRecovery, blockedRegistrationIds, blockedEffectIds };
      }

      this.database.run("UPDATE runtime_plugin_revisions SET status = 'replaced' WHERE id = ?", replacement.old_revision_id);
      this.database.run("UPDATE runtime_plugin_revisions SET status = 'candidate' WHERE id = ?", replacement.candidate_revision_id);
      this.database.run(`UPDATE runtime_plugins SET current_revision_id = ?, composition_state = 'pending_dependency',
        missing_requirements_json = '[]', updated_at = ? WHERE id = ?`,
      replacement.candidate_revision_id, createdAt, replacement.plugin_id);
      this.database.run(`UPDATE runtime_plugin_replacement_records
        SET status = 'completed', completed_at = ? WHERE id = ?`, createdAt, input.replacementId);
      this.transition(replacement.plugin_id, replacement.candidate_revision_id, "replacing", "pending_dependency",
        "candidate_revision_activated", input.replacementId, createdAt);
      return { status: "completed", activated: true, needsRecovery: false, blockedRegistrationIds, blockedEffectIds };
    });
    if (outcome.status !== "disposing") this.reconcile();
    return outcome;
  }

  recoverReplacement(input: {
    replacementId: string; recoveryVerdict: "restored" | "failed"; evidenceRefs: string[];
  }) {
    if (!input.evidenceRefs.length) throw new HarnessError("plugin_composition_invalid", "Recovery evidence is required");
    const replacement = this.requireReplacement(input.replacementId);
    if (replacement.status !== "replacement_failed") {
      throw new HarnessError("plugin_composition_invalid", "Plugin replacement is not recoverable in its current state");
    }
    const plugin = this.requirePlugin(replacement.plugin_id);
    if (input.recoveryVerdict === "failed") {
      this.database.run("UPDATE runtime_plugin_replacement_records SET recovery_result_json = ? WHERE id = ?",
        canonicalJson({ recoveryVerdict: "failed", evidenceRefs: input.evidenceRefs }), input.replacementId);
      return { status: "replacement_failed", restored: false };
    }
    const compensated = this.database.get<{ count: number }>(`
      SELECT count(*) AS count FROM runtime_plugin_effect_disposals d
      JOIN runtime_plugin_effects e ON e.id = d.plugin_effect_id
      WHERE d.replacement_id = ? AND e.effect_type IN ('compensatable', 'irreversible')
        AND d.disposal_status IN ('compensated', 'not_disposable')
    `, input.replacementId)?.count ?? 0;
    if (compensated > 0) throw new HarnessError("plugin_composition_invalid", "Compensated or irreversible Plugin effects cannot be described as restored");
    const timestamp = nowIso();
    this.database.transaction(() => {
      this.database.run("UPDATE runtime_plugin_registrations SET status = 'active', disposed_at = NULL WHERE plugin_revision_id = ?", replacement.old_revision_id);
      this.database.run("UPDATE runtime_plugin_effects SET disposal_status = 'active', disposed_at = NULL WHERE plugin_revision_id = ?", replacement.old_revision_id);
      this.database.run("UPDATE runtime_plugin_revisions SET status = 'active' WHERE id = ?", replacement.old_revision_id);
      this.database.run("UPDATE runtime_plugin_revisions SET status = 'failed' WHERE id = ?", replacement.candidate_revision_id);
      this.database.run(`UPDATE runtime_plugins SET current_revision_id = ?, composition_state = 'pending_dependency',
        missing_requirements_json = '[]', updated_at = ? WHERE id = ?`,
      replacement.old_revision_id, timestamp, replacement.plugin_id);
      this.database.run(`UPDATE runtime_plugin_replacement_records SET status = 'rolled_back',
        recovery_result_json = ?, completed_at = ? WHERE id = ?`,
      canonicalJson({ recoveryVerdict: "restored", evidenceRefs: input.evidenceRefs }), timestamp, input.replacementId);
      this.transition(replacement.plugin_id, replacement.old_revision_id, plugin.composition_state, "pending_dependency",
        "old_revision_restored", input.replacementId, timestamp);
    });
    this.reconcile();
    return { status: "rolled_back", restored: true };
  }

  reconcile() {
    return this.database.transaction(() => {
      const plugins = this.database.all<PluginRow>(
        "SELECT * FROM runtime_plugins ORDER BY id",
      );
      let changed = true;
      let pass = 0;
      const maxPasses = Math.max(plugins.length * 2 + 1, 1);
      while (changed && pass < maxPasses) {
        pass += 1;
        changed = false;
        this.database.run("DELETE FROM runtime_plugin_dependency_edges");
        const activeProviders = this.activeProviderIndex();
        for (const plugin of this.database.all<PluginRow>("SELECT * FROM runtime_plugins ORDER BY id")) {
          if (!plugin.current_revision_id || ["disposed", "replacing", "needs_recovery"].includes(plugin.composition_state)) continue;
          const requirements = this.database.all<{ contract_id: string; contract_version: string }>(
            `SELECT contract_id, contract_version FROM runtime_plugin_contracts
             WHERE plugin_revision_id = ? AND direction = 'requires'
             ORDER BY contract_id, contract_version`, plugin.current_revision_id,
          );
          const missing: string[] = [];
          for (const requirement of requirements) {
            const key = contractKey({ contractId: requirement.contract_id, version: requirement.contract_version });
            const providers = (activeProviders.get(key) ?? []).filter((provider) => provider.pluginId !== plugin.id);
            const provider = providers[0];
            if (!provider) {
              missing.push(key);
              continue;
            }
            this.database.run(`INSERT INTO runtime_plugin_dependency_edges (
              id, consumer_plugin_id, consumer_revision_id, provider_plugin_id, provider_revision_id,
              contract_id, contract_version, active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            newId(), plugin.id, plugin.current_revision_id, provider.pluginId, provider.revisionId,
            requirement.contract_id, requirement.contract_version, nowIso(), nowIso());
          }
          const desired: PluginCompositionState = missing.length ? "pending_dependency" : "active";
          const stateChanged = plugin.composition_state !== desired;
          const requirementsChanged = canonicalJson(JSON.parse(plugin.missing_requirements_json) as unknown) !== canonicalJson(missing);
          if (stateChanged || requirementsChanged) {
            const timestamp = nowIso();
            this.database.run(
              "UPDATE runtime_plugins SET composition_state = ?, missing_requirements_json = ?, updated_at = ? WHERE id = ?",
              desired, canonicalJson(missing), timestamp, plugin.id,
            );
            this.database.run(
              "UPDATE runtime_plugin_revisions SET status = ? WHERE id = ?",
              desired === "active" ? "active" : "suspended", plugin.current_revision_id,
            );
            this.database.run(
              "UPDATE runtime_plugin_registrations SET status = ? WHERE plugin_revision_id = ? AND status IN ('declared', 'active')",
              desired === "active" ? "active" : "declared", plugin.current_revision_id,
            );
            this.database.run(
              "UPDATE runtime_plugin_effects SET disposal_status = ? WHERE plugin_revision_id = ? AND disposal_status IN ('pending', 'active')",
              desired === "active" ? "active" : "pending", plugin.current_revision_id,
            );
            if (stateChanged) {
              this.transition(plugin.id, plugin.current_revision_id, plugin.composition_state, desired,
                missing.length ? "missing_provider_contract" : "requirements_satisfied", null, timestamp);
            }
            changed = true;
          }
        }
      }
      if (changed) throw new HarnessError("plugin_composition_invalid", "Plugin dependency resolution did not reach a fixed point");
      return { passes: pass, plugins: this.listPlugins({}).items };
    });
  }

  listPlugins(query: { state?: PluginCompositionState; limit?: number; cursor?: string }) {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = decodeCursor(query.cursor);
    const rows = this.database.all<PluginRow>(
      `SELECT * FROM runtime_plugins ${query.state ? "WHERE composition_state = ?" : ""}
       ORDER BY id LIMIT ? OFFSET ?`,
      ...(query.state ? [query.state] : []), limit + 1, offset,
    );
    return {
      items: rows.slice(0, limit).map((row) => this.mapPlugin(row)),
      nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
    };
  }

  disposePlugin(input: {
    pluginId: string;
    registrationDispositions: RegistrationDispositionInput[];
    effectDispositions: EffectDispositionInput[];
  }) {
    const plugin = this.requirePlugin(input.pluginId);
    if (!plugin.current_revision_id || plugin.composition_state === "disposed") {
      throw new HarnessError("plugin_composition_invalid", "Plugin is not disposable in its current state");
    }
    const registrations = this.database.all<{ id: string; disposer_ref: string }>(
      "SELECT id, disposer_ref FROM runtime_plugin_registrations WHERE plugin_revision_id = ? ORDER BY id", plugin.current_revision_id,
    );
    const effects = this.database.all<{
      id: string; effect_type: "reversible" | "version_reversible" | "compensatable" | "irreversible";
      target_ref: string; baseline_ref: string | null;
    }>("SELECT id, effect_type, target_ref, baseline_ref FROM runtime_plugin_effects WHERE plugin_revision_id = ? ORDER BY id", plugin.current_revision_id);
    this.requireCompleteDispositionSet(registrations.map((row) => row.id), input.registrationDispositions.map((row) => row.registrationId), "registration");
    this.requireCompleteDispositionSet(effects.map((row) => row.id), input.effectDispositions.map((row) => row.effectId), "effect");
    const timestamp = nowIso();
    const blockedRegistrationIds: string[] = [];
    const blockedEffectIds: string[] = [];
    this.database.transaction(() => {
      for (const registration of registrations) {
        const disposition = input.registrationDispositions.find((item) => item.registrationId === registration.id)!;
        const decision = decideRegistrationDisposal({
          disposerDeclared: Boolean(registration.disposer_ref.trim()), action: disposition.action,
          evidenceCount: disposition.evidenceRefs.length,
        });
        this.database.run(`INSERT INTO runtime_plugin_registration_disposals (
          id, replacement_id, plugin_registration_id, disposition_action, disposal_status,
          evidence_refs_json, residual_impact, created_at
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`, newId(), registration.id, disposition.action,
        decision.status, canonicalJson(disposition.evidenceRefs), disposition.residualImpact, timestamp);
        if (!decision.canProceed) blockedRegistrationIds.push(registration.id);
      }
      for (const effect of effects) {
        const disposition = input.effectDispositions.find((item) => item.effectId === effect.id)!;
        const sharedOwnerCount = this.activeSharedEffectOwnerCount(effect.id, effect.target_ref);
        const decision = decideEffectDisposition({
          effectType: effect.effect_type, action: disposition.action, ownershipMatches: true,
          baselineMatches: effect.effect_type !== "version_reversible" || effect.baseline_ref === disposition.observedBaselineRef,
          hasSharedActiveOwner: sharedOwnerCount > 0, evidenceCount: disposition.evidenceRefs.length,
        });
        this.database.run(`INSERT INTO runtime_plugin_effect_disposals (
          id, replacement_id, plugin_effect_id, disposition_action, disposal_capability,
          disposal_status, observed_baseline_ref, evidence_refs_json, residual_impact, created_at
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`, newId(), effect.id, disposition.action,
        decision.capability, decision.status, disposition.observedBaselineRef,
        canonicalJson(disposition.evidenceRefs), disposition.residualImpact, timestamp);
        if (!decision.canProceed) blockedEffectIds.push(effect.id);
      }
      if (blockedRegistrationIds.length || blockedEffectIds.length) return;
      this.applyDispositionStatuses(input.registrationDispositions, input.effectDispositions, timestamp);
      this.database.run("UPDATE runtime_plugin_revisions SET status = 'disposed' WHERE id = ?", plugin.current_revision_id);
      this.database.run(`UPDATE runtime_plugins SET composition_state = 'disposed', missing_requirements_json = '[]', updated_at = ? WHERE id = ?`,
        timestamp, input.pluginId);
      this.transition(input.pluginId, plugin.current_revision_id, plugin.composition_state, "disposed", "plugin_disposed", null, timestamp);
    });
    if (blockedRegistrationIds.length || blockedEffectIds.length) {
      return { ...this.summary(input.pluginId), disposed: false, blockedRegistrationIds, blockedEffectIds };
    }
    this.reconcile();
    return { ...this.summary(input.pluginId), disposed: true, blockedRegistrationIds, blockedEffectIds };
  }

  reactivatePlugin(input: { pluginId: string; evidenceRefs: string[] }) {
    if (!input.evidenceRefs.length) throw new HarnessError("plugin_composition_invalid", "Plugin reactivation evidence is required");
    const plugin = this.requirePlugin(input.pluginId);
    if (!plugin.current_revision_id || plugin.composition_state !== "disposed") {
      throw new HarnessError("plugin_composition_invalid", "Plugin is not disposed");
    }
    const timestamp = nowIso();
    this.database.transaction(() => {
      this.database.run("UPDATE runtime_plugin_revisions SET status = 'candidate' WHERE id = ?", plugin.current_revision_id);
      this.database.run("UPDATE runtime_plugin_registrations SET status = 'declared', disposed_at = NULL WHERE plugin_revision_id = ?", plugin.current_revision_id);
      this.database.run("UPDATE runtime_plugin_effects SET disposal_status = 'pending', disposed_at = NULL WHERE plugin_revision_id = ?", plugin.current_revision_id);
      this.database.run(`UPDATE runtime_plugins SET composition_state = 'pending_dependency',
        missing_requirements_json = '[]', updated_at = ? WHERE id = ?`, timestamp, input.pluginId);
      this.transition(input.pluginId, plugin.current_revision_id, "disposed", "pending_dependency",
        `binding_reactivated:${input.evidenceRefs.length}`, null, timestamp);
    });
    this.reconcile();
    return this.summary(input.pluginId);
  }

  getReplacementDetail(replacementId: string) {
    const replacement = this.requireReplacement(replacementId);
    const registrationDisposals = this.database.all<{
      id: string; plugin_registration_id: string; disposition_action: string; disposal_status: string;
      evidence_refs_json: string; residual_impact: string; created_at: string;
    }>("SELECT * FROM runtime_plugin_registration_disposals WHERE replacement_id = ? ORDER BY rowid", replacementId);
    const effectDisposals = this.database.all<{
      id: string; plugin_effect_id: string; disposition_action: string; disposal_capability: string;
      disposal_status: string; observed_baseline_ref: string | null; evidence_refs_json: string;
      residual_impact: string; created_at: string;
    }>("SELECT * FROM runtime_plugin_effect_disposals WHERE replacement_id = ? ORDER BY rowid", replacementId);
    return {
      replacement: {
        replacementId: replacement.id, pluginId: replacement.plugin_id,
        oldRevisionId: replacement.old_revision_id, candidateRevisionId: replacement.candidate_revision_id,
        contractDiff: JSON.parse(replacement.contract_diff_json) as unknown,
        affectedPluginIds: JSON.parse(replacement.affected_plugin_ids_json) as string[],
        suspensionOrder: JSON.parse(replacement.suspension_order_json) as string[],
        effectRiskSummary: JSON.parse(replacement.effect_risk_summary_json) as unknown,
        priorPluginStates: JSON.parse(replacement.prior_plugin_states_json) as unknown,
        status: replacement.status,
        activationEvidenceRefs: JSON.parse(replacement.activation_evidence_refs_json) as string[],
        recoveryResult: replacement.recovery_result_json ? JSON.parse(replacement.recovery_result_json) as unknown : null,
        createdAt: replacement.created_at, completedAt: replacement.completed_at,
      },
      registrationDisposals: registrationDisposals.map((row) => ({
        disposalId: row.id, registrationId: row.plugin_registration_id, action: row.disposition_action,
        disposalStatus: row.disposal_status, evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
        residualImpact: row.residual_impact, createdAt: row.created_at,
      })),
      effectDisposals: effectDisposals.map((row) => ({
        disposalId: row.id, effectId: row.plugin_effect_id, action: row.disposition_action,
        capability: row.disposal_capability, disposalStatus: row.disposal_status,
        observedBaselineRef: row.observed_baseline_ref,
        evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
        residualImpact: row.residual_impact, createdAt: row.created_at,
      })),
    };
  }

  getPluginDetail(pluginId: string) {
    const plugin = this.requirePlugin(pluginId);
    const revisions = this.database.all<RevisionRow>(
      "SELECT * FROM runtime_plugin_revisions WHERE plugin_id = ? ORDER BY created_at, rowid", pluginId,
    );
    const currentRevisionId = plugin.current_revision_id;
    const registrations = this.database.all<{
      id: string; registration_key: string; registration_kind: string; target_ref: string;
      disposer_kind: string; disposer_ref: string; status: string; created_at: string; disposed_at: string | null;
      plugin_revision_id: string;
    }>(`SELECT rg.* FROM runtime_plugin_registrations rg
        JOIN runtime_plugin_revisions r ON r.id = rg.plugin_revision_id
        WHERE r.plugin_id = ? ORDER BY r.created_at, rg.registration_key`, pluginId);
    const effects = this.database.all<{
      id: string; effect_key: string; effect_type: string; target_ref: string; operation: string;
      baseline_ref: string | null; inverse_operation: string | null; compensation_operation: string | null;
      evidence_refs_json: string; disposal_status: string; created_at: string; disposed_at: string | null;
      plugin_revision_id: string;
    }>(`SELECT e.* FROM runtime_plugin_effects e
        JOIN runtime_plugin_revisions r ON r.id = e.plugin_revision_id
        WHERE r.plugin_id = ? ORDER BY r.created_at, e.effect_key`, pluginId);
    const dependencies = this.database.all<{
      id: string; consumer_plugin_id: string; consumer_revision_id: string; provider_plugin_id: string;
      provider_revision_id: string; contract_id: string; contract_version: string; active: number;
    }>(`SELECT * FROM runtime_plugin_dependency_edges
        WHERE consumer_plugin_id = ? OR provider_plugin_id = ?
        ORDER BY consumer_plugin_id, provider_plugin_id, contract_id, contract_version`, pluginId, pluginId);
    const transitions = this.database.all<{
      id: string; plugin_revision_id: string | null; from_state: string | null; to_state: string;
      reason: string; replacement_id: string | null; created_at: string;
    }>("SELECT * FROM runtime_plugin_composition_transitions WHERE plugin_id = ? ORDER BY rowid", pluginId);
    return {
      plugin: this.mapPlugin(plugin),
      revisions: revisions.map((row) => ({
        revisionId: row.id, revision: row.revision,
        manifest: JSON.parse(row.manifest_json) as PluginRevisionManifest,
        status: row.status, createdAt: row.created_at,
      })),
      registrations: registrations.map((row) => ({
        registrationId: row.id, revisionId: row.plugin_revision_id, key: row.registration_key, kind: row.registration_kind,
        targetRef: row.target_ref, disposerKind: row.disposer_kind, disposerRef: row.disposer_ref,
        status: row.status, createdAt: row.created_at, disposedAt: row.disposed_at,
      })),
      effects: effects.map((row) => ({
        effectId: row.id, revisionId: row.plugin_revision_id, key: row.effect_key, effectType: row.effect_type,
        targetRef: row.target_ref, operation: row.operation, baselineRef: row.baseline_ref,
        inverseOperation: row.inverse_operation, compensationOperation: row.compensation_operation,
        evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
        disposalStatus: row.disposal_status, createdAt: row.created_at, disposedAt: row.disposed_at,
      })),
      dependencies: dependencies.map((row) => ({
        dependencyId: row.id, consumerPluginId: row.consumer_plugin_id,
        consumerRevisionId: row.consumer_revision_id, providerPluginId: row.provider_plugin_id,
        providerRevisionId: row.provider_revision_id, contractId: row.contract_id,
        contractVersion: row.contract_version, active: row.active === 1,
      })),
      transitions: transitions.map((row) => ({
        transitionId: row.id, revisionId: row.plugin_revision_id,
        fromState: row.from_state, toState: row.to_state, reason: row.reason,
        replacementId: row.replacement_id, createdAt: row.created_at,
      })),
    };
  }

  private insertManifestChildren(revisionId: string, manifest: PluginRevisionManifest, createdAt: string): void {
    for (const contract of manifest.provides) {
      this.database.run(`INSERT INTO runtime_plugin_contracts (
        plugin_revision_id, direction, contract_id, contract_version
      ) VALUES (?, 'provides', ?, ?)`, revisionId, contract.contractId.trim(), contract.version.trim());
    }
    for (const contract of manifest.requires) {
      this.database.run(`INSERT INTO runtime_plugin_contracts (
        plugin_revision_id, direction, contract_id, contract_version
      ) VALUES (?, 'requires', ?, ?)`, revisionId, contract.contractId.trim(), contract.version.trim());
    }
    for (const registration of manifest.registrations) {
      this.database.run(`INSERT INTO runtime_plugin_registrations (
        id, plugin_revision_id, registration_key, registration_kind, target_ref,
        disposer_kind, disposer_ref, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'declared', ?)`, newId(), revisionId, registration.key.trim(),
      registration.kind, registration.targetRef.trim(), registration.disposerKind, registration.disposerRef.trim(), createdAt);
    }
    for (const effect of manifest.effects) {
      this.database.run(`INSERT INTO runtime_plugin_effects (
        id, plugin_revision_id, effect_key, effect_type, target_ref, operation, baseline_ref,
        inverse_operation, compensation_operation, evidence_refs_json, disposal_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`, newId(), revisionId, effect.key.trim(),
      effect.effectType, effect.targetRef.trim(), effect.operation.trim(), effect.baselineRef,
      effect.inverseOperation, effect.compensationOperation, canonicalJson(effect.evidenceRefs), createdAt);
    }
  }

  private requireCompleteDispositionSet(expected: string[], actual: string[], kind: string): void {
    const expectedSorted = [...expected].sort();
    const actualSorted = [...actual].sort();
    if (new Set(actual).size !== actual.length || canonicalJson(expectedSorted) !== canonicalJson(actualSorted)) {
      throw new HarnessError("plugin_composition_invalid", `Every old Plugin ${kind} must have exactly one disposition`);
    }
  }

  private applyDispositionStatuses(
    registrations: RegistrationDispositionInput[], effects: EffectDispositionInput[], disposedAt: string,
  ): void {
    for (const disposition of registrations) {
      this.database.run(
        "UPDATE runtime_plugin_registrations SET status = ?, disposed_at = ? WHERE id = ?",
        disposition.action === "disposed" ? "disposed" : "retained", disposedAt, disposition.registrationId,
      );
    }
    for (const disposition of effects) {
      const status = disposition.action === "inverse_applied" ? "disposed"
        : disposition.action === "compensation_applied" ? "compensated" : "not_disposable";
      this.database.run(
        "UPDATE runtime_plugin_effects SET disposal_status = ?, disposed_at = ? WHERE id = ?",
        status, disposedAt, disposition.effectId,
      );
    }
  }

  private activeSharedEffectOwnerCount(effectId: string, targetRef: string): number {
    return this.database.get<{ count: number }>(`
      SELECT count(*) AS count FROM runtime_plugin_effects e
      JOIN runtime_plugin_revisions r ON r.id = e.plugin_revision_id
      JOIN runtime_plugins p ON p.current_revision_id = r.id
      WHERE e.id <> ? AND e.target_ref = ? AND e.disposal_status = 'active' AND p.composition_state = 'active'
    `, effectId, targetRef)?.count ?? 0;
  }

  private activeProviderIndex(): Map<string, Array<{ pluginId: string; revisionId: string }>> {
    const rows = this.database.all<{
      plugin_id: string; revision_id: string; contract_id: string; contract_version: string;
    }>(`SELECT p.id AS plugin_id, r.id AS revision_id, c.contract_id, c.contract_version
        FROM runtime_plugins p
        JOIN runtime_plugin_revisions r ON r.id = p.current_revision_id
        JOIN runtime_plugin_contracts c ON c.plugin_revision_id = r.id AND c.direction = 'provides'
        WHERE p.composition_state = 'active' AND r.status = 'active'
        ORDER BY p.id`);
    const index = new Map<string, Array<{ pluginId: string; revisionId: string }>>();
    for (const row of rows) {
      const key = contractKey({ contractId: row.contract_id, version: row.contract_version });
      const providers = index.get(key) ?? [];
      providers.push({ pluginId: row.plugin_id, revisionId: row.revision_id });
      index.set(key, providers);
    }
    return index;
  }

  private summary(pluginId: string) {
    return this.mapPlugin(this.requirePlugin(pluginId));
  }

  private requirePlugin(pluginId: string): PluginRow {
    const plugin = this.database.get<PluginRow>("SELECT * FROM runtime_plugins WHERE id = ?", pluginId);
    if (!plugin) throw new HarnessError("not_found", "Runtime Plugin was not found");
    return plugin;
  }

  private requireReplacement(replacementId: string): ReplacementRow {
    const replacement = this.database.get<ReplacementRow>(
      "SELECT * FROM runtime_plugin_replacement_records WHERE id = ?", replacementId,
    );
    if (!replacement) throw new HarnessError("not_found", "Runtime Plugin Replacement was not found");
    return replacement;
  }

  private mapPlugin(row: PluginRow) {
    const revision = row.current_revision_id
      ? this.database.get<{ revision: string }>("SELECT revision FROM runtime_plugin_revisions WHERE id = ?", row.current_revision_id)
      : undefined;
    return {
      pluginId: row.id, currentRevisionId: row.current_revision_id,
      currentRevision: revision?.revision ?? null, compositionState: row.composition_state,
      missingRequirements: JSON.parse(row.missing_requirements_json) as string[],
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  private transition(
    pluginId: string,
    revisionId: string | null,
    fromState: PluginCompositionState | null,
    toState: PluginCompositionState,
    reason: string,
    replacementId: string | null,
    createdAt: string,
  ): void {
    this.database.run(`INSERT INTO runtime_plugin_composition_transitions (
      id, plugin_id, plugin_revision_id, from_state, to_state, reason, replacement_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(), pluginId, revisionId, fromState, toState, reason, replacementId, createdAt);
  }
}
