export type ArtifactKind = "file" | "command" | "contract" | "symbol";
export type ArtifactGranularity = "structural" | "contract" | "symbol";
export type ArtifactStatus = "draft" | "planned" | "created" | "modified" | "verified" | "deprecated" | "observed" | "failed";
export type ArtifactConfidence = "planned" | "observed" | "verified";

export interface ArtifactInput {
  id: string;
  kind: ArtifactKind;
  locator: string;
  status?: ArtifactStatus;
  granularity?: ArtifactGranularity;
  artifactType?: string;
  pathOrName?: string;
  parentArtifactId?: string | null;
  identityStrategy?: "path" | "logical_contract_id" | "qualified_symbol" | "command_signature";
  confidence?: ArtifactConfidence;
  currentHashOrVersion?: string | null;
  metadata?: Record<string, unknown>;
}
