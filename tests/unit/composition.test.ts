import { describe, expect, it } from "vitest";
import {
  compareContractBindings,
  computeDependencyImpactClosure,
  decideEffectDisposition,
  validateEffectDefinition,
} from "../../src/domain/composition.js";

describe("Task Node composition policy", () => {
  it("classifies compatible, missing-dependency, and incompatible contract changes", () => {
    expect(compareContractBindings({
      oldProvides: ["api"], oldRequires: ["db"], candidateProvides: ["api", "events"],
      candidateRequires: ["db"], availableProviderContracts: ["db"],
    })).toMatchObject({ compatibility: "compatible", addedProvides: ["events"], removedProvides: [], missingRequires: [] });
    expect(compareContractBindings({
      oldProvides: ["api"], oldRequires: [], candidateProvides: ["api"],
      candidateRequires: ["queue"], availableProviderContracts: [],
    })).toMatchObject({ compatibility: "pending_dependency", missingRequires: ["queue"] });
    expect(compareContractBindings({
      oldProvides: ["api", "legacy"], oldRequires: [], candidateProvides: ["api"],
      candidateRequires: [], availableProviderContracts: [],
    })).toMatchObject({ compatibility: "incompatible", removedProvides: ["legacy"] });
  });

  it("computes reverse dependency closure and suspends farthest dependents first", () => {
    const result = computeDependencyImpactClosure({
      replacedNodeId: "provider",
      relations: [
        { fromNodeId: "consumer-a", toNodeId: "provider" },
        { fromNodeId: "consumer-b", toNodeId: "consumer-a" },
        { fromNodeId: "unrelated", toNodeId: "other" },
      ],
      contractConsumers: [{ providerNodeId: "provider", consumerNodeId: "contract-consumer" }],
    });
    expect(result.affectedTaskNodeIds).toEqual(["consumer-a", "consumer-b", "contract-consumer", "provider"]);
    expect(result.suspensionOrder).toEqual(["consumer-b", "consumer-a", "contract-consumer", "provider"]);
  });

  it("requires type-specific Effect ownership metadata", () => {
    expect(validateEffectDefinition({
      effectType: "version_reversible", targetRef: "artifact:file", operation: "modify",
      baselineRef: null, inverseOperation: "restore snapshot", compensationOperation: null, evidenceRefs: ["trace"],
    })).toEqual(["baseline_required"]);
    expect(validateEffectDefinition({
      effectType: "compensatable", targetRef: "external:release", operation: "publish",
      baselineRef: null, inverseOperation: null, compensationOperation: null, evidenceRefs: ["trace"],
    })).toEqual(["compensation_required"]);
    expect(validateEffectDefinition({
      effectType: "reversible", targetRef: "runtime:registration", operation: "register",
      baselineRef: null, inverseOperation: "unregister", compensationOperation: null, evidenceRefs: ["trace"],
    })).toEqual([]);
  });

  it("never treats compensation or irreversible retention as rollback", () => {
    expect(decideEffectDisposition({
      effectType: "version_reversible", action: "inverse_applied", ownershipMatches: true,
      baselineMatches: false, hasSharedActiveOwner: false, evidenceCount: 1,
    })).toEqual({ capability: "requires_baseline_check", status: "conflict", canProceed: false });
    expect(decideEffectDisposition({
      effectType: "compensatable", action: "compensation_applied", ownershipMatches: true,
      baselineMatches: true, hasSharedActiveOwner: false, evidenceCount: 1,
    })).toEqual({ capability: "compensation_only", status: "compensated", canProceed: true });
    expect(decideEffectDisposition({
      effectType: "irreversible", action: "retain", ownershipMatches: true,
      baselineMatches: true, hasSharedActiveOwner: false, evidenceCount: 1,
    })).toEqual({ capability: "manual_confirmation_required", status: "not_disposable", canProceed: true });
  });
});
