import { describe, expect, it } from "vitest";
import {
  comparePluginContracts,
  computePluginDependencyImpactClosure,
  contractKey,
  decideRegistrationDisposal,
  validatePluginManifest,
  type PluginRevisionManifest,
} from "../../src/domain/plugin-composition.js";

const manifest = (overrides: Partial<PluginRevisionManifest> = {}): PluginRevisionManifest => ({
  revision: "1.0.0",
  provides: [{ contractId: "task-tree", version: "1" }],
  requires: [{ contractId: "trace", version: "1" }],
  registrations: [{
    key: "planning-skill", kind: "skill", targetRef: "skill:task-tree-planning",
    disposerKind: "unregister_callback", disposerRef: "remove:planning-skill",
  }],
  effects: [{
    key: "skill-registration", effectType: "reversible", targetRef: "skill:task-tree-planning",
    operation: "register planning skill", baselineRef: null, inverseOperation: "unregister planning skill",
    compensationOperation: null, evidenceRefs: ["binding-event:1"],
  }],
  metadata: { runtime: "claude" },
  ...overrides,
});

describe("Plugin Composition domain", () => {
  it("validates a framework-neutral immutable manifest", () => {
    expect(validatePluginManifest(manifest())).toEqual([]);
    expect(validatePluginManifest(manifest({
      revision: " ",
      provides: [{ contractId: "trace", version: "1" }, { contractId: "trace", version: "1" }],
      requires: [{ contractId: "", version: "1" }],
      registrations: [{
        key: "hook", kind: "hook", targetRef: "hook:tool", disposerKind: "unregister_callback", disposerRef: "",
      }],
      effects: [{
        key: "effect", effectType: "version_reversible", targetRef: "file:x", operation: "write",
        baselineRef: null, inverseOperation: null, compensationOperation: null, evidenceRefs: [],
      }],
    }))).toEqual([
      "effect.effect.baseline_required", "effect.effect.evidence_required", "effect.effect.inverse_required",
      "provide_duplicate.trace@1", "registration.hook.disposer_required", "require.0.contract_invalid",
      "revision_required",
    ]);
  });

  it("compares exact versioned contracts", () => {
    expect(contractKey({ contractId: "trace", version: "1" })).toBe("trace@1");
    expect(comparePluginContracts({
      oldProvides: [{ contractId: "trace", version: "1" }], oldRequires: [],
      candidateProvides: [{ contractId: "trace", version: "2" }],
      candidateRequires: [{ contractId: "storage", version: "1" }],
      availableProviderContracts: [{ contractId: "storage", version: "2" }],
    })).toEqual({
      addedProvides: ["trace@2"], removedProvides: ["trace@1"],
      addedRequires: ["storage@1"], removedRequires: [], missingRequires: ["storage@1"],
      compatibility: "incompatible",
    });
  });

  it("computes deterministic reverse dependency impact and suspension order", () => {
    expect(computePluginDependencyImpactClosure({
      replacedPluginId: "provider",
      dependencyEdges: [
        { providerPluginId: "provider", consumerPluginId: "consumer-a" },
        { providerPluginId: "consumer-a", consumerPluginId: "consumer-b" },
        { providerPluginId: "provider", consumerPluginId: "consumer-c" },
      ],
    })).toEqual({
      affectedPluginIds: ["consumer-a", "consumer-b", "consumer-c", "provider"],
      suspensionOrder: ["consumer-b", "consumer-a", "consumer-c", "provider"],
    });
  });

  it("requires a declared disposer and evidence instead of executing disposer text", () => {
    expect(decideRegistrationDisposal({ disposerDeclared: true, action: "disposed", evidenceCount: 1 }))
      .toEqual({ status: "disposed", canProceed: true });
    expect(decideRegistrationDisposal({ disposerDeclared: true, action: "disposed", evidenceCount: 0 }))
      .toEqual({ status: "manual_resolution", canProceed: false });
    expect(decideRegistrationDisposal({ disposerDeclared: false, action: "disposed", evidenceCount: 1 }))
      .toEqual({ status: "manual_resolution", canProceed: false });
    expect(decideRegistrationDisposal({ disposerDeclared: true, action: "retain", evidenceCount: 1 }))
      .toEqual({ status: "retained", canProceed: true });
  });
});
