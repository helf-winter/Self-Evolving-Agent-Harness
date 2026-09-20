export type CompositionState =
  | "pending_dependency"
  | "active"
  | "suspending"
  | "replacing"
  | "needs_replanning"
  | "disposed";

export type TaskNodeEffectType = "reversible" | "version_reversible" | "compensatable" | "irreversible";
export type EffectDisposalCapability =
  | "auto_reversible"
  | "requires_baseline_check"
  | "compensation_only"
  | "manual_confirmation_required";
export type EffectDisposalStatus =
  | "active"
  | "disposed"
  | "compensated"
  | "conflict"
  | "manual_resolution"
  | "not_disposable";
export type EffectDispositionAction = "inverse_applied" | "compensation_applied" | "retain";
export type ReplacementStatus =
  | "pending_confirmation"
  | "suspending"
  | "disposing"
  | "activating"
  | "completed"
  | "rolled_back"
  | "replacement_failed";
export type ContractCompatibility = "compatible" | "pending_dependency" | "incompatible";

export interface ContractDiff {
  addedProvides: string[];
  removedProvides: string[];
  addedRequires: string[];
  removedRequires: string[];
  missingRequires: string[];
  compatibility: ContractCompatibility;
}

function difference(left: string[], right: Set<string>): string[] {
  return [...new Set(left)].filter((item) => !right.has(item)).sort();
}

export function compareContractBindings(input: {
  oldProvides: string[];
  oldRequires: string[];
  candidateProvides: string[];
  candidateRequires: string[];
  availableProviderContracts: string[];
}): ContractDiff {
  const oldProvides = new Set(input.oldProvides);
  const oldRequires = new Set(input.oldRequires);
  const candidateProvides = new Set(input.candidateProvides);
  const candidateRequires = new Set(input.candidateRequires);
  const available = new Set([...input.availableProviderContracts, ...candidateProvides]);
  const removedProvides = difference(input.oldProvides, candidateProvides);
  const missingRequires = difference(input.candidateRequires, available);
  return {
    addedProvides: difference(input.candidateProvides, oldProvides),
    removedProvides,
    addedRequires: difference(input.candidateRequires, oldRequires),
    removedRequires: difference(input.oldRequires, candidateRequires),
    missingRequires,
    compatibility: removedProvides.length > 0
      ? "incompatible"
      : missingRequires.length > 0 ? "pending_dependency" : "compatible",
  };
}

export function computeDependencyImpactClosure(input: {
  replacedNodeId: string;
  relations: Array<{ fromNodeId: string; toNodeId: string }>;
  contractConsumers: Array<{ providerNodeId: string; consumerNodeId: string }>;
}) {
  const reverse = new Map<string, Set<string>>();
  const add = (provider: string, consumer: string) => {
    const consumers = reverse.get(provider) ?? new Set<string>();
    consumers.add(consumer);
    reverse.set(provider, consumers);
  };
  for (const relation of input.relations) add(relation.toNodeId, relation.fromNodeId);
  for (const relation of input.contractConsumers) add(relation.providerNodeId, relation.consumerNodeId);
  const distance = new Map<string, number>([[input.replacedNodeId, 0]]);
  const queue = [input.replacedNodeId];
  while (queue.length) {
    const provider = queue.shift()!;
    for (const consumer of [...(reverse.get(provider) ?? [])].sort()) {
      if (distance.has(consumer)) continue;
      distance.set(consumer, (distance.get(provider) ?? 0) + 1);
      queue.push(consumer);
    }
  }
  const affectedTaskNodeIds = [...distance.keys()].sort();
  const suspensionOrder = [...distance.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([nodeId]) => nodeId);
  return { affectedTaskNodeIds, suspensionOrder };
}

export interface EffectDefinition {
  effectType: TaskNodeEffectType;
  targetRef: string;
  operation: string;
  baselineRef: string | null;
  inverseOperation: string | null;
  compensationOperation: string | null;
  evidenceRefs: string[];
}

export function validateEffectDefinition(input: EffectDefinition): string[] {
  const errors: string[] = [];
  if (!input.targetRef.trim()) errors.push("target_required");
  if (!input.operation.trim()) errors.push("operation_required");
  if (!input.evidenceRefs.length) errors.push("evidence_required");
  if ((input.effectType === "reversible" || input.effectType === "version_reversible") && !input.inverseOperation?.trim()) {
    errors.push("inverse_required");
  }
  if (input.effectType === "version_reversible" && !input.baselineRef?.trim()) errors.push("baseline_required");
  if (input.effectType === "compensatable" && !input.compensationOperation?.trim()) errors.push("compensation_required");
  return errors.sort();
}

export function disposalCapability(effectType: TaskNodeEffectType): EffectDisposalCapability {
  if (effectType === "reversible") return "auto_reversible";
  if (effectType === "version_reversible") return "requires_baseline_check";
  if (effectType === "compensatable") return "compensation_only";
  return "manual_confirmation_required";
}

export function decideEffectDisposition(input: {
  effectType: TaskNodeEffectType;
  action: EffectDispositionAction;
  ownershipMatches: boolean;
  baselineMatches: boolean;
  hasSharedActiveOwner: boolean;
  evidenceCount: number;
}): { capability: EffectDisposalCapability; status: EffectDisposalStatus; canProceed: boolean } {
  const capability = disposalCapability(input.effectType);
  if (!input.ownershipMatches || input.evidenceCount < 1) {
    return { capability, status: "manual_resolution", canProceed: false };
  }
  if (input.effectType === "irreversible") {
    return input.action === "retain"
      ? { capability, status: "not_disposable", canProceed: true }
      : { capability, status: "manual_resolution", canProceed: false };
  }
  if (input.effectType === "compensatable") {
    return input.action === "compensation_applied"
      ? { capability, status: "compensated", canProceed: true }
      : { capability, status: "manual_resolution", canProceed: false };
  }
  if (input.effectType === "version_reversible" && (!input.baselineMatches || input.hasSharedActiveOwner)) {
    return { capability, status: "conflict", canProceed: false };
  }
  return input.action === "inverse_applied"
    ? { capability, status: "disposed", canProceed: true }
    : { capability, status: "manual_resolution", canProceed: false };
}
