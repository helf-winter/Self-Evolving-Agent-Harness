import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  await import("node:fs/promises").then((fs) => fs.mkdir(projectDir));
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
    expect(created.status).toBe("persisted");
    expect(repeated.projectId).toBe(created.projectId);
    expect(database.all("SELECT id FROM projects")).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(projectDir, ".agent-harness-project.json"), "utf8"))).toEqual({ version: 1, projectId: created.projectId });
    database.close();
  });

  it("returns identity_conflict instead of sharing one marker across unrelated directories", async () => {
    const { database, directory, projectDir, service } = await fixture();
    const created = await service.resolve(projectDir, "persist");
    const copied = path.join(directory, "copied");
    await import("node:fs/promises").then((fs) => fs.mkdir(copied));
    await writeFile(path.join(copied, ".agent-harness-project.json"), JSON.stringify({ version: 1, projectId: created.projectId }));
    expect(await service.resolve(copied, "persist")).toMatchObject({ status: "identity_conflict", projectId: created.projectId });
    expect(database.all("SELECT normalized_path FROM project_path_aliases")).toHaveLength(1);
    database.close();
  });
});
