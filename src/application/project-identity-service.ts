import { access, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newId, nowIso } from "../domain/ids.js";
import { normalizeProjectPath, pathsReferToSameProject, type ProjectView } from "../domain/project.js";
import type { RuntimeDatabase } from "../storage/database.js";

const markerName = ".agent-harness-project.json";

interface ProjectRow {
  id: string;
  canonical_path: string;
}

export function resolveDataHome(environment: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (environment.AGENT_HARNESS_DATA_HOME) return path.resolve(environment.AGENT_HARNESS_DATA_HOME);
  if (platform !== "win32") {
    if (environment.XDG_DATA_HOME) return path.join(environment.XDG_DATA_HOME, "agent-harness");
    return path.join(environment.HOME ?? os.homedir(), ".local", "share", "agent-harness");
  }
  return path.join(environment.LOCALAPPDATA ?? os.homedir(), "AgentHarness");
}

export class ProjectIdentityService {
  constructor(private readonly database: RuntimeDatabase) {}

  async resolve(cwd: string, mode: "inspect" | "persist"): Promise<ProjectView> {
    const canonicalPath = normalizeProjectPath(path.resolve(cwd));
    const alias = this.database.get<{ project_id: string }>("SELECT project_id FROM project_path_aliases WHERE normalized_path = ?", canonicalPath);
    if (alias) return { projectId: alias.project_id, canonicalPath, status: "persisted" };

    const markerPath = path.join(cwd, markerName);
    const marker = await this.readMarker(markerPath);
    if (marker) {
      const project = this.database.get<ProjectRow>("SELECT id, canonical_path FROM projects WHERE id = ?", marker.projectId);
      if (project && pathsReferToSameProject(project.canonical_path, canonicalPath)) {
        if (mode === "persist") this.insertAlias(project.id, canonicalPath);
        return { projectId: project.id, canonicalPath, status: "persisted" };
      }
      return { projectId: marker.projectId, canonicalPath, status: "identity_conflict" };
    }

    const byPath = this.database.get<ProjectRow>("SELECT id, canonical_path FROM projects WHERE canonical_path = ?", canonicalPath);
    if (byPath) return { projectId: byPath.id, canonicalPath, status: "persisted" };
    if (mode === "inspect") return { projectId: "", canonicalPath, status: "new_project" };

    const projectId = newId();
    const timestamp = nowIso();
    this.database.transaction(() => {
      this.database.run(
        "INSERT INTO projects (id, canonical_path, marker_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        projectId, canonicalPath, projectId, timestamp, timestamp,
      );
      this.insertAlias(projectId, canonicalPath);
    });
    await this.writeMarker(markerPath, projectId);
    return { projectId, canonicalPath, status: "persisted" };
  }

  private insertAlias(projectId: string, normalizedPath: string): void {
    this.database.run(
      "INSERT OR IGNORE INTO project_path_aliases (project_id, normalized_path, created_at) VALUES (?, ?, ?)",
      projectId, normalizedPath, nowIso(),
    );
  }

  private async readMarker(markerPath: string): Promise<{ projectId: string } | undefined> {
    try {
      await access(markerPath);
      const parsed = JSON.parse(await readFile(markerPath, "utf8")) as { version?: unknown; projectId?: unknown };
      return parsed.version === 1 && typeof parsed.projectId === "string" ? { projectId: parsed.projectId } : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeMarker(markerPath: string, projectId: string): Promise<void> {
    const temporary = `${markerPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, projectId }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, markerPath);
  }
}
