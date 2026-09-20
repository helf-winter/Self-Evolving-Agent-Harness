import path from "node:path";
import type { ArtifactInput } from "./artifact.js";
import { normalizeProjectPath } from "./project.js";
import type { TaskNodeInput, TaskTreeDocument } from "./task-tree.js";

export interface ProjectIdentityMarker {
  schemaVersion: 1;
  projectId: string;
  identityToken: string | null;
  legacy: boolean;
}

export type ProjectLocationResolution = "same_project" | "moved_or_renamed" | "copy_detected" | "identity_conflict";
export type SourcePathAvailability = "exists" | "missing" | "unknown";

export function parseProjectIdentityMarker(input: unknown): ProjectIdentityMarker | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  if (value.schema_version === 1 && typeof value.project_id === "string" && value.project_id.trim()
    && typeof value.identity_token === "string" && value.identity_token.trim()) {
    return {
      schemaVersion: 1, projectId: value.project_id.trim(), identityToken: value.identity_token.trim(), legacy: false,
    };
  }
  if (value.version === 1 && typeof value.projectId === "string" && value.projectId.trim()) {
    return { schemaVersion: 1, projectId: value.projectId.trim(), identityToken: null, legacy: true };
  }
  return null;
}

export function serializeProjectIdentityMarker(input: { projectId: string; identityToken: string }): string {
  return `${JSON.stringify({
    schema_version: 1, project_id: input.projectId, identity_token: input.identityToken,
  }, null, 2)}\n`;
}

export function classifyProjectLocation(input: {
  samePath: boolean;
  sourceAvailability: SourcePathAvailability;
}): ProjectLocationResolution {
  if (input.samePath) return "same_project";
  if (input.sourceAvailability === "missing") return "moved_or_renamed";
  if (input.sourceAvailability === "exists") return "copy_detected";
  return "identity_conflict";
}

export function mapClonedTaskNodeStatus(status: string, baselineVerified: boolean): string {
  if (status === "running") return "paused_after_clone";
  if (status === "verifying") return "needs_revalidation";
  if (status === "succeeded") return baselineVerified ? "succeeded" : "needs_revalidation";
  return status;
}

function isAbsolute(locator: string): boolean {
  return path.posix.isAbsolute(locator.replaceAll("\\", "/")) || /^[A-Za-z]:[\\/]/.test(locator);
}

function isWindowsLike(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\/mnt\/[A-Za-z](?:\/|$)/.test(value);
}

export function rebaseCloneLocator(locator: string, sourceRoot: string, targetRoot: string): {
  locator: string;
  externalReference: boolean;
} {
  if (!isAbsolute(locator)) return { locator, externalReference: false };
  const normalizedLocator = normalizeProjectPath(locator);
  const normalizedSource = normalizeProjectPath(sourceRoot);
  const normalizedTarget = normalizeProjectPath(targetRoot);
  const compareLocator = isWindowsLike(normalizedLocator) ? normalizedLocator.toLowerCase() : normalizedLocator;
  const compareSource = isWindowsLike(normalizedSource) ? normalizedSource.toLowerCase() : normalizedSource;
  if (compareLocator === compareSource) return { locator: normalizedTarget, externalReference: false };
  if (compareLocator.startsWith(`${compareSource}/`)) {
    return {
      locator: `${normalizedTarget}${normalizedLocator.slice(normalizedSource.length)}`,
      externalReference: false,
    };
  }
  return { locator: normalizedLocator, externalReference: true };
}

function requireMappedId(map: Map<string, string>, id: string, kind: string): string {
  const mapped = map.get(id);
  if (!mapped) throw new Error(`missing ${kind} clone mapping for ${id}`);
  return mapped;
}

function rewriteNode(node: TaskNodeInput, nodeIds: Map<string, string>): TaskNodeInput {
  return {
    ...node,
    id: requireMappedId(nodeIds, node.id, "Task Node"),
    parentId: node.parentId ? requireMappedId(nodeIds, node.parentId, "Task Node") : null,
    children: node.children.map((id) => requireMappedId(nodeIds, id, "Task Node")),
    ...(node.dependencies ? { dependencies: node.dependencies.map((id) => requireMappedId(nodeIds, id, "Task Node")) } : {}),
  };
}

function rewriteArtifact(
  artifact: ArtifactInput,
  artifactIds: Map<string, string>,
  sourceRoot: string,
  targetRoot: string,
): ArtifactInput {
  const rebased = rebaseCloneLocator(artifact.locator, sourceRoot, targetRoot);
  return {
    ...artifact,
    id: requireMappedId(artifactIds, artifact.id, "Artifact"),
    locator: rebased.locator,
    status: artifact.status === "draft" ? "draft" : "planned",
    parentArtifactId: artifact.parentArtifactId
      ? requireMappedId(artifactIds, artifact.parentArtifactId, "Artifact") : null,
    confidence: "planned",
    metadata: {
      ...(artifact.metadata ?? {}), clonedFromArtifactId: artifact.id,
      ...(rebased.externalReference ? { externalReference: true } : {}),
    },
  };
}

export function rewriteTaskTreeDocumentForClone(input: {
  document: TaskTreeDocument;
  nodeIds: Map<string, string>;
  artifactIds: Map<string, string>;
  sourceRoot: string;
  targetRoot: string;
}): TaskTreeDocument {
  const { document, nodeIds, artifactIds, sourceRoot, targetRoot } = input;
  return {
    nodes: document.nodes.map((node) => rewriteNode(node, nodeIds)),
    relations: document.relations.map((relation) => ({
      ...relation,
      fromNodeId: requireMappedId(nodeIds, relation.fromNodeId, "Task Node"),
      toNodeId: requireMappedId(nodeIds, relation.toNodeId, "Task Node"),
      ...(relation.artifactId ? { artifactId: requireMappedId(artifactIds, relation.artifactId, "Artifact") } : {}),
    })),
    artifacts: document.artifacts.map((artifact) => rewriteArtifact(artifact, artifactIds, sourceRoot, targetRoot)),
    ...(document.artifactLinks ? {
      artifactLinks: document.artifactLinks.map((link) => ({
        ...link,
        taskNodeId: requireMappedId(nodeIds, link.taskNodeId, "Task Node"),
        artifactId: requireMappedId(artifactIds, link.artifactId, "Artifact"),
      })),
    } : {}),
    ...(document.artifactRelations ? {
      artifactRelations: document.artifactRelations.map((relation) => ({
        ...relation,
        fromArtifactId: requireMappedId(artifactIds, relation.fromArtifactId, "Artifact"),
        toArtifactId: requireMappedId(artifactIds, relation.toArtifactId, "Artifact"),
      })),
    } : {}),
    ...(document.artifactContracts ? {
      artifactContracts: document.artifactContracts.map((contract) => ({
        ...contract,
        artifactId: requireMappedId(artifactIds, contract.artifactId, "Artifact"),
        providerNodeIds: contract.providerNodeIds.map((id) => requireMappedId(nodeIds, id, "Task Node")),
        consumerNodeIds: contract.consumerNodeIds.map((id) => requireMappedId(nodeIds, id, "Task Node")),
      })),
    } : {}),
  };
}
