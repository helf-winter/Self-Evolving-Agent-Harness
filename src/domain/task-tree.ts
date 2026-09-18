import type { ArtifactInput } from "./artifact.js";

export type ExecutionPhase = "skeleton" | "implementation" | "verification";
export type RelationKind = "depends_on" | "calls" | "data_exchange" | "shares_contract";

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
}

export interface TaskTreeDocument {
  nodes: TaskNodeInput[];
  relations: TaskRelationInput[];
  artifacts: ArtifactInput[];
}

export interface ValidationError {
  code: "invalid_tree_structure" | "leaf_contract_invalid" | "relation_artifact_required";
  path: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
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
  document.relations.forEach((relation, index) => {
    if (!ids.has(relation.fromNodeId) || !ids.has(relation.toNodeId)) {
      errors.push({ code: "invalid_tree_structure", path: `relations[${index}]` });
    }
    if (["calls", "data_exchange", "shares_contract"].includes(relation.kind) && (!relation.artifactId || !artifacts.has(relation.artifactId))) {
      errors.push({ code: "relation_artifact_required", path: `relations[${index}].artifactId` });
    }
  });
  return { ok: errors.length === 0, errors };
}
