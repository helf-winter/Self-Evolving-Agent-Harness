import type { ArtifactGranularity, ArtifactInput } from "./artifact.js";

export type TaskArtifactRelationType = "plans" | "implements" | "consumes" | "creates" | "modifies" | "reads" | "deletes" | "verifies";
export type ArtifactRelationKind = "contains" | "imports" | "calls" | "uses_schema" | "returns_schema" | "verified_by" | "fails_with";
export type ContractCompatibilityPolicy = "exact" | "backward_compatible" | "custom_validation";

export interface TaskArtifactLinkInput {
  taskNodeId: string;
  artifactId: string;
  relationType: TaskArtifactRelationType;
}

export interface ArtifactRelationInput {
  fromArtifactId: string;
  toArtifactId: string;
  kind: ArtifactRelationKind;
}

export interface ArtifactContractInput {
  id: string;
  artifactId: string;
  name: string;
  version: string;
  compatibilityPolicy: ContractCompatibilityPolicy;
  schemaOrSignature: string;
  providerNodeIds: string[];
  consumerNodeIds: string[];
  validationRefs: string[];
}

export interface NormalizedArtifactInput extends Required<Omit<ArtifactInput, "currentHashOrVersion">> {
  currentHashOrVersion?: string | null;
}

function defaultGranularity(kind: ArtifactInput["kind"]): ArtifactGranularity {
  if (kind === "contract") return "contract";
  if (kind === "symbol") return "symbol";
  return "structural";
}

function defaultIdentityStrategy(kind: ArtifactInput["kind"]): NonNullable<ArtifactInput["identityStrategy"]> {
  if (kind === "contract") return "logical_contract_id";
  if (kind === "symbol") return "qualified_symbol";
  if (kind === "command") return "command_signature";
  return "path";
}

export function normalizeArtifactInput(input: ArtifactInput): NormalizedArtifactInput {
  const status = input.status ?? "draft";
  return {
    id: input.id,
    kind: input.kind,
    locator: input.locator,
    status,
    granularity: input.granularity ?? defaultGranularity(input.kind),
    artifactType: input.artifactType ?? input.kind,
    pathOrName: input.pathOrName ?? input.locator,
    parentArtifactId: input.parentArtifactId ?? null,
    identityStrategy: input.identityStrategy ?? defaultIdentityStrategy(input.kind),
    confidence: input.confidence ?? (status === "draft" || status === "planned" ? "planned" : "observed"),
    metadata: input.metadata ?? {},
    ...(input.currentHashOrVersion !== undefined ? { currentHashOrVersion: input.currentHashOrVersion } : {}),
  };
}
