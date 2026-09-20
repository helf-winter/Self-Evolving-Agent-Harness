import {
  validateEffectDefinition,
  type ContractCompatibility,
  type EffectDefinition,
} from "./composition.js";

export type PluginCompositionState =
  | "pending_dependency"
  | "active"
  | "suspending"
  | "replacing"
  | "needs_recovery"
  | "disposed";

export type PluginRevisionStatus = "candidate" | "active" | "replaced" | "failed" | "disposed";
export type PluginRegistrationKind = "skill" | "workflow" | "hook" | "binding" | "runtime_extension";
export type PluginDisposerKind = "unregister_callback" | "restart_required" | "manual";
export type PluginRegistrationDisposalAction = "disposed" | "retain";
export type PluginRegistrationDisposalStatus = "disposed" | "retained" | "manual_resolution";
export type PluginReplacementStatus = "previewed" | "disposing" | "activating" | "completed" | "rolled_back" | "replacement_failed";

export interface PluginContractRef {
  contractId: string;
  version: string;
}

export interface PluginRegistrationDefinition {
  key: string;
  kind: PluginRegistrationKind;
  targetRef: string;
  disposerKind: PluginDisposerKind;
  disposerRef: string;
}

export interface PluginEffectDefinition extends EffectDefinition {
  key: string;
}

export interface PluginRevisionManifest {
  revision: string;
  provides: PluginContractRef[];
  requires: PluginContractRef[];
  registrations: PluginRegistrationDefinition[];
  effects: PluginEffectDefinition[];
  metadata: Record<string, unknown>;
}

export interface PluginContractDiff {
  addedProvides: string[];
  removedProvides: string[];
  addedRequires: string[];
  removedRequires: string[];
  missingRequires: string[];
  compatibility: ContractCompatibility;
}

export function contractKey(contract: PluginContractRef): string {
  return `${contract.contractId.trim()}@${contract.version.trim()}`;
}

function validateContracts(kind: "provide" | "require", contracts: PluginContractRef[], errors: string[]): void {
  const seen = new Set<string>();
  contracts.forEach((contract, index) => {
    if (!contract.contractId.trim() || !contract.version.trim()) {
      errors.push(`${kind}.${index}.contract_invalid`);
      return;
    }
    const key = contractKey(contract);
    if (seen.has(key)) errors.push(`${kind}_duplicate.${key}`);
    seen.add(key);
  });
}

export function validatePluginManifest(manifest: PluginRevisionManifest): string[] {
  const errors: string[] = [];
  if (!manifest.revision.trim()) errors.push("revision_required");
  validateContracts("provide", manifest.provides, errors);
  validateContracts("require", manifest.requires, errors);

  const registrationKeys = new Set<string>();
  for (const registration of manifest.registrations) {
    const key = registration.key.trim();
    if (!key) errors.push("registration_key_required");
    else if (registrationKeys.has(key)) errors.push(`registration_duplicate.${key}`);
    registrationKeys.add(key);
    if (!registration.targetRef.trim()) errors.push(`registration.${key || "unknown"}.target_required`);
    if (!registration.disposerRef.trim()) errors.push(`registration.${key || "unknown"}.disposer_required`);
  }

  const effectKeys = new Set<string>();
  for (const effect of manifest.effects) {
    const key = effect.key.trim();
    if (!key) errors.push("effect_key_required");
    else if (effectKeys.has(key)) errors.push(`effect_duplicate.${key}`);
    effectKeys.add(key);
    for (const error of validateEffectDefinition(effect)) errors.push(`effect.${key || "unknown"}.${error}`);
  }
  return errors.sort();
}

function difference(left: PluginContractRef[], right: Set<string>): string[] {
  return [...new Set(left.map(contractKey))].filter((key) => !right.has(key)).sort();
}

export function comparePluginContracts(input: {
  oldProvides: PluginContractRef[];
  oldRequires: PluginContractRef[];
  candidateProvides: PluginContractRef[];
  candidateRequires: PluginContractRef[];
  availableProviderContracts: PluginContractRef[];
}): PluginContractDiff {
  const oldProvides = new Set(input.oldProvides.map(contractKey));
  const oldRequires = new Set(input.oldRequires.map(contractKey));
  const candidateProvides = new Set(input.candidateProvides.map(contractKey));
  const candidateRequires = new Set(input.candidateRequires.map(contractKey));
  const available = new Set([...input.availableProviderContracts.map(contractKey), ...candidateProvides]);
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

export function computePluginDependencyImpactClosure(input: {
  replacedPluginId: string;
  dependencyEdges: Array<{ providerPluginId: string; consumerPluginId: string }>;
}) {
  const reverse = new Map<string, Set<string>>();
  for (const edge of input.dependencyEdges) {
    const consumers = reverse.get(edge.providerPluginId) ?? new Set<string>();
    consumers.add(edge.consumerPluginId);
    reverse.set(edge.providerPluginId, consumers);
  }
  const distance = new Map<string, number>([[input.replacedPluginId, 0]]);
  const queue = [input.replacedPluginId];
  while (queue.length) {
    const provider = queue.shift()!;
    for (const consumer of [...(reverse.get(provider) ?? [])].sort()) {
      if (distance.has(consumer)) continue;
      distance.set(consumer, (distance.get(provider) ?? 0) + 1);
      queue.push(consumer);
    }
  }
  return {
    affectedPluginIds: [...distance.keys()].sort(),
    suspensionOrder: [...distance.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([pluginId]) => pluginId),
  };
}

export function decideRegistrationDisposal(input: {
  disposerDeclared: boolean;
  action: PluginRegistrationDisposalAction;
  evidenceCount: number;
}): { status: PluginRegistrationDisposalStatus; canProceed: boolean } {
  if (!input.disposerDeclared || input.evidenceCount < 1) {
    return { status: "manual_resolution", canProceed: false };
  }
  return input.action === "disposed"
    ? { status: "disposed", canProceed: true }
    : { status: "retained", canProceed: true };
}
