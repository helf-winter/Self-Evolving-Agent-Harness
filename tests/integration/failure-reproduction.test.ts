import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FailureCaseService } from "../../src/application/failure-case-service.js";
import type { FailureReproductionContract, ReproductionValidationObservation } from "../../src/domain/failure-case.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-failure-reproduction-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/p1', 'now', 'now')");
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p2', '/p2', 'now', 'now')");
  database.run("INSERT INTO task_trees (id, project_id, title, status, current_revision_id, created_at, updated_at) VALUES ('t1', 'p1', 'Tree', 'confirmed', 'tr1', 'now', 'now')");
  database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES ('tr1', 't1', 1, '{}', 'now')");
  database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES ('n1', 't1', NULL, 'Fix endpoint', 'failed')");
  database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES ('nr1', 'n1', 'tr1', '{\"objectives\":[\"Make endpoint reliable\"]}', 'now')");
  database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at, completed_at) VALUES ('a1', 'p1', 't1', 'n1', 'nr1', 1, 'failed', 'now', 'now')");
  database.run("INSERT INTO evaluations (id, project_id, tree_id, task_node_id, task_node_revision_id, execution_attempt_id, verdict, evidence_refs_json, covered_required_evidence_json, missing_required_evidence_json, risk_summary, created_at) VALUES ('e1', 'p1', 't1', 'n1', 'nr1', 'a1', 'failed', '[\"trace-failure\"]', '[]', '[]', 'assertion mismatch', 'now')");
  database.run("INSERT INTO lifecycle_transition_records (id, evaluation_id, task_node_id, policy_version, from_status, target_status, applied, rejection_code, created_at) VALUES ('lt1', 'e1', 'n1', 'v1', 'verifying', 'failed', 1, NULL, 'now')");
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('trace-failure', 'p1', 't1', 'n1', 's', 'PostToolUse', '{}', 'now', 'trace-failure')");
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('trace-validation', 'p1', 't1', 'n1', 's', 'PostToolUse', '{}', 'later', 'trace-validation')");
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('trace-early', 'p1', 't1', 'n1', 's', 'PostToolUse', '{}', '2000-01-01', 'trace-early')");
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('foreign-trace', 'p2', NULL, NULL, 's', 'PostToolUse', '{}', 'later', 'foreign-trace')");
  const service = new FailureCaseService(database);
  const captured = service.captureFailedEvaluationWithinTransaction({ projectId: "p1", evaluationId: "e1" });
  return { database, service, failureCaseId: captured.failureCaseId };
}

function contract(mode: "manual" | "assisted" | "automated", postFixBaselineRef: string | null = null): FailureReproductionContract {
  return {
    mode, preconditions: ["dependencies installed"], environmentManifest: { node: "22", os: "linux" },
    sourceRevisionRef: "git:broken", fixtureRefs: ["fixture:minimal"], setupSteps: ["prepare fixture"],
    reproductionSteps: ["exercise endpoint"], cleanupSteps: ["delete fixture"],
    entryCommand: mode === "manual" ? null : "npm test -- failure.test.ts", timeoutMs: mode === "manual" ? null : 30_000,
    isolationStrategy: "temporary_directory", expectedResult: "test passes", actualFailure: "assertion mismatch",
    failureOracle: { kind: "exit_code", expression: "exitCode == 1" },
    expectedFailureSignature: mode === "manual" ? null : "AssertionError:endpoint",
    preFixBaselineRef: mode === "automated" ? "git:broken" : null, postFixBaselineRef,
    repeatPolicy: { runs: mode === "manual" ? 1 : 3, allowedFailures: 0 },
    automationCoverage: mode === "manual" ? 0 : mode === "assisted" ? 0.8 : 1,
    evidenceRefs: ["trace-failure"],
  };
}

function observation(overrides: Partial<ReproductionValidationObservation> = {}): ReproductionValidationObservation {
  return {
    preFixVerdict: "red", postFixVerdict: "not_run", oracleDiscriminationVerdict: "pass",
    repeatStabilityVerdict: "pass", isolationVerdict: "pass", evidenceRefs: ["trace-validation"], ...overrides,
  };
}

afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Failure Case reproduction lifecycle", () => {
  it("adds immutable revisions and promotes a validated manual reproduction to L1", async () => {
    const { database, service, failureCaseId } = await fixture();
    const first = service.addReproductionRevision({ projectId: "p1", failureCaseId, contract: contract("manual") });
    const secondContract = { ...contract("manual"), expectedResult: "endpoint returns normalized result" };
    const second = service.addReproductionRevision({ projectId: "p1", failureCaseId, contract: secondContract });
    expect([first.revisionNumber, second.revisionNumber]).toEqual([2, 3]);
    expect(JSON.parse(database.get<{ contract_json: string }>("SELECT contract_json FROM failure_reproduction_revisions WHERE id = ?", first.reproductionRevisionId)!.contract_json))
      .toMatchObject({ expectedResult: "test passes" });
    const validation = service.validateReproduction({
      projectId: "p1", failureCaseId, reproductionRevisionId: second.reproductionRevisionId,
      observation: observation(), idempotencyKey: "manual-validation",
    });
    expect(validation).toMatchObject({ promotedMaturity: "L1_manual", caseMaturity: "L1_manual" });
    expect(database.get<{ current_reproduction_revision_id: string }>("SELECT current_reproduction_revision_id FROM failure_cases WHERE id = ?", failureCaseId))
      .toEqual({ current_reproduction_revision_id: second.reproductionRevisionId });
    database.close();
  });

  it("progresses through L2 and L3 to L4 only after post-fix GREEN", async () => {
    const { database, service, failureCaseId } = await fixture();
    const assisted = service.addReproductionRevision({ projectId: "p1", failureCaseId, contract: contract("assisted") });
    expect(service.validateReproduction({
      projectId: "p1", failureCaseId, reproductionRevisionId: assisted.reproductionRevisionId,
      observation: observation(), idempotencyKey: "assisted-validation",
    }).caseMaturity).toBe("L2_assisted");
    const automated = service.addReproductionRevision({
      projectId: "p1", failureCaseId, contract: contract("automated", "git:fixed"),
    });
    expect(service.validateReproduction({
      projectId: "p1", failureCaseId, reproductionRevisionId: automated.reproductionRevisionId,
      observation: observation(), idempotencyKey: "automated-red-validation",
    }).caseMaturity).toBe("L3_automated");
    expect(service.validateReproduction({
      projectId: "p1", failureCaseId, reproductionRevisionId: automated.reproductionRevisionId,
      observation: observation({ postFixVerdict: "green" }), idempotencyKey: "automated-green-validation",
    }).caseMaturity).toBe("L4_regression");
    expect(database.all("SELECT id FROM reproduction_validation_results WHERE failure_case_id = ?", failureCaseId)).toHaveLength(3);
    database.close();
  });

  it("enforces Project-scoped evidence and validation idempotence", async () => {
    const { database, service, failureCaseId } = await fixture();
    expect(() => service.addReproductionRevision({
      projectId: "p1", failureCaseId, contract: { ...contract("manual"), evidenceRefs: ["foreign-trace"] },
    })).toThrow(expect.objectContaining({ code: "evidence_scope_mismatch" }));
    expect(() => service.addReproductionRevision({ projectId: "p2", failureCaseId, contract: contract("manual") }))
      .toThrow(expect.objectContaining({ code: "not_found" }));
    const revision = service.addReproductionRevision({ projectId: "p1", failureCaseId, contract: contract("manual") });
    expect(() => service.validateReproduction({
      projectId: "p1", failureCaseId, reproductionRevisionId: revision.reproductionRevisionId,
      observation: observation({ evidenceRefs: ["trace-early"] }), idempotencyKey: "early-validation",
    })).toThrow(expect.objectContaining({ code: "evidence_scope_mismatch" }));
    const first = service.validateReproduction({
      projectId: "p1", failureCaseId, reproductionRevisionId: revision.reproductionRevisionId,
      observation: observation(), idempotencyKey: "same-validation",
    });
    expect(service.validateReproduction({
      projectId: "p1", failureCaseId, reproductionRevisionId: revision.reproductionRevisionId,
      observation: observation(), idempotencyKey: "same-validation",
    })).toEqual(first);
    expect(() => service.validateReproduction({
      projectId: "p1", failureCaseId, reproductionRevisionId: revision.reproductionRevisionId,
      observation: observation({ preFixVerdict: "not_red" }), idempotencyKey: "same-validation",
    })).toThrow(expect.objectContaining({ code: "reproduction_validation_rejected" }));
    database.close();
  });

  it("keeps maturity monotonic while availability changes independently", async () => {
    const { database, service, failureCaseId } = await fixture();
    const automated = service.addReproductionRevision({ projectId: "p1", failureCaseId, contract: contract("automated", "git:fixed") });
    service.validateReproduction({
      projectId: "p1", failureCaseId, reproductionRevisionId: automated.reproductionRevisionId,
      observation: observation({ postFixVerdict: "green" }), idempotencyKey: "l4",
    });
    const manual = service.addReproductionRevision({ projectId: "p1", failureCaseId, contract: contract("manual") });
    expect(service.validateReproduction({
      projectId: "p1", failureCaseId, reproductionRevisionId: manual.reproductionRevisionId,
      observation: observation(), idempotencyKey: "later-manual",
    }).caseMaturity).toBe("L4_regression");
    expect(service.setAvailability({ projectId: "p1", failureCaseId, availabilityStatus: "flaky" }))
      .toMatchObject({ maturityLevel: "L4_regression", availabilityStatus: "flaky" });
    database.close();
  });
});
