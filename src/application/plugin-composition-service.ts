import { HarnessError } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
import {
  contractKey,
  validatePluginManifest,
  type PluginCompositionState,
  type PluginRevisionManifest,
} from "../domain/plugin-composition.js";
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

  getPluginDetail(pluginId: string) {
    const plugin = this.requirePlugin(pluginId);
    const revisions = this.database.all<RevisionRow>(
      "SELECT * FROM runtime_plugin_revisions WHERE plugin_id = ? ORDER BY created_at, rowid", pluginId,
    );
    const currentRevisionId = plugin.current_revision_id;
    const registrations = currentRevisionId ? this.database.all<{
      id: string; registration_key: string; registration_kind: string; target_ref: string;
      disposer_kind: string; disposer_ref: string; status: string; created_at: string; disposed_at: string | null;
    }>("SELECT * FROM runtime_plugin_registrations WHERE plugin_revision_id = ? ORDER BY registration_key", currentRevisionId) : [];
    const effects = currentRevisionId ? this.database.all<{
      id: string; effect_key: string; effect_type: string; target_ref: string; operation: string;
      baseline_ref: string | null; inverse_operation: string | null; compensation_operation: string | null;
      evidence_refs_json: string; disposal_status: string; created_at: string; disposed_at: string | null;
    }>("SELECT * FROM runtime_plugin_effects WHERE plugin_revision_id = ? ORDER BY effect_key", currentRevisionId) : [];
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
        registrationId: row.id, key: row.registration_key, kind: row.registration_kind,
        targetRef: row.target_ref, disposerKind: row.disposer_kind, disposerRef: row.disposer_ref,
        status: row.status, createdAt: row.created_at, disposedAt: row.disposed_at,
      })),
      effects: effects.map((row) => ({
        effectId: row.id, key: row.effect_key, effectType: row.effect_type,
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
