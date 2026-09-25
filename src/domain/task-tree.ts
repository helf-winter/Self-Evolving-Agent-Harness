import type { ArtifactInput } from "./artifact.js";
import { normalizeArtifactInput, type ArtifactContractInput, type ArtifactRelationInput, type TaskArtifactLinkInput } from "./artifact-graph.js";

export type ExecutionPhase = "skeleton" | "implementation" | "verification";
export type CanonicalRelationKind = "depends_on" | "calls" | "exchanges_data_with" | "shares_artifact_with" | "coordinates_with";
export type LegacyRelationKind = "data_exchange" | "shares_contract";
export type RelationKind = CanonicalRelationKind | LegacyRelationKind;
export type DependencyKind = "execution_order" | "contract_ready" | "test_fixture_ready" | "environment_ready";
export type CoordinationKind = "schedule_only" | "review_sync" | "shared_decision" | "integration_check";

export interface RequiredEvidence {
  key: string;
  description: string;
}

export interface TaskNodeInput {
  id: string;
  parentId: string | null;
  title: string;
  children: string[];
  objectives?: string[];
  expectedOutputs?: string[];
  acceptanceCriteria?: string[];
  unresolvedQuestions?: string[];
  unresolvedDecisions?: string[];
  dependencies?: string[];
  requiredEvidence?: RequiredEvidence[];
  executionPhase?: ExecutionPhase;
  stopDecompositionReason?: string;
}

export interface TaskRelationInput {
  fromNodeId: string;
  toNodeId: string;
  kind: RelationKind;
  artifactId?: string;
  dependencyKind?: DependencyKind;
  coordinationKind?: CoordinationKind;
  description?: string;
}

export interface PlannedEffectInput {
  id: string;
  riskLevel: "low" | "medium" | "high" | "irreversible";
  targetRef: string;
  summary: string;
  mitigation: string | null;
}

export interface TaskPlanningContext {
  goal: string;
  scopeBoundaries: string[];
  exclusions: string[];
  unresolvedQuestions: string[];
  unresolvedDecisions: string[];
  plannedEffects: PlannedEffectInput[];
}

export interface SkeletonAcceptanceInput {
  id: string;
  branchNodeId: string;
  expectedArtifacts: string[];
  requiredContracts: string[];
  verificationCommands: string[];
  readinessConditions: string[];
}

export interface TaskTreeDocument {
  planningVersion?: 1;
  planningContext?: TaskPlanningContext;
  nodes: TaskNodeInput[];
  relations: TaskRelationInput[];
  artifacts: ArtifactInput[];
  skeletonCriteria?: SkeletonAcceptanceInput[];
  artifactLinks?: TaskArtifactLinkInput[];
  artifactRelations?: ArtifactRelationInput[];
  artifactContracts?: ArtifactContractInput[];
}

export interface ValidationError {
  code: "invalid_tree_structure" | "leaf_contract_invalid" | "relation_artifact_required" | "artifact_reference_invalid" | "artifact_contract_invalid";
  path: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

export function normalizeRelationKind(kind: RelationKind): CanonicalRelationKind {
  if (kind === "data_exchange") return "exchanges_data_with";
  if (kind === "shares_contract") return "shares_artifact_with";
  return kind;
}

export function normalizeTaskTreeDocument(document: TaskTreeDocument): TaskTreeDocument {
  return {
    ...document,
    relations: document.relations.map((relation) => ({ ...relation, kind: normalizeRelationKind(relation.kind) })),
  };
}

function validateLeaf(node: TaskNodeInput): ValidationError[] {
  const evidenceKeys = new Set<string>();
  const evidenceInvalid =
    !node.requiredEvidence?.length ||
    node.requiredEvidence.some((evidence) => {
      const key = evidence.key.trim();
      const invalid = !key || !evidence.description.trim() || evidenceKeys.has(key);
      evidenceKeys.add(key);
      return invalid;
    });
  const missing =
    node.objectives?.length !== 1 ||
    !node.expectedOutputs?.length ||
    !node.acceptanceCriteria?.length ||
    (node.unresolvedQuestions?.length ?? 0) !== 0 ||
    (node.unresolvedDecisions?.length ?? 0) !== 0 ||
    evidenceInvalid ||
    !node.executionPhase ||
    !node.stopDecompositionReason?.trim();
  return missing ? [{ code: "leaf_contract_invalid", path: `nodes.${node.id}` }] : [];
}

export function validateTaskTree(document: TaskTreeDocument): ValidationResult {
  const errors: ValidationError[] = [];
  const ids = new Set(document.nodes.map((node) => node.id));
  const roots = document.nodes.filter((node) => node.parentId === null);
  if (roots.length !== 1 || ids.size !== document.nodes.length) {
    errors.push({ code: "invalid_tree_structure", path: "nodes" });
  }

  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  for (const node of document.nodes) {
    if (node.parentId !== null && !ids.has(node.parentId)) errors.push({ code: "invalid_tree_structure", path: `nodes.${node.id}.parentId` });
    if (node.children.some((child) => !ids.has(child) || byId.get(child)?.parentId !== node.id)) {
      errors.push({ code: "invalid_tree_structure", path: `nodes.${node.id}.children` });
    }
    for (const dependency of node.dependencies ?? []) {
      if (!ids.has(dependency)) errors.push({ code: "invalid_tree_structure", path: `nodes.${node.id}.dependencies` });
    }
    if (node.children.length === 0) errors.push(...validateLeaf(node));
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cyclic = (byId.get(id)?.children ?? []).some(visit);
    visiting.delete(id);
    visited.add(id);
    return cyclic;
  };
  if (document.nodes.some((node) => visit(node.id))) errors.push({ code: "invalid_tree_structure", path: "nodes" });

  const artifacts = new Set(document.artifacts.map((artifact) => artifact.id));
  if (artifacts.size !== document.artifacts.length) errors.push({ code: "artifact_reference_invalid", path: "artifacts" });
  document.artifacts.forEach((artifact, index) => {
    if (artifact.parentArtifactId && !artifacts.has(artifact.parentArtifactId)) {
      errors.push({ code: "artifact_reference_invalid", path: `artifacts[${index}].parentArtifactId` });
    }
  });
  (document.artifactLinks ?? []).forEach((link, index) => {
    if (!ids.has(link.taskNodeId) || !artifacts.has(link.artifactId)) {
      errors.push({ code: "artifact_reference_invalid", path: `artifactLinks[${index}]` });
    }
  });
  (document.artifactRelations ?? []).forEach((relation, index) => {
    if (!artifacts.has(relation.fromArtifactId) || !artifacts.has(relation.toArtifactId)) {
      errors.push({ code: "artifact_reference_invalid", path: `artifactRelations[${index}]` });
    }
  });
  const contractIds = new Set<string>();
  (document.artifactContracts ?? []).forEach((contract, index) => {
    const carrier = document.artifacts.find((artifact) => artifact.id === contract.artifactId);
    const invalid = contractIds.has(contract.id) || !carrier || normalizeArtifactInput(carrier).granularity !== "contract" ||
      !contract.name.trim() || !contract.version.trim() || !contract.schemaOrSignature.trim() ||
      !contract.providerNodeIds.length || !contract.consumerNodeIds.length || !contract.validationRefs.length ||
      contract.providerNodeIds.some((nodeId) => !ids.has(nodeId)) || contract.consumerNodeIds.some((nodeId) => !ids.has(nodeId));
    contractIds.add(contract.id);
    if (invalid) errors.push({ code: "artifact_contract_invalid", path: `artifactContracts[${index}]` });
  });
  const artifactLinks = new Set((document.artifactLinks ?? []).map((link) => `${link.taskNodeId}\u0000${link.artifactId}`));
  document.relations.forEach((relation, index) => {
    const kind = normalizeRelationKind(relation.kind);
    if (!ids.has(relation.fromNodeId) || !ids.has(relation.toNodeId)) {
      errors.push({ code: "invalid_tree_structure", path: `relations[${index}]` });
    }
    const conditionallyRequiresArtifact =
      (kind === "depends_on" && relation.dependencyKind !== "execution_order") ||
      (kind === "coordinates_with" && relation.coordinationKind !== "schedule_only");
    const requiresArtifact = ["calls", "exchanges_data_with", "shares_artifact_with"].includes(kind) || conditionallyRequiresArtifact;
    const sharedArtifactMissingSide = kind === "shares_artifact_with" && Boolean(relation.artifactId) &&
      (!artifactLinks.has(`${relation.fromNodeId}\u0000${relation.artifactId}`) ||
       !artifactLinks.has(`${relation.toNodeId}\u0000${relation.artifactId}`));
    if ((requiresArtifact && (!relation.artifactId || !artifacts.has(relation.artifactId))) || sharedArtifactMissingSide) {
      errors.push({ code: "relation_artifact_required", path: `relations[${index}].artifactId` });
    }
  });
  return { ok: errors.length === 0, errors };
}
