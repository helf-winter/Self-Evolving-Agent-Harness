import { randomBytes } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newId, nowIso } from "../domain/ids.js";
import {
  classifyProjectLocation,
  parseProjectIdentityMarker,
  serializeProjectIdentityMarker,
  type ProjectIdentityMarker,
  type SourcePathAvailability,
} from "../domain/project-clone.js";
import { normalizeProjectPath, pathsReferToSameProject, type ProjectView } from "../domain/project.js";
import type { RuntimeDatabase } from "../storage/database.js";
import { ProjectCloneService } from "./project-clone-service.js";

const markerName = ".agent-harness-project.json";

interface ProjectRow {
  id: string;
  canonical_path: string;
  identity_token: string | null;
}

type MarkerRead = { kind: "missing" } | { kind: "invalid" } | { kind: "valid"; marker: ProjectIdentityMarker };

export function resolveDataHome(environment: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (environment.AGENT_HARNESS_DATA_HOME) return path.resolve(environment.AGENT_HARNESS_DATA_HOME);
  if (platform !== "win32") {
    if (environment.XDG_DATA_HOME) return path.join(environment.XDG_DATA_HOME, "agent-harness");
    return path.join(environment.HOME ?? os.homedir(), ".local", "share", "agent-harness");
  }
  return path.join(environment.LOCALAPPDATA ?? os.homedir(), "AgentHarness");
}

export class ProjectIdentityService {
  private readonly clones: ProjectCloneService;

  constructor(private readonly database: RuntimeDatabase) {
    this.clones = new ProjectCloneService(database);
  }

  async resolve(cwd: string, mode: "inspect" | "persist"): Promise<ProjectView> {
    const absolutePath = path.resolve(cwd);
    const canonicalPath = normalizeProjectPath(absolutePath);
    const markerPath = path.join(absolutePath, markerName);
    const markerRead = await this.readMarker(markerPath);
    if (markerRead.kind === "invalid") return { projectId: "", canonicalPath, status: "identity_conflict" };
    if (markerRead.kind === "valid") {
      return this.resolveMarker({ cwd: absolutePath, canonicalPath, markerPath, marker: markerRead.marker, mode });
    }

    const alias = this.database.get<{ project_id: string }>(
      "SELECT project_id FROM project_path_aliases WHERE normalized_path = ?", canonicalPath,
    );
    if (alias) return { projectId: alias.project_id, canonicalPath, status: "same_project" };
    const byPath = this.database.get<ProjectRow>(
      "SELECT id, canonical_path, identity_token FROM projects WHERE canonical_path = ?", canonicalPath,
    );
    if (byPath) {
      if (mode === "persist") {
        const token = byPath.identity_token ?? this.issueToken(byPath.id);
        await this.writeMarker(markerPath, byPath.id, token);
      }
      return { projectId: byPath.id, canonicalPath, status: "same_project" };
    }
    if (mode === "inspect") return { projectId: "", canonicalPath, status: "new_project" };

    const projectId = newId();
    const identityToken = randomBytes(32).toString("hex");
    const timestamp = nowIso();
    this.database.transaction(() => {
      this.database.run(`INSERT INTO projects (
        id, canonical_path, marker_id, identity_token, display_path, display_name, platform, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, projectId, canonicalPath, projectId, identityToken,
      absolutePath, path.basename(absolutePath), process.platform, timestamp, timestamp);
      this.insertAlias(projectId, canonicalPath, absolutePath, true);
    });
    await this.writeMarker(markerPath, projectId, identityToken);
    return { projectId, canonicalPath, status: "new_project" };
  }

  private async resolveMarker(input: {
    cwd: string; canonicalPath: string; markerPath: string; marker: ProjectIdentityMarker; mode: "inspect" | "persist";
  }): Promise<ProjectView> {
    const project = this.database.get<ProjectRow>(
      "SELECT id, canonical_path, identity_token FROM projects WHERE id = ?", input.marker.projectId,
    );
    if (!project) return { projectId: input.marker.projectId, canonicalPath: input.canonicalPath, status: "identity_conflict" };
    if (project.identity_token && input.marker.identityToken && project.identity_token !== input.marker.identityToken) {
      return { projectId: project.id, canonicalPath: input.canonicalPath, status: "identity_conflict" };
    }
    const samePath = pathsReferToSameProject(project.canonical_path, input.canonicalPath)
      || Boolean(this.database.get(
        "SELECT 1 FROM project_path_aliases WHERE project_id = ? AND normalized_path = ?", project.id, input.canonicalPath,
      ));
    const sourceAvailability = samePath ? "exists" : await this.sourceAvailability(project.canonical_path);
    const resolution = classifyProjectLocation({ samePath, sourceAvailability });
    if (resolution === "identity_conflict") {
      return { projectId: project.id, canonicalPath: input.canonicalPath, status: "identity_conflict" };
    }
    if (resolution === "copy_detected") {
      if (input.mode === "inspect") {
        return {
          projectId: project.id, sourceProjectId: project.id,
          canonicalPath: input.canonicalPath, status: "copy_detected",
        };
      }
      const clone = this.clones.cloneProject({
        sourceProjectId: project.id, targetCanonicalPath: input.canonicalPath,
        targetDisplayPath: input.cwd, platform: process.platform,
      });
      await this.writeMarker(input.markerPath, clone.targetProjectId, clone.identityToken);
      this.clones.markMarkerWritten({ cloneId: clone.cloneId, targetProjectId: clone.targetProjectId });
      return {
        projectId: clone.targetProjectId, sourceProjectId: project.id, cloneId: clone.cloneId,
        canonicalPath: input.canonicalPath, status: "copy_detected",
      };
    }
    const token = project.identity_token ?? (input.mode === "persist" ? this.issueToken(project.id) : null);
    if (resolution === "moved_or_renamed" && input.mode === "persist") {
      this.database.transaction(() => {
        this.database.run(
          "UPDATE projects SET canonical_path = ?, display_path = ?, platform = ?, updated_at = ? WHERE id = ?",
          input.canonicalPath, input.cwd, process.platform, nowIso(), project.id,
        );
        this.database.run("UPDATE project_path_aliases SET is_primary = 0 WHERE project_id = ?", project.id);
        this.insertAlias(project.id, input.canonicalPath, input.cwd, true);
      });
    } else if (resolution === "same_project" && input.mode === "persist") {
      this.insertAlias(project.id, input.canonicalPath, input.cwd,
        normalizeProjectPath(project.canonical_path) === input.canonicalPath);
    }
    if (input.mode === "persist" && token && (input.marker.legacy || input.marker.identityToken !== token)) {
      await this.writeMarker(input.markerPath, project.id, token);
    }
    return { projectId: project.id, canonicalPath: input.canonicalPath, status: resolution };
  }

  private issueToken(projectId: string): string {
    const token = randomBytes(32).toString("hex");
    this.database.run("UPDATE projects SET identity_token = ?, updated_at = ? WHERE id = ?", token, nowIso(), projectId);
    return token;
  }

  private insertAlias(projectId: string, normalizedPath: string, observedPath: string, primary: boolean): void {
    this.database.run(`INSERT INTO project_path_aliases (
      project_id, normalized_path, observed_path, platform, is_primary, created_at
    ) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(normalized_path) DO UPDATE SET
      observed_path = excluded.observed_path, platform = excluded.platform, is_primary = excluded.is_primary`,
    projectId, normalizedPath, observedPath, process.platform, primary ? 1 : 0, nowIso());
  }

  private async sourceAvailability(sourcePath: string): Promise<SourcePathAvailability> {
    try {
      await access(sourcePath);
      return "exists";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown";
    }
  }

  private async readMarker(markerPath: string): Promise<MarkerRead> {
    try {
      const marker = parseProjectIdentityMarker(JSON.parse(await readFile(markerPath, "utf8")));
      return marker ? { kind: "valid", marker } : { kind: "invalid" };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
    }
  }

  private async writeMarker(markerPath: string, projectId: string, identityToken: string): Promise<void> {
    const temporary = `${markerPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, serializeProjectIdentityMarker({ projectId, identityToken }), { encoding: "utf8", flag: "wx" });
    await rename(temporary, markerPath);
  }
}
