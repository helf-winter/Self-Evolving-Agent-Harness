import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvolutionService } from "../../src/application/evolution-service.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-evolution-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/p1', 'now', 'now')");
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p2', '/p2', 'now', 'now')");
  database.run("INSERT INTO task_trees (id, project_id, title, status, current_revision_id, created_at, updated_at) VALUES ('t1', 'p1', 'Tree', 'confirmed', 'tr1', 'now', 'now')");
  database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES ('tr1', 't1', 1, '{}', 'now')");
  database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES ('n1', 't1', NULL, 'Repair endpoint', 'succeeded')");
  database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES ('nr1', 'n1', 'tr1', '{\"objectives\":[\"Repair endpoint\"],\"executionPhase\":\"implementation\"}', 'now')");
  return { database, service: new EvolutionService(database) };
}

function addEvaluation(database: RuntimeDatabase, sequence: number, verdict: "failed" | "succeeded", applied = 1) {
  const attemptId = `a${sequence}`;
  const evaluationId = `e${sequence}`;
  database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at, completed_at) VALUES (?, 'p1', 't1', 'n1', 'nr1', ?, ?, ?, ?)", attemptId, sequence, verdict, `2026-01-0${sequence}`, `2026-01-0${sequence}`);
  database.run("INSERT INTO evaluations (id, project_id, tree_id, task_node_id, task_node_revision_id, execution_attempt_id, verdict, evidence_refs_json, covered_required_evidence_json, missing_required_evidence_json, risk_summary, created_at) VALUES (?, 'p1', 't1', 'n1', 'nr1', ?, ?, ?, '[]', '[]', '', ?)", evaluationId, attemptId, verdict, JSON.stringify([`trace-${sequence}`]), `2026-01-0${sequence}`);
  database.run("INSERT INTO lifecycle_transition_records (id, evaluation_id, task_node_id, policy_version, from_status, target_status, applied, rejection_code, created_at) VALUES (?, ?, 'n1', 'v1', 'verifying', ?, ?, NULL, ?)", `lt${sequence}`, evaluationId, verdict, applied, `2026-01-0${sequence}`);
  return { attemptId, evaluationId };
}

afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("EvolutionService Experience and candidate lifecycle", () => {
  it("creates one eligible Experience only after two applied failures and a success", async () => {
    const { database, service } = await fixture();
    addEvaluation(database, 1, "failed");
    const premature = addEvaluation(database, 2, "succeeded");
    expect(service.captureEligibleExperienceWithinTransaction({ projectId: "p1", successEvaluationId: premature.evaluationId }))
      .toMatchObject({ eligible: false, reason: "insufficient_failures" });
    database.run("DELETE FROM lifecycle_transition_records WHERE evaluation_id = 'e2'");
    database.run("DELETE FROM evaluations WHERE id = 'e2'");
    database.run("DELETE FROM execution_attempts WHERE id = 'a2'");
    addEvaluation(database, 2, "failed");
    const success = addEvaluation(database, 3, "succeeded");
    const captured = service.captureEligibleExperienceWithinTransaction({ projectId: "p1", successEvaluationId: success.evaluationId });
    expect(captured).toMatchObject({ eligible: true, created: true, failureEvaluationIds: ["e1", "e2"], successEvaluationId: "e3" });
    expect(service.captureEligibleExperienceWithinTransaction({ projectId: "p1", successEvaluationId: success.evaluationId }))
      .toMatchObject({ eligible: true, created: false, experienceId: captured.eligible ? captured.experienceId : "missing" });
    expect(database.all("SELECT id FROM experiences")).toHaveLength(1);
    database.close();
  });

  it("freezes immutable candidate revisions and reuses exact proposals", async () => {
    const { database, service } = await fixture();
    addEvaluation(database, 1, "failed"); addEvaluation(database, 2, "failed");
    const success = addEvaluation(database, 3, "succeeded");
    const experience = service.captureEligibleExperienceWithinTransaction({ projectId: "p1", successEvaluationId: success.evaluationId });
    if (!experience.eligible) throw new Error("experience was not eligible");
    const first = service.freezeSkillCandidate({
      projectId: "p1", experienceId: experience.experienceId, stableKey: "endpoint-repair",
      name: "Endpoint repair", triggerContext: { taskType: "typescript-test-failure" },
      instructionSnapshot: "Reproduce the focused failure before changing implementation.",
    });
    expect(first).toMatchObject({ revisionNumber: 1, validationStatus: "frozen", created: true });
    expect(service.freezeSkillCandidate({
      projectId: "p1", experienceId: experience.experienceId, stableKey: "endpoint-repair",
      name: "Endpoint repair", triggerContext: { taskType: "typescript-test-failure" },
      instructionSnapshot: "Reproduce the focused failure before changing implementation.",
    })).toMatchObject({ candidateRevisionId: first.candidateRevisionId, created: false });
    const second = service.freezeSkillCandidate({
      projectId: "p1", experienceId: experience.experienceId, stableKey: "endpoint-repair",
      name: "Endpoint repair", triggerContext: { taskType: "typescript-test-failure" },
      instructionSnapshot: "Reproduce the failure, isolate the cause, then verify the focused fix.",
    });
    expect(second.revisionNumber).toBe(2);
    expect(database.get<{ instruction_snapshot: string }>("SELECT instruction_snapshot FROM skill_candidate_revisions WHERE id = ?", first.candidateRevisionId))
      .toEqual({ instruction_snapshot: "Reproduce the focused failure before changing implementation." });
    expect(() => service.freezeSkillCandidate({
      projectId: "p2", experienceId: experience.experienceId, stableKey: "foreign",
      name: "Foreign", triggerContext: {}, instructionSnapshot: "Do work",
    })).toThrow(expect.objectContaining({ code: "not_found" }));
    database.close();
  });
});
