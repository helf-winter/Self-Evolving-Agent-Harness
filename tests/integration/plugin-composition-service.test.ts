import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginCompositionService } from "../../src/application/plugin-composition-service.js";
import type { PluginRevisionManifest } from "../../src/domain/plugin-composition.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-plugin-composition-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  return { database, service: new PluginCompositionService(database) };
}

function manifest(input: {
  revision?: string;
  provides?: Array<{ contractId: string; version: string }>;
  requires?: Array<{ contractId: string; version: string }>;
} = {}): PluginRevisionManifest {
  return {
    revision: input.revision ?? "1.0.0",
    provides: input.provides ?? [], requires: input.requires ?? [],
    registrations: [{
      key: "main", kind: "runtime_extension", targetRef: "runtime:main",
      disposerKind: "unregister_callback", disposerRef: "unregister:main",
    }],
    effects: [{
      key: "main-effect", effectType: "reversible", targetRef: "runtime:main", operation: "register",
      baselineRef: null, inverseOperation: "unregister", compensationOperation: null,
      evidenceRefs: ["binding-event:register"],
    }],
    metadata: {},
  };
}

describe("PluginCompositionService registration and reconciliation", () => {
  it("activates a waiting consumer when an exact provider appears and persists the dependency edge", async () => {
    const { database, service } = await fixture();
    const consumer = service.registerRevision({
      pluginId: "consumer", manifest: manifest({ requires: [{ contractId: "trace", version: "1" }] }),
    });
    expect(consumer).toMatchObject({ created: true, pluginId: "consumer", compositionState: "pending_dependency", missingRequirements: ["trace@1"] });
    expect(service.getPluginDetail("consumer")).toMatchObject({
      plugin: { currentRevision: "1.0.0", compositionState: "pending_dependency" },
      registrations: [expect.objectContaining({ status: "declared", disposerRef: "unregister:main" })],
      effects: [expect.objectContaining({ disposalStatus: "pending" })],
    });

    const provider = service.registerRevision({
      pluginId: "provider", manifest: manifest({ provides: [{ contractId: "trace", version: "1" }] }),
    });
    expect(provider).toMatchObject({ compositionState: "active", missingRequirements: [] });
    expect(service.getPluginDetail("consumer")).toMatchObject({
      plugin: { compositionState: "active", missingRequirements: [] },
      registrations: [expect.objectContaining({ status: "active" })],
      effects: [expect.objectContaining({ disposalStatus: "active" })],
      dependencies: [expect.objectContaining({
        providerPluginId: "provider", consumerPluginId: "consumer", contractId: "trace", contractVersion: "1", active: true,
      })],
    });
    expect(service.listPlugins({ state: "active" }).items.map((item) => item.pluginId).sort()).toEqual(["consumer", "provider"]);
    expect(service.getPluginDetail("consumer").transitions.map((item) => item.toState)).toEqual([
      "pending_dependency", "active",
    ]);
    database.close();
  });

  it("keeps exact-version mismatch pending and makes identical registration idempotent", async () => {
    const { database, service } = await fixture();
    service.registerRevision({
      pluginId: "provider", manifest: manifest({ provides: [{ contractId: "trace", version: "2" }] }),
    });
    const input = manifest({ requires: [{ contractId: "trace", version: "1" }] });
    const first = service.registerRevision({ pluginId: "consumer", manifest: input });
    expect(first).toMatchObject({ created: true, compositionState: "pending_dependency", missingRequirements: ["trace@1"] });
    expect(service.registerRevision({ pluginId: "consumer", manifest: input })).toMatchObject({
      created: false, revisionId: first.revisionId, compositionState: "pending_dependency",
    });
    expect(() => service.registerRevision({ pluginId: "consumer", manifest: manifest({ revision: "1.0.0" }) }))
      .toThrow(expect.objectContaining({ code: "plugin_composition_invalid" }));
    database.close();
  });

  it("previews and atomically activates an incompatible revision while pausing dependents", async () => {
    const { database, service } = await fixture();
    service.registerRevision({
      pluginId: "provider", manifest: manifest({ provides: [{ contractId: "trace", version: "1" }] }),
    });
    service.registerRevision({
      pluginId: "consumer", manifest: manifest({ requires: [{ contractId: "trace", version: "1" }] }),
    });
    const old = service.getPluginDetail("provider");
    const preview = service.previewReplacement({
      pluginId: "provider",
      manifest: manifest({ revision: "2.0.0", provides: [{ contractId: "trace", version: "2" }] }),
    });
    expect(preview).toMatchObject({
      status: "previewed", contractDiff: { compatibility: "incompatible", removedProvides: ["trace@1"] },
      affectedPluginIds: ["consumer", "provider"], suspensionOrder: ["consumer", "provider"],
    });
    expect(service.getPluginDetail("provider").plugin.currentRevision).toBe("1.0.0");
    const executed = service.executeReplacement({
      replacementId: preview.replacementId,
      registrationDispositions: [{
        registrationId: old.registrations[0]!.registrationId, action: "disposed",
        evidenceRefs: ["binding-event:unregister-v1"], residualImpact: "",
      }],
      effectDispositions: [{
        effectId: old.effects[0]!.effectId, action: "inverse_applied", observedBaselineRef: null,
        evidenceRefs: ["binding-event:inverse-v1"], residualImpact: "",
      }],
      activationVerdict: "succeeded", activationEvidenceRefs: ["binding-event:activate-v2"],
    });
    expect(executed).toMatchObject({ status: "completed", activated: true, blockedRegistrationIds: [], blockedEffectIds: [] });
    expect(service.getPluginDetail("provider")).toMatchObject({
      plugin: { currentRevision: "2.0.0", compositionState: "active" },
      revisions: expect.arrayContaining([
        expect.objectContaining({ revision: "1.0.0", status: "replaced" }),
        expect.objectContaining({ revision: "2.0.0", status: "active" }),
      ]),
    });
    expect(service.getPluginDetail("consumer").plugin).toMatchObject({
      compositionState: "pending_dependency", missingRequirements: ["trace@1"],
    });
    expect(service.getReplacementDetail(preview.replacementId)).toMatchObject({
      replacement: { status: "completed" },
      registrationDisposals: [expect.objectContaining({ disposalStatus: "disposed" })],
      effectDisposals: [expect.objectContaining({ disposalStatus: "disposed" })],
    });
    database.close();
  });

  it("persists baseline conflicts without partial activation and allows an evidence-backed retry", async () => {
    const { database, service } = await fixture();
    const versioned = manifest({ provides: [{ contractId: "trace", version: "1" }] });
    versioned.effects[0] = {
      ...versioned.effects[0]!, effectType: "version_reversible", baselineRef: "hash:v1",
      inverseOperation: "restore:v1",
    };
    service.registerRevision({ pluginId: "provider", manifest: versioned });
    const old = service.getPluginDetail("provider");
    const preview = service.previewReplacement({
      pluginId: "provider", manifest: manifest({ revision: "2.0.0", provides: [{ contractId: "trace", version: "1" }] }),
    });
    const registrationDispositions = [{
      registrationId: old.registrations[0]!.registrationId, action: "disposed" as const,
      evidenceRefs: ["unregister"], residualImpact: "",
    }];
    const conflict = service.executeReplacement({
      replacementId: preview.replacementId, registrationDispositions,
      effectDispositions: [{
        effectId: old.effects[0]!.effectId, action: "inverse_applied", observedBaselineRef: "hash:changed",
        evidenceRefs: ["inverse-attempt"], residualImpact: "baseline mismatch",
      }],
      activationVerdict: "succeeded", activationEvidenceRefs: ["activate-v2"],
    });
    expect(conflict).toMatchObject({ status: "disposing", activated: false, blockedEffectIds: [old.effects[0]!.effectId] });
    expect(service.getPluginDetail("provider").plugin.currentRevision).toBe("1.0.0");

    expect(service.executeReplacement({
      replacementId: preview.replacementId, registrationDispositions,
      effectDispositions: [{
        effectId: old.effects[0]!.effectId, action: "inverse_applied", observedBaselineRef: "hash:v1",
        evidenceRefs: ["inverse-success"], residualImpact: "",
      }],
      activationVerdict: "succeeded", activationEvidenceRefs: ["activate-v2"],
    })).toMatchObject({ status: "completed", activated: true });
    expect(service.getReplacementDetail(preview.replacementId).effectDisposals).toHaveLength(2);
    database.close();
  });

  it("recovers the old revision after failed candidate activation and propagates provider disposal/reactivation", async () => {
    const { database, service } = await fixture();
    service.registerRevision({
      pluginId: "provider", manifest: manifest({ provides: [{ contractId: "trace", version: "1" }] }),
    });
    service.registerRevision({
      pluginId: "consumer", manifest: manifest({ requires: [{ contractId: "trace", version: "1" }] }),
    });
    const old = service.getPluginDetail("provider");
    const preview = service.previewReplacement({
      pluginId: "provider", manifest: manifest({ revision: "2.0.0", provides: [{ contractId: "trace", version: "1" }] }),
    });
    const failed = service.executeReplacement({
      replacementId: preview.replacementId,
      registrationDispositions: [{
        registrationId: old.registrations[0]!.registrationId, action: "disposed",
        evidenceRefs: ["unregister"], residualImpact: "",
      }],
      effectDispositions: [{
        effectId: old.effects[0]!.effectId, action: "inverse_applied", observedBaselineRef: null,
        evidenceRefs: ["inverse"], residualImpact: "",
      }],
      activationVerdict: "failed", activationEvidenceRefs: ["activation-failure"],
    });
    expect(failed).toMatchObject({ status: "replacement_failed", activated: false, needsRecovery: true });
    expect(service.getPluginDetail("provider").plugin.compositionState).toBe("needs_recovery");
    expect(service.recoverReplacement({
      replacementId: preview.replacementId, recoveryVerdict: "restored", evidenceRefs: ["restore-v1"],
    })).toMatchObject({ status: "rolled_back", restored: true });
    expect(service.getPluginDetail("provider").plugin).toMatchObject({ currentRevision: "1.0.0", compositionState: "active" });

    const current = service.getPluginDetail("provider");
    expect(service.disposePlugin({
      pluginId: "provider",
      registrationDispositions: [{
        registrationId: current.registrations[0]!.registrationId, action: "disposed",
        evidenceRefs: ["unregister-provider"], residualImpact: "",
      }],
      effectDispositions: [{
        effectId: current.effects[0]!.effectId, action: "inverse_applied", observedBaselineRef: null,
        evidenceRefs: ["remove-provider-effect"], residualImpact: "",
      }],
    })).toMatchObject({ compositionState: "disposed" });
    expect(service.getPluginDetail("consumer").plugin.compositionState).toBe("pending_dependency");
    expect(service.reactivatePlugin({ pluginId: "provider", evidenceRefs: ["binding-reloaded"] })).toMatchObject({
      compositionState: "active",
    });
    expect(service.getPluginDetail("consumer").plugin.compositionState).toBe("active");
    database.close();
  });
});
