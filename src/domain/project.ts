import path from "node:path";

const windowsPath = /^[A-Za-z]:[\\/]/;
const wslPath = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/;

export function normalizeProjectPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (windowsPath.test(trimmed)) {
    const slashed = trimmed.replaceAll("\\", "/").replace(/\/+$/, "");
    return `${slashed[0]!.toLowerCase()}${slashed.slice(1)}`;
  }
  return path.posix.normalize(trimmed.replaceAll("\\", "/")).replace(/\/$/, "") || "/";
}

function comparable(input: string): string {
  const normalized = normalizeProjectPath(input);
  const match = normalized.match(wslPath);
  if (match) return `${match[1]!.toLowerCase()}:/${match[2] ?? ""}`.toLowerCase();
  return windowsPath.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function pathsReferToSameProject(left: string, right: string): boolean {
  return comparable(left) === comparable(right);
}

export interface ProjectView {
  projectId: string;
  canonicalPath: string;
  status: "same_project" | "moved_or_renamed" | "copy_detected" | "new_project" | "identity_conflict";
  sourceProjectId?: string;
  cloneId?: string;
}
