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
    expect(first.all<{ version: number }>("SELECT version FROM schema_migrations")).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }]);
    first.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES (?, ?, ?, ?)", "p1", "/work/a", "2026-01-01", "2026-01-01");
    first.close();

    const reopened = new RuntimeDatabase(filename);
    expect(reopened.get<{ canonical_path: string }>("SELECT canonical_path FROM projects WHERE id = ?", "p1")).toEqual({ canonical_path: "/work/a" });
    expect(reopened.all("SELECT version FROM schema_migrations")).toHaveLength(6);
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

  it("adds Artifact Graph planning projections with legacy Artifact defaults", async () => {
    const database = new RuntimeDatabase(await databasePath());
    const tables = database.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('task_node_artifact_links', 'artifact_graph_relations', 'artifact_contracts', 'plan_drift_records') ORDER BY name",
    );
    expect(tables).toEqual([
      { name: "artifact_contracts" }, { name: "artifact_graph_relations" }, { name: "plan_drift_records" }, { name: "task_node_artifact_links" },
    ]);
    database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/work/a', 'now', 'now')");
    database.run("INSERT INTO artifacts (id, project_id, kind, locator, status, metadata_json, created_at, updated_at) VALUES ('a1', 'p1', 'command', 'npm test', 'observed', '{}', 'now', 'now')");
    expect(database.get<{ granularity: string; artifact_type: string; identity_strategy: string; confidence: string }>(
      "SELECT granularity, artifact_type, identity_strategy, confidence FROM artifacts WHERE id = 'a1'",
    )).toEqual({ granularity: "structural", artifact_type: "file", identity_strategy: "path", confidence: "observed" });
    database.close();
  });

  it("adds typed Runtime Action, confirmation, and User Change persistence", async () => {
    const database = new RuntimeDatabase(await databasePath());
    const tables = database.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_change_requests'",
    );
    expect(tables).toEqual([{ name: "user_change_requests" }]);
    database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/work/a', 'now', 'now')");
    database.run("INSERT INTO task_trees (id, project_id, title, status, created_at, updated_at) VALUES ('t1', 'p1', 'Tree', 'confirmed', 'now', 'now')");
    database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES ('tr1', 't1', 1, '{}', 'now')");
    database.run("UPDATE task_trees SET current_revision_id = 'tr1' WHERE id = 't1'");
    database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('trace-1', 'p1', 't1', NULL, 's', 'UserPromptSubmit', '{}', 'now', 'trace-1')");
    database.run("INSERT INTO runtime_actions (id, project_id, kind, input_json, result_json, created_at, action_type, target_type, target_id, expected_revision, reason, source_message_ref, risk_level, confirmation_requirement, status) VALUES ('ra1', 'p1', 'record_user_change', '{}', '{}', 'now', 'record_user_change', 'task_tree', 't1', 'tr1', 'Change scope', 'trace-1', 'high', 'required', 'pending_confirmation')");
    database.run("INSERT INTO runtime_confirmation_prompts (id, project_id, tree_id, scope_id, prompt, status, created_at, prompt_type, related_artifact_ids_json, options_json, runtime_action_id) VALUES ('c1', 'p1', 't1', 't1', 'Apply?', 'pending', 'now', 'change_confirmation', '[]', '[\"yes\",\"no\",\"pause\"]', 'ra1')");
    database.run("INSERT INTO user_change_requests (id, project_id, tree_id, task_node_id, change_type, source_trace_event_id, expected_tree_revision_id, summary, change_impact_json, proposed_document_json, priority_target_node_id, prior_node_status, status, runtime_action_id, created_at, updated_at) VALUES ('u1', 'p1', 't1', NULL, 'scope_change', 'trace-1', 'tr1', 'Change scope', '{}', '{}', NULL, NULL, 'pending_confirmation', 'ra1', 'now', 'now')");
    expect(database.get<{ prompt_type: string; runtime_action_id: string }>("SELECT prompt_type, runtime_action_id FROM runtime_confirmation_prompts WHERE id = 'c1'")).toEqual({ prompt_type: "change_confirmation", runtime_action_id: "ra1" });
    expect(() => database.run("INSERT INTO user_change_requests (id, project_id, tree_id, change_type, expected_tree_revision_id, summary, change_impact_json, status, runtime_action_id, created_at, updated_at) VALUES ('bad', 'p1', 't1', 'unknown', 'tr1', 'bad', '{}', 'applied', 'ra1', 'now', 'now')")).toThrow();
    database.close();
  });

  it("backfills legacy Runtime Actions and branch confirmation prompts", async () => {
    const filename = await databasePath();
    const legacy = new DatabaseSync(filename);
    legacy.exec("PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const migration of migrations.slice(0, 4)) {
      legacy.exec(migration.sql);
      legacy.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, 'now')").run(migration.version);
    }
    legacy.prepare("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/work/a', 'now', 'now')").run();
    legacy.prepare("INSERT INTO runtime_actions (id, project_id, kind, input_json, result_json, created_at) VALUES ('legacy-action', 'p1', 'legacy_kind', '{}', '{}', 'now')").run();
    legacy.prepare("INSERT INTO runtime_confirmation_prompts (id, project_id, scope_id, prompt, status, created_at) VALUES ('legacy-prompt', 'p1', 'legacy', 'Confirm?', 'pending', 'now')").run();
    legacy.close();

    const database = new RuntimeDatabase(filename);
    expect(database.get<{ action_type: string; status: string; confirmation_requirement: string }>("SELECT action_type, status, confirmation_requirement FROM runtime_actions WHERE id = 'legacy-action'")).toEqual({
      action_type: "legacy_kind", status: "committed", confirmation_requirement: "none",
    });
    expect(database.get<{ prompt_type: string; related_artifact_ids_json: string; options_json: string }>("SELECT prompt_type, related_artifact_ids_json, options_json FROM runtime_confirmation_prompts WHERE id = 'legacy-prompt'")).toEqual({
      prompt_type: "branch_confirmation", related_artifact_ids_json: "[]", options_json: '["yes","no"]',
    });
    database.close();
  });

  it("persists constrained Failure Cases, occurrences, revisions, and validation results", async () => {
    const filename = await databasePath();
    const database = new RuntimeDatabase(filename);
    expect(database.all<{ name: string }>(`
      SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN ('failure_cases', 'failure_case_occurrences', 'failure_reproduction_revisions', 'reproduction_validation_results')
      ORDER BY name
    `)).toEqual([
      { name: "failure_case_occurrences" }, { name: "failure_cases" },
      { name: "failure_reproduction_revisions" }, { name: "reproduction_validation_results" },
    ]);
    database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/work/a', 'now', 'now')");
    database.run("INSERT INTO task_trees (id, project_id, title, status, current_revision_id, created_at, updated_at) VALUES ('t1', 'p1', 'Tree', 'confirmed', 'tr1', 'now', 'now')");
    database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES ('tr1', 't1', 1, '{}', 'now')");
    database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES ('n1', 't1', NULL, 'Node', 'failed')");
    database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES ('nr1', 'n1', 'tr1', '{}', 'now')");
    database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at, completed_at) VALUES ('a1', 'p1', 't1', 'n1', 'nr1', 1, 'failed', 'now', 'now')");
    database.run("INSERT INTO evaluations (id, project_id, tree_id, task_node_id, task_node_revision_id, execution_attempt_id, verdict, evidence_refs_json, covered_required_evidence_json, missing_required_evidence_json, risk_summary, created_at) VALUES ('e1', 'p1', 't1', 'n1', 'nr1', 'a1', 'failed', '[]', '[]', '[]', 'failure', 'now')");
    database.run("INSERT INTO failure_cases (id, project_id, tree_id, source_task_node_id, source_execution_attempt_id, source_evaluation_id, failure_goal, failure_signature, maturity_level, availability_status, related_artifact_ids_json, created_at, updated_at) VALUES ('f1', 'p1', 't1', 'n1', 'a1', 'e1', 'Make test pass', '{\"kind\":\"assertion\"}', 'L0_observed', 'active', '[]', 'now', 'now')");
    database.run("INSERT INTO failure_case_occurrences (id, project_id, failure_case_id, execution_attempt_id, evaluation_id, evidence_refs_json, created_at) VALUES ('o1', 'p1', 'f1', 'a1', 'e1', '[]', 'now')");
    database.run("INSERT INTO failure_reproduction_revisions (id, project_id, failure_case_id, revision_number, reproduction_mode, contract_json, validation_status, created_at) VALUES ('rr1', 'p1', 'f1', 1, 'observed', '{}', 'draft', 'now')");
    database.run("UPDATE failure_cases SET current_reproduction_revision_id = 'rr1' WHERE id = 'f1'");
    database.run("INSERT INTO reproduction_validation_results (id, project_id, failure_case_id, reproduction_revision_id, observation_json, pre_fix_verdict, post_fix_verdict, oracle_discrimination_verdict, repeat_stability_verdict, isolation_verdict, evidence_refs_json, maturity_promotion_verdict, idempotency_key, created_at) VALUES ('v1', 'p1', 'f1', 'rr1', '{}', 'not_run', 'not_run', 'not_run', 'not_run', 'not_run', '[]', 'L0_observed', 'validation-1', 'now')");
    expect(() => database.run("UPDATE failure_cases SET maturity_level = 'invalid' WHERE id = 'f1'")).toThrow();
    expect(() => database.run("INSERT INTO failure_reproduction_revisions (id, project_id, failure_case_id, revision_number, reproduction_mode, contract_json, validation_status, created_at) VALUES ('rr2', 'p1', 'f1', 1, 'manual', '{}', 'draft', 'now')")).toThrow();
    database.close();

    const reopened = new RuntimeDatabase(filename);
    expect(reopened.get<{ maturity_level: string; current_reproduction_revision_id: string }>(
      "SELECT maturity_level, current_reproduction_revision_id FROM failure_cases WHERE id = 'f1'",
    )).toEqual({ maturity_level: "L0_observed", current_reproduction_revision_id: "rr1" });
    expect(reopened.all("SELECT id FROM failure_case_occurrences WHERE failure_case_id = 'f1'")).toHaveLength(1);
    reopened.close();
  });
});
