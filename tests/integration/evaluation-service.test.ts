import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvaluationService } from "../../src/application/evaluation-service.js";
import { NodeExecutionService } from "../../src/application/node-execution-service.js";
import { PlanDriftService } from "../../src/application/plan-drift-service.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-evaluation-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES (?, ?, ?, ?)", "p1", "/a", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  database.run("INSERT INTO task_trees (id, project_id, title, status, current_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", "t1", "p1", "Tree", "confirmed", "tr1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES (?, ?, ?, ?, ?)", "tr1", "t1", 1, "{}", "2026-01-01T00:00:00.000Z");
  database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES (?, ?, ?, ?, ?)", "n1", "t1", null, "Implement", "ready");
  database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES (?, ?, ?, ?, ?)", "n1-r1", "n1", "tr1", JSON.stringify({ id: "n1", executionPhase: "implementation", dependencies: [], requiredEvidence: [{ key: "test", description: "tests pass" }] }), "2026-01-01T00:00:00.000Z");
  database.run("INSERT INTO task_node_confirmation_states (project_id, tree_id, tree_revision_id, task_node_id, state, updated_at) VALUES ('p1', 't1', 'tr1', 'n1', 'confirmed', '2026-01-01T00:00:00.000Z')");
  database.run("INSERT INTO workflow_states (id, project_id, tree_id, stage, revision, active, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)", "w1", "p1", "t1", "branch_implementation", 1, "2026-01-01T00:00:00.000Z");
  const executions = new NodeExecutionService(database);
  const evaluations = new EvaluationService(database);
  return { database, executions, evaluations };
}

function startVerifying(executions: NodeExecutionService) {
  const attempt = executions.startAttempt({ projectId: "p1", nodeId: "n1", expectedTreeRevisionId: "tr1" });
  return executions.beginVerification({ projectId: "p1", attemptId: attempt.attemptId, expectedStatus: "running" });
}

function addEvidence(database: RuntimeDatabase, executions: NodeExecutionService, attemptId: string, id: string) {
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)", id, "p1", "t1", "n1", "s", "PostToolUse", "2030-01-01T00:00:00.000Z", id);
  executions.attachEvidence({ projectId: "p1", attemptId, requiredEvidenceKey: "test", traceEventId: id });
}

afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("EvaluationService", () => {
  it("normalizes a proposed success with missing evidence to uncertain", async () => {
    const { database, executions, evaluations } = await fixture();
    const attempt = startVerifying(executions);
    const result = evaluations.evaluateAttempt({ projectId: "p1", attemptId: attempt.attemptId, proposedVerdict: "succeeded", riskSummary: null });
    expect(result.evaluation).toMatchObject({ verdict: "uncertain", coveredRequiredEvidence: [], missingRequiredEvidence: ["test"] });
    expect(result.transition).toMatchObject({ applied: false, targetStatus: "verifying" });
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = 'n1'")).toEqual({ status: "verifying" });
    database.close();
  });

  it("preserves failed, failed, succeeded attempt and evaluation history", async () => {
    const { database, executions, evaluations } = await fixture();
    for (const index of [1, 2]) {
      const attempt = startVerifying(executions);
      const result = evaluations.evaluateAttempt({ projectId: "p1", attemptId: attempt.attemptId, proposedVerdict: "failed", riskSummary: `failure ${index}` });
      expect(result.transition).toMatchObject({ applied: true, targetStatus: "failed" });
    }
    const attempt = startVerifying(executions);
    addEvidence(database, executions, attempt.attemptId, "success-evidence");
    const result = evaluations.evaluateAttempt({ projectId: "p1", attemptId: attempt.attemptId, proposedVerdict: "succeeded", riskSummary: null });
    expect(result.transition).toMatchObject({ applied: true, targetStatus: "succeeded" });
    expect(database.all<{ verdict: string }>("SELECT verdict FROM evaluations WHERE task_node_id = 'n1' ORDER BY created_at, rowid").map((row) => row.verdict)).toEqual(["failed", "failed", "succeeded"]);
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = 'n1'")).toEqual({ status: "succeeded" });
    database.close();
  });

  it("records a stale evaluation without succeeding the current node revision", async () => {
    const { database, executions, evaluations } = await fixture();
    const attempt = startVerifying(executions);
    addEvidence(database, executions, attempt.attemptId, "stale-evidence");
    database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES (?, ?, ?, ?, ?)", "tr2", "t1", 2, "{}", "2031-01-01T00:00:00.000Z");
    database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES (?, ?, ?, ?, ?)", "n1-r2", "n1", "tr2", JSON.stringify({ id: "n1", executionPhase: "implementation", dependencies: [], requiredEvidence: [{ key: "test", description: "tests pass" }] }), "2031-01-01T00:00:00.000Z");
    database.run("UPDATE task_trees SET current_revision_id = 'tr2' WHERE id = 't1'");

    const result = evaluations.evaluateAttempt({ projectId: "p1", attemptId: attempt.attemptId, proposedVerdict: "succeeded", riskSummary: null });
    expect(result.transition).toMatchObject({ applied: false, targetStatus: "needs_revalidation", rejectionCode: "stale_revision" });
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = 'n1'")).toEqual({ status: "needs_revalidation" });
    expect(database.get<{ status: string }>("SELECT status FROM execution_attempts WHERE id = ?", attempt.attemptId)).toEqual({ status: "aborted" });
    database.close();
  });

  it("requires a parent's children to succeed in addition to its own evidence", async () => {
    const { database, executions, evaluations } = await fixture();
    database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES (?, ?, ?, ?, ?)", "child", "t1", "n1", "Child", "failed");
    database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES (?, ?, ?, ?, ?)", "child-r1", "child", "tr1", JSON.stringify({ id: "child", executionPhase: "implementation", dependencies: [], requiredEvidence: [{ key: "child-test", description: "child tests" }] }), "2026-01-01T00:00:00.000Z");
    const attempt = startVerifying(executions);
    addEvidence(database, executions, attempt.attemptId, "parent-evidence");
    const result = evaluations.evaluateAttempt({ projectId: "p1", attemptId: attempt.attemptId, proposedVerdict: "succeeded", riskSummary: "child remains failed" });
    expect(result.evaluation.verdict).toBe("uncertain");
    expect(result.transition).toMatchObject({ applied: false, targetStatus: "verifying" });
    database.close();
  });

  it("ignores children that do not exist in the current Task Tree revision", async () => {
    const { database, executions, evaluations } = await fixture();
    database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES (?, ?, ?, ?, ?)", "tr0", "t1", 0, "{}", "2025-01-01T00:00:00.000Z");
    database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES (?, ?, ?, ?, ?)", "removed-child", "t1", "n1", "Removed", "failed");
    database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES (?, ?, ?, ?, ?)", "removed-child-r0", "removed-child", "tr0", "{}", "2025-01-01T00:00:00.000Z");
    const attempt = startVerifying(executions);
    addEvidence(database, executions, attempt.attemptId, "current-evidence");
    expect(evaluations.evaluateAttempt({ projectId: "p1", attemptId: attempt.attemptId, proposedVerdict: "succeeded", riskSummary: null }).transition).toMatchObject({ applied: true, targetStatus: "succeeded" });
    database.close();
  });

  it("records success as uncertain while a blocking Plan Drift is unresolved", async () => {
    const { database, executions, evaluations } = await fixture();
    const attempt = startVerifying(executions);
    addEvidence(database, executions, attempt.attemptId, "blocked-evidence");
    new PlanDriftService(database).recordDrift({
      projectId: "p1",
      treeId: "t1",
      nodeId: "n1",
      driftType: "responsibility_changed",
      severity: "blocking",
      description: "The implementation crossed its confirmed responsibility boundary",
      explanation: "The active Task Node no longer matches the confirmed plan",
      recommendation: "Refine and reconfirm the affected branch",
    });

    const result = evaluations.evaluateAttempt({
      projectId: "p1",
      attemptId: attempt.attemptId,
      proposedVerdict: "succeeded",
      riskSummary: null,
    });

    expect(result.evaluation.verdict).toBe("uncertain");
    expect(result.transition).toMatchObject({ applied: false, targetStatus: "blocked", rejectionCode: "blocking_drift" });
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = 'n1'")).toEqual({ status: "blocked" });
    expect(database.get<{ status: string }>("SELECT status FROM execution_attempts WHERE id = ?", attempt.attemptId)).toEqual({ status: "blocked" });
    database.close();
  });
});
