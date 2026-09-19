import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeDatabase } from "../../src/storage/database.js";
import { migrations } from "../../src/storage/migrations.js";

const dirs: string[] = [];
async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-db-"));
  dirs.push(directory);
  return path.join(directory, "runtime.db");
}
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("RuntimeDatabase", () => {
  it("applies migrations once and persists data across reopen", async () => {
    const filename = await databasePath();
    const first = new RuntimeDatabase(filename);
    expect(first.all<{ version: number }>("SELECT version FROM schema_migrations")).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    first.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES (?, ?, ?, ?)", "p1", "/work/a", "2026-01-01", "2026-01-01");
    first.close();

    const reopened = new RuntimeDatabase(filename);
    expect(reopened.get<{ canonical_path: string }>("SELECT canonical_path FROM projects WHERE id = ?", "p1")).toEqual({ canonical_path: "/work/a" });
    expect(reopened.all("SELECT version FROM schema_migrations")).toHaveLength(3);
    reopened.close();
  });

  it("rolls back every write when a transaction fails", async () => {
    const database = new RuntimeDatabase(await databasePath());
    expect(() => database.transaction(() => {
      database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES (?, ?, ?, ?)", "p1", "/work/a", "now", "now");
      throw new Error("stop");
    })).toThrow("stop");
    expect(database.get("SELECT id FROM projects WHERE id = ?", "p1")).toBeUndefined();
    database.close();
  });

  it("enforces immutable task tree revision identities", async () => {
    const database = new RuntimeDatabase(await databasePath());
    database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES (?, ?, ?, ?)", "p1", "/work/a", "now", "now");
    database.run("INSERT INTO task_trees (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", "t1", "p1", "Tree", "draft", "now", "now");
    database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES (?, ?, ?, ?, ?)", "r1", "t1", 1, "{}", "now");
    expect(() => database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES (?, ?, ?, ?, ?)", "r2", "t1", 1, "{}", "now")).toThrow();
    database.close();
  });

  it("allows only one active execution attempt per task node", async () => {
    const database = new RuntimeDatabase(await databasePath());
    database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES (?, ?, ?, ?)", "p1", "/work/a", "now", "now");
    database.run("INSERT INTO task_trees (id, project_id, title, status, current_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", "t1", "p1", "Tree", "confirmed", "tr1", "now", "now");
    database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES (?, ?, ?, ?, ?)", "tr1", "t1", 1, "{}", "now");
    database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES (?, ?, ?, ?, ?)", "n1", "t1", null, "Node", "ready");
    database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES (?, ?, ?, ?, ?)", "nr1", "n1", "tr1", "{}", "now");

    database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "a1", "p1", "t1", "n1", "nr1", 1, "running", "now");
    expect(() => database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "a2", "p1", "t1", "n1", "nr1", 2, "running", "now")).toThrow();

    database.run("UPDATE execution_attempts SET status = ?, completed_at = ? WHERE id = ?", "failed", "later", "a1");
    expect(() => database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "a2", "p1", "t1", "n1", "nr1", 2, "running", "later")).not.toThrow();
    database.close();
  });

  it("adds revision-scoped confirmation records and conservative legacy backfill", async () => {
    const filename = await databasePath();
    const legacy = new DatabaseSync(filename);
    legacy.exec("PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const migration of migrations.slice(0, 2)) {
      legacy.exec(migration.sql);
      legacy.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, 'now')").run(migration.version);
    }
    legacy.prepare("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/work/a', 'now', 'now')").run();
    legacy.prepare("INSERT INTO task_trees (id, project_id, title, status, current_revision_id, created_at, updated_at) VALUES ('t1', 'p1', 'Tree', 'confirmed', 'tr1', 'now', 'now')").run();
    legacy.prepare("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES ('tr1', 't1', 1, '{}', 'now')").run();
    legacy.prepare("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES ('n1', 't1', NULL, 'Node', 'ready')").run();
    legacy.close();

    const database = new RuntimeDatabase(filename);
    expect(database.get<{ state: string }>(
      "SELECT state FROM task_node_confirmation_states WHERE tree_revision_id = 'tr1' AND task_node_id = 'n1'",
    )).toEqual({ state: "confirmed" });
    expect(database.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('scope_confirmation_records', 'task_node_confirmation_states') ORDER BY name",
    )).toEqual([{ name: "scope_confirmation_records" }, { name: "task_node_confirmation_states" }]);
    expect(() => database.run(
      "INSERT INTO task_node_confirmation_states (project_id, tree_id, tree_revision_id, task_node_id, state, updated_at) VALUES ('p1', 't1', 'tr1', 'n2', 'invalid', 'now')",
    )).toThrow();
    database.close();
  });
});
