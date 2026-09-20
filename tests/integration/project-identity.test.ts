import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectIdentityService } from "../../src/application/project-identity-service.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-project-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "data", "runtime.db"));
  const projectDir = path.join(directory, "project");
  await mkdir(projectDir);
  return { directory, database, projectDir, service: new ProjectIdentityService(database) };
}
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("ProjectIdentityService", () => {
  it("inspects an unknown directory without creating records or a marker", async () => {
    const { database, projectDir, service } = await fixture();
    const expectedPath = projectDir.replaceAll("\\", "/").replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
    expect(await service.resolve(projectDir, "inspect")).toMatchObject({ status: "new_project", canonicalPath: expectedPath });
    expect(database.all("SELECT id FROM projects")).toEqual([]);
    await expect(readFile(path.join(projectDir, ".agent-harness-project.json"))).rejects.toThrow();
    database.close();
  });

  it("creates exactly one marker and reuses the project on later resolution", async () => {
    const { database, projectDir, service } = await fixture();
    const created = await service.resolve(projectDir, "persist");
    const repeated = await service.resolve(projectDir, "persist");
    expect(created.status).toBe("new_project");
    expect(repeated.status).toBe("same_project");
    expect(repeated.projectId).toBe(created.projectId);
    expect(database.all("SELECT id FROM projects")).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(projectDir, ".agent-harness-project.json"), "utf8"))).toMatchObject({
      schema_version: 1, project_id: created.projectId, identity_token: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    database.close();
  });

  it("keeps the Project ID when a directory is definitely moved", async () => {
    const { database, directory, projectDir, service } = await fixture();
    const created = await service.resolve(projectDir, "persist");
    const moved = path.join(directory, "moved");
    await rename(projectDir, moved);
    expect(await service.resolve(moved, "inspect")).toMatchObject({
      status: "moved_or_renamed", projectId: created.projectId,
    });
    expect(await service.resolve(moved, "persist")).toMatchObject({
      status: "moved_or_renamed", projectId: created.projectId,
    });
    expect(database.get<{ canonical_path: string }>("SELECT canonical_path FROM projects WHERE id = ?", created.projectId)?.canonical_path)
      .toContain("/moved");
    database.close();
  });

  it("detects a copied marker read-only, then clones and rewrites it on persistence", async () => {
    const { database, directory, projectDir, service } = await fixture();
    const created = await service.resolve(projectDir, "persist");
    const copied = path.join(directory, "copied");
    await cp(projectDir, copied, { recursive: true });
    expect(await service.resolve(copied, "inspect")).toMatchObject({
      status: "copy_detected", projectId: created.projectId, sourceProjectId: created.projectId,
    });
    expect(database.all("SELECT id FROM projects")).toHaveLength(1);
    const cloned = await service.resolve(copied, "persist");
    expect(cloned).toMatchObject({ status: "copy_detected", sourceProjectId: created.projectId });
    expect(cloned.projectId).not.toBe(created.projectId);
    expect(JSON.parse(await readFile(path.join(copied, ".agent-harness-project.json"), "utf8"))).toMatchObject({
      schema_version: 1, project_id: cloned.projectId,
    });
    expect(database.get<{ status: string }>("SELECT status FROM project_clone_records WHERE target_project_id = ?", cloned.projectId))
      .toEqual({ status: "completed" });
    expect(database.all("SELECT id FROM projects")).toHaveLength(2);
    database.close();
  });

  it("rejects a token mismatch and upgrades a same-path legacy marker only in persist mode", async () => {
    const { database, projectDir, service } = await fixture();
    const created = await service.resolve(projectDir, "persist");
    const markerPath = path.join(projectDir, ".agent-harness-project.json");
    await writeFile(markerPath, JSON.stringify({ schema_version: 1, project_id: created.projectId, identity_token: "wrong" }));
    expect(await service.resolve(projectDir, "persist")).toMatchObject({ status: "identity_conflict" });
    await writeFile(markerPath, JSON.stringify({ version: 1, projectId: created.projectId }));
    database.run("UPDATE projects SET identity_token = NULL WHERE id = ?", created.projectId);
    expect(await service.resolve(projectDir, "inspect")).toMatchObject({ status: "same_project" });
    await service.resolve(projectDir, "persist");
    expect(JSON.parse(await readFile(markerPath, "utf8"))).toMatchObject({
      schema_version: 1, project_id: created.projectId, identity_token: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    database.close();
  });
});
