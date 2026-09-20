import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";
import type { PluginRevisionManifest } from "../../src/domain/plugin-composition.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function manifest(revision: string, input: {
  provides?: Array<{ contractId: string; version: string }>;
  requires?: Array<{ contractId: string; version: string }>;
}): PluginRevisionManifest {
  return {
    revision, provides: input.provides ?? [], requires: input.requires ?? [],
    registrations: [{
      key: "runtime", kind: "runtime_extension", targetRef: "runtime:feature",
      disposerKind: "unregister_callback", disposerRef: "binding:unregister-feature",
    }],
    effects: [{
      key: "runtime-registration", effectType: "reversible", targetRef: "runtime:feature",
      operation: "register feature", baselineRef: null, inverseOperation: "unregister feature",
      compensationOperation: null, evidenceRefs: ["binding:register-feature"],
    }],
    metadata: { frameworkNeutral: true },
  };
}

describe("Plugin Composition vertical slice", () => {
  it("persists dependency activation, replacement, disposal evidence, and transitions across restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-plugin-e2e-"));
    dirs.push(directory);
    const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") };

    const first = openRuntime(environment);
    first.plugins.registerRevision({
      pluginId: "consumer", manifest: manifest("1.0.0", { requires: [{ contractId: "trace", version: "1" }] }),
    });
    first.plugins.registerRevision({
      pluginId: "provider", manifest: manifest("1.0.0", { provides: [{ contractId: "trace", version: "1" }] }),
    });
    const old = first.plugins.getPluginDetail("provider");
    const preview = first.plugins.previewReplacement({
      pluginId: "provider", manifest: manifest("2.0.0", { provides: [{ contractId: "trace", version: "1" }] }),
    });
    const executed = first.plugins.executeReplacement({
      replacementId: preview.replacementId,
      registrationDispositions: [{
        registrationId: old.registrations[0]!.registrationId, action: "disposed",
        evidenceRefs: ["binding:unregistered-v1"], residualImpact: "",
      }],
      effectDispositions: [{
        effectId: old.effects[0]!.effectId, action: "inverse_applied", observedBaselineRef: null,
        evidenceRefs: ["binding:inverse-v1"], residualImpact: "",
      }],
      activationVerdict: "succeeded", activationEvidenceRefs: ["binding:activated-v2"],
    });
    expect(executed).toMatchObject({ status: "completed", activated: true });
    expect(first.plugins.getPluginDetail("consumer").plugin.compositionState).toBe("active");
    first.close();

    const reopened = openRuntime(environment);
    try {
      expect(reopened.plugins.getPluginDetail("provider")).toMatchObject({
        plugin: { currentRevision: "2.0.0", compositionState: "active" },
        revisions: expect.arrayContaining([
          expect.objectContaining({ revision: "1.0.0", status: "replaced" }),
          expect.objectContaining({ revision: "2.0.0", status: "active" }),
        ]),
        transitions: expect.arrayContaining([
          expect.objectContaining({ toState: "replacing" }),
          expect.objectContaining({ toState: "active" }),
        ]),
      });
      expect(reopened.plugins.getReplacementDetail(preview.replacementId)).toMatchObject({
        replacement: { status: "completed", activationEvidenceRefs: ["binding:activated-v2"] },
        registrationDisposals: [expect.objectContaining({ evidenceRefs: ["binding:unregistered-v1"] })],
        effectDisposals: [expect.objectContaining({ evidenceRefs: ["binding:inverse-v1"] })],
      });
      expect(reopened.plugins.getPluginDetail("consumer").dependencies).toEqual([
        expect.objectContaining({ providerPluginId: "provider", contractId: "trace", contractVersion: "1", active: true }),
      ]);
    } finally {
      reopened.close();
    }
  });
});
