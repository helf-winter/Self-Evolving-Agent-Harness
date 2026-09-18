export type ArtifactKind = "file" | "command" | "contract" | "symbol";
export type ArtifactStatus = "draft" | "planned" | "observed" | "failed";

export interface ArtifactInput {
  id: string;
  kind: ArtifactKind;
  locator: string;
  status?: ArtifactStatus;
}
