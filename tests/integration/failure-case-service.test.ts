import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FailureCaseService } from "../../src/application/failure-case-service.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-failure-case-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/p1', 'now', 'now')");
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p2', '/p2', 'now', 'now')");
  database.run("INSERT INTO task_trees (id, project_id, title, status, current_revision_id, created_at, updated_at) VALUES ('t1', 'p1', 'Tree', 'confirmed', 'tr1', 'now', 'now')");
  database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES ('tr1', 't1', 1, '{}', 'now')");
  database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES ('n1', 't1', NULL, 'Fix endpoint', 'failed')");
  database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES ('nr1', 'n1', 'tr1', ?, 'now')", JSON.stringify({ objectives: ["Make endpoint reliable"] }));
  return { database, service: new FailureCaseService(database) };
}

function addEvaluation(database: RuntimeDatabase, suffix: string, verdict = "failed", applied = 1) {
  const attemptId = `attempt-${suffix}`;
  const evaluationId = `evaluation-${suffix}`;
  database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at, completed_at) VALUES (?, 'p1', 't1', 'n1', 'nr1', ?, ?, 'now', 'now')", attemptId, Number(suffix.replace(/\D/g, "")) || 1, verdict === "failed" ? "failed" : "succeeded");
  database.run("INSERT INTO evaluations (id, project_id, tree_id, task_node_id, task_node_revision_id, execution_attempt_id, verdict, evidence_refs_json, covered_required_evidence_json, missing_required_evidence_json, risk_summary, created_at) VALUES (?, 'p1', 't1', 'n1', 'nr1', ?, ?, '[\"trace-failure\"]', '[]', '[]', 'same assertion mismatch', 'now')", evaluationId, attemptId, verdict);
  database.run("INSERT INTO lifecycle_transition_records (id, evaluation_id, task_node_id, policy_version, from_status, target_status, applied, rejection_code, created_at) VALUES (?, ?, 'n1', 'v1', 'verifying', ?, ?, NULL, 'now')", `transition-${suffix}`, evaluationId, verdict, applied);
  return { attemptId, evaluationId };
}

afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("FailureCaseService automatic L0 capture", () => {
  it("deduplicates a structured failure while preserving every occurrence", async () => {
    const { database, service } = await fixture();
    const first = addEvaluation(database, "1");
    const second = addEvaluation(database, "2");
    const captured = service.captureFailedEvaluationWithinTransaction({ projectId: "p1", evaluationId: first.evaluationId });
    const repeated = service.captureFailedEvaluationWithinTransaction({ projectId: "p1", evaluationId: second.evaluationId });
    expect(repeated.failureCaseId).toBe(captured.failureCaseId);
    expect(database.all("SELECT id FROM failure_cases WHERE project_id = 'p1'")).toHaveLength(1);
    expect(database.all("SELECT id FROM failure_case_occurrences WHERE failure_case_id = ?", captured.failureCaseId)).toHaveLength(2);
    expect(database.all("SELECT id FROM failure_reproduction_revisions WHERE failure_case_id = ?", captured.failureCaseId)).toHaveLength(1);
    expect(service.captureFailedEvaluationWithinTransaction({ projectId: "p1", evaluationId: first.evaluationId }))
      .toMatchObject({ failureCaseId: captured.failureCaseId, occurrenceId: captured.occurrenceId, created: false });
    database.close();
  });

  it("rejects nonfailed, unapplied, and foreign Evaluation facts", async () => {
    const { database, service } = await fixture();
    const succeeded = addEvaluation(database, "3", "succeeded", 1);
    const unapplied = addEvaluation(database, "4", "failed", 0);
    expect(() => service.captureFailedEvaluationWithinTransaction({ projectId: "p1", evaluationId: succeeded.evaluationId }))
      .toThrow(expect.objectContaining({ code: "failure_case_invalid" }));
    expect(() => service.captureFailedEvaluationWithinTransaction({ projectId: "p1", evaluationId: unapplied.evaluationId }))
      .toThrow(expect.objectContaining({ code: "failure_case_invalid" }));
    expect(() => service.captureFailedEvaluationWithinTransaction({ projectId: "p2", evaluationId: unapplied.evaluationId }))
      .toThrow(expect.objectContaining({ code: "not_found" }));
    database.close();
  });
});
