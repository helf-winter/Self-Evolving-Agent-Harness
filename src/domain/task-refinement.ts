import { createHash } from "node:crypto";
import { canonicalJson } from "./trace.js";
import {
  normalizeRelationKind,
  validateTaskTree,
  type SkeletonAcceptanceInput,
  type TaskTreeDocument,
  type ValidationError,
} from "./task-tree.js";

export type ReadinessIssueCategory =
  | "root_scope"
  | "architecture"
  | "cross_branch_contract"
  | "high_risk_effect"
  | "branch_dependency"
  | "acceptance_skeleton"
  | "local_detail";

export interface ReadinessIssue {
  issueId: string;
  code: string;
  category: ReadinessIssueCategory;
  severity: "blocking" | "warning";
  summary: string;
  affectedRefs: string[];
  priorityScore: number;
  priorityReasons: string[];
}

export interface DraftImpact {
  hasStructuralChange: boolean;
  impactLevel: "local" | "cross_branch";
  applyMode: "direct_draft_apply" | "preview_required";
  affectedNodeIds: string[];
  affectedBranchIds: string[];
  affectedArtifactIds: string[];
  affectedRelationRefs: string[];
  affectedContractIds: string[];
  proposedDocumentHash: string;
}

const weights: Record<ReadinessIssueCategory, number> = {
  root_scope: 700,
  architecture: 600,
  cross_branch_contract: 500,
  high_risk_effect: 400,
  branch_dependency: 300,
  acceptance_skeleton: 200,
  local_detail: 100,
};

function issue(input: Omit<ReadinessIssue, "issueId" | "priorityScore" | "priorityReasons"> & {
  crossBranch?: boolean;
  blockingCount?: number;
  riskBoost?: number;
}): ReadinessIssue {
  const affectedRefs = [...new Set(input.affectedRefs)].sort();
  const impactBoost = affectedRefs.length * 10;
  const crossBranchBoost = input.crossBranch ? 50 : 0;
  const blockingBoost = (input.blockingCount ?? 1) * 5;
  const riskBoost = input.riskBoost ?? 0;
  const priorityScore = weights[input.category] + impactBoost + crossBranchBoost + blockingBoost + riskBoost;
  return {
    issueId: createHash("sha256").update(canonicalJson({
      code: input.code, category: input.category, affectedRefs, summary: input.summary,
    })).digest("hex").slice(0, 24),
    code: input.code, category: input.category, severity: input.severity,
    summary: input.summary, affectedRefs, priorityScore,
    priorityReasons: [
      "category:" + input.category, "category_weight:" + weights[input.category],
      "affected_refs:" + affectedRefs.length, "cross_branch:" + Boolean(input.crossBranch),
      "blocking_count:" + (input.blockingCount ?? 1), "risk_boost:" + riskBoost,
    ],
  };
}

export function validateDraftStructure(document: TaskTreeDocument): ValidationError[] {
  const errors = validateTaskTree(document).errors.filter((error) =>
    error.code === "invalid_tree_structure" || error.code === "artifact_reference_invalid");
  const nodeIds = new Set(document.nodes.map((node) => node.id));
  const artifactIds = new Set(document.artifacts.map((artifact) => artifact.id));
  document.relations.forEach((relation, index) => {
    if (relation.artifactId && !artifactIds.has(relation.artifactId)) {
      errors.push({ code: "artifact_reference_invalid", path: `relations[${index}].artifactId` });
    }
  });
  (document.artifactContracts ?? []).forEach((contract, index) => {
    if (!artifactIds.has(contract.artifactId)
      || contract.providerNodeIds.some((id) => !nodeIds.has(id))
      || contract.consumerNodeIds.some((id) => !nodeIds.has(id))) {
      errors.push({ code: "artifact_reference_invalid", path: `artifactContracts[${index}]` });
    }
  });
  (document.skeletonCriteria ?? []).forEach((criterion, index) => {
    if (!nodeIds.has(criterion.branchNodeId)) {
      errors.push({ code: "invalid_tree_structure", path: `skeletonCriteria[${index}].branchNodeId` });
    }
  });
  return [...new Map(errors.map((error) => [`${error.code}:${error.path}`, error])).values()];
}

function scopeNodeIds(document: TaskTreeDocument, scopeRootNodeId?: string): Set<string> | null {
  if (!scopeRootNodeId) return new Set(document.nodes.map((node) => node.id));
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  if (!byId.has(scopeRootNodeId)) return null;
  const result = new Set<string>();
  const visit = (id: string) => {
    if (result.has(id)) return;
    result.add(id);
    for (const child of byId.get(id)?.children ?? []) visit(child);
  };
  visit(scopeRootNodeId);
  return result;
}

function topBranchForNode(document: TaskTreeDocument, nodeId: string): string | null {
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const root = document.nodes.find((node) => node.parentId === null);
  let current = byId.get(nodeId);
  if (!current || !root) return null;
  if (current.id === root.id) return root.id;
  while (current.parentId && current.parentId !== root.id) {
    const parent = byId.get(current.parentId);
    if (!parent) return null;
    current = parent;
  }
  return current.parentId === root.id ? current.id : null;
}

function skeletonComplete(value: SkeletonAcceptanceInput | undefined): boolean {
  return Boolean(value
    && value.expectedArtifacts.length
    && value.requiredContracts.length
    && value.verificationCommands.length
    && value.readinessConditions.length);
}

function legacyReadiness(document: TaskTreeDocument, scope: Set<string>) {
  const validation = validateTaskTree(document);
  const blockers = validation.errors.flatMap((error) => {
    if (error.path.startsWith("nodes.")) {
      const nodeId = error.path.slice("nodes.".length).split(".")[0]!;
      if (!scope.has(nodeId)) return [];
    }
    return [issue({
      code: error.code, category: error.code === "leaf_contract_invalid" ? "acceptance_skeleton" : "branch_dependency",
      severity: "blocking", summary: "Resolve " + error.code + " at " + error.path, affectedRefs: [error.path],
    })];
  });
  return blockers;
}

export function analyzePlanReadiness(document: TaskTreeDocument, scopeRootNodeId?: string) {
  const scope = scopeNodeIds(document, scopeRootNodeId);
  if (!scope) return {
    ready: false,
    blockingIssues: [issue({
      code: "scope_not_found", category: "branch_dependency", severity: "blocking",
      summary: "The requested refinement scope does not exist", affectedRefs: [scopeRootNodeId ?? ""],
    })],
    warnings: [] as ReadinessIssue[],
    recommendedNextIssue: null as ReadinessIssue | null,
  };

  const blockingIssues: ReadinessIssue[] = [];
  const warnings: ReadinessIssue[] = [];
  if (document.planningVersion !== 1) {
    blockingIssues.push(...legacyReadiness(document, scope));
  } else {
    const structural = validateDraftStructure(document);
    for (const error of structural) blockingIssues.push(issue({
      code: error.code, category: "branch_dependency", severity: "blocking",
      summary: "Repair invalid draft structure at " + error.path, affectedRefs: [error.path],
    }));
    const context = document.planningContext;
    if (!context?.goal.trim() || !context.scopeBoundaries.length || !context.exclusions.length) {
      blockingIssues.push(issue({
        code: "planning_context_incomplete", category: "root_scope", severity: "blocking",
        summary: "Clarify the root goal, scope boundaries, and explicit exclusions", affectedRefs: ["planningContext"],
        crossBranch: true,
      }));
    }
    if (context && (context.unresolvedQuestions.length || context.unresolvedDecisions.length)) {
      blockingIssues.push(issue({
        code: "root_decision_unresolved", category: "architecture", severity: "blocking",
        summary: "Resolve the highest-impact root planning question or decision",
        affectedRefs: ["planningContext", ...context.unresolvedQuestions, ...context.unresolvedDecisions],
        crossBranch: true, blockingCount: context.unresolvedQuestions.length + context.unresolvedDecisions.length,
      }));
    }
    for (const effect of context?.plannedEffects ?? []) {
      if ((effect.riskLevel === "high" || effect.riskLevel === "irreversible") && !effect.mitigation?.trim()) {
        blockingIssues.push(issue({
          code: "high_risk_effect_unresolved", category: "high_risk_effect", severity: "blocking",
          summary: "Define mitigation and confirmation handling for " + effect.summary,
          affectedRefs: [effect.id, effect.targetRef], riskBoost: effect.riskLevel === "irreversible" ? 40 : 20,
        }));
      }
    }

    const byId = new Map(document.nodes.map((node) => [node.id, node]));
    const validation = validateTaskTree(document);
    for (const nodeId of [...scope].sort()) {
      const node = byId.get(nodeId)!;
      if (node.children.length) continue;
      const leafErrors = validation.errors
        .some((error) => error.code === "leaf_contract_invalid" && error.path === "nodes." + node.id);
      if (leafErrors) {
        blockingIssues.push(issue({
          code: "leaf_contract_incomplete", category: "acceptance_skeleton", severity: "blocking",
          summary: "Complete the Leaf Task Contract for " + node.title, affectedRefs: [node.id],
        }));
      }
      const objective = node.objectives?.[0] ?? "";
      if (/\b(and|plus)\b|并且|以及|同时/i.test(objective)) {
        warnings.push(issue({
          code: "semantic_cohesion_warning", category: "local_detail", severity: "warning",
          summary: "Review whether " + node.title + " contains multiple independent goals", affectedRefs: [node.id],
        }));
      }
    }

    const artifactIds = new Set(document.artifacts.map((artifact) => artifact.id));
    document.relations.forEach((relation, index) => {
      if (!scope.has(relation.fromNodeId) && !scope.has(relation.toNodeId)) return;
      const kind = normalizeRelationKind(relation.kind);
      const requiresArtifact = ["calls", "exchanges_data_with", "shares_artifact_with"].includes(kind)
        || (kind === "depends_on" && relation.dependencyKind !== undefined && relation.dependencyKind !== "execution_order")
        || (kind === "coordinates_with" && relation.coordinationKind !== "schedule_only");
      if (requiresArtifact
        && (!relation.artifactId || !artifactIds.has(relation.artifactId))) {
        blockingIssues.push(issue({
          code: "relation_contract_missing", category: "cross_branch_contract", severity: "blocking",
          summary: "Bind " + relation.kind + " relation to an Artifact Contract",
          affectedRefs: [relation.fromNodeId, relation.toNodeId, "relations[" + index + "]"],
          crossBranch: topBranchForNode(document, relation.fromNodeId) !== topBranchForNode(document, relation.toNodeId),
        }));
      }
    });
    (document.artifactContracts ?? []).forEach((contract, index) => {
      const affectedNodes = [...contract.providerNodeIds, ...contract.consumerNodeIds];
      if (!affectedNodes.some((nodeId) => scope.has(nodeId))) return;
      if (validation.errors.some((error) => error.code === "artifact_contract_invalid" && error.path === `artifactContracts[${index}]`)) {
        blockingIssues.push(issue({
          code: "artifact_contract_incomplete", category: "cross_branch_contract", severity: "blocking",
          summary: "Complete Artifact Contract " + (contract.name || contract.id),
          affectedRefs: [contract.id, contract.artifactId, ...affectedNodes],
          crossBranch: new Set(affectedNodes.map((nodeId) => topBranchForNode(document, nodeId))).size > 1,
        }));
      }
    });

    const root = document.nodes.find((node) => node.parentId === null);
    const topBranches = root?.children ?? [];
    const scopedBranches = new Set([...scope].map((nodeId) => topBranchForNode(document, nodeId)).filter((value): value is string => Boolean(value)));
    for (const branchId of topBranches.filter((id) => scopedBranches.has(id))) {
      const criterion = document.skeletonCriteria?.find((item) => item.branchNodeId === branchId);
      if (!skeletonComplete(criterion)) {
        blockingIssues.push(issue({
          code: "skeleton_criteria_incomplete", category: "acceptance_skeleton", severity: "blocking",
          summary: "Complete Skeleton Acceptance Criteria for " + (byId.get(branchId)?.title ?? branchId),
          affectedRefs: [branchId, criterion?.id ?? "missing-skeleton-criteria"],
        }));
      }
    }
  }

  const sorter = (left: ReadinessIssue, right: ReadinessIssue) =>
    right.priorityScore - left.priorityScore
    || left.code.localeCompare(right.code)
    || left.affectedRefs.join("|").localeCompare(right.affectedRefs.join("|"));
  blockingIssues.sort(sorter);
  warnings.sort(sorter);
  return {
    ready: blockingIssues.length === 0,
    blockingIssues,
    warnings,
    recommendedNextIssue: blockingIssues[0] ?? null,
  };
}

function mapById<T extends { id: string }>(values: T[] | undefined): Map<string, T> {
  return new Map((values ?? []).map((value) => [value.id, value]));
}

function changedIds<T extends { id: string }>(left: T[] | undefined, right: T[] | undefined): string[] {
  const leftMap = mapById(left);
  const rightMap = mapById(right);
  return [...new Set([...leftMap.keys(), ...rightMap.keys()])]
    .filter((id) => canonicalJson(leftMap.get(id) ?? null) !== canonicalJson(rightMap.get(id) ?? null))
    .sort();
}

function relationKey(relation: TaskTreeDocument["relations"][number]): string {
  return relation.fromNodeId + ":" + relation.kind + ":" + relation.toNodeId + ":" + (relation.artifactId ?? "");
}

export function analyzeDraftImpact(base: TaskTreeDocument, candidate: TaskTreeDocument): DraftImpact {
  const affectedNodeIds = changedIds(base.nodes, candidate.nodes);
  const affectedArtifactIds = changedIds(base.artifacts, candidate.artifacts);
  const baseRelations = new Map(base.relations.map((relation) => [relationKey(relation), relation]));
  const candidateRelations = new Map(candidate.relations.map((relation) => [relationKey(relation), relation]));
  const affectedRelationRefs = [...new Set([...baseRelations.keys(), ...candidateRelations.keys()])]
    .filter((key) => !baseRelations.has(key) || !candidateRelations.has(key)).sort();
  for (const key of affectedRelationRefs) {
    const relation = baseRelations.get(key) ?? candidateRelations.get(key);
    if (relation) affectedNodeIds.push(relation.fromNodeId, relation.toNodeId);
  }
  const affectedContractIds = changedIds(base.artifactContracts, candidate.artifactContracts);
  const baseSkeleton = mapById(base.skeletonCriteria);
  const candidateSkeleton = mapById(candidate.skeletonCriteria);
  const affectedSkeletonIds = changedIds(base.skeletonCriteria, candidate.skeletonCriteria);
  const skeletonBranches = affectedSkeletonIds.flatMap((id) => {
    const value = baseSkeleton.get(id) ?? candidateSkeleton.get(id);
    return value ? [value.branchNodeId] : [];
  });
  affectedNodeIds.push(...skeletonBranches);
  const uniqueNodes = [...new Set(affectedNodeIds)].sort();
  const root = candidate.nodes.find((node) => node.parentId === null) ?? base.nodes.find((node) => node.parentId === null);
  const rootChanged = Boolean(root && uniqueNodes.includes(root.id));
  const branchIds = [...new Set(uniqueNodes.flatMap((nodeId) => {
    const branch = topBranchForNode(candidate, nodeId) ?? topBranchForNode(base, nodeId);
    return branch && branch !== root?.id ? [branch] : [];
  }))].sort();
  const planningChanged = canonicalJson(base.planningContext ?? null) !== canonicalJson(candidate.planningContext ?? null)
    || base.planningVersion !== candidate.planningVersion;
  if (rootChanged || planningChanged) {
    for (const branch of root?.children ?? []) if (!branchIds.includes(branch)) branchIds.push(branch);
    branchIds.sort();
  }
  const hasStructuralChange = planningChanged || uniqueNodes.length > 0 || affectedArtifactIds.length > 0
    || affectedRelationRefs.length > 0 || affectedContractIds.length > 0;
  const crossBranch = rootChanged || branchIds.length > 1 || planningChanged;
  return {
    hasStructuralChange,
    impactLevel: crossBranch ? "cross_branch" : "local",
    applyMode: crossBranch ? "preview_required" : "direct_draft_apply",
    affectedNodeIds: uniqueNodes,
    affectedBranchIds: branchIds,
    affectedArtifactIds,
    affectedRelationRefs,
    affectedContractIds,
    proposedDocumentHash: createHash("sha256").update(canonicalJson(candidate)).digest("hex"),
  };
}
