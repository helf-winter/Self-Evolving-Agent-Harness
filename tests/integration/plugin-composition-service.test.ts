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
});
