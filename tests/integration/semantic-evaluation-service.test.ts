import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvaluationService } from "../../src/application/evaluation-service.js";
import { openRuntime } from "../../src/application/runtime.js";
import { SemanticEvaluationService, loadSemanticEvidenceSnapshot } from "../../src/application/semantic-evaluation-service.js";
import { HarnessError } from "../../src/domain/errors.js";
import { resolveJevConfiguration, type SemanticEvidenceSnapshot } from "../../src/domain/semantic-evaluation.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-semantic-evaluation-"));
  dirs.push(directory);
  const filename = path.join(directory, "runtime.db");
  const database = new RuntimeDatabase(filename);
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/work', '2026', '2026')");
  database.run("INSERT INTO task_trees (id, project_id, title, status, current_revision_id, created_at, updated_at) VALUES ('t1', 'p1', 'Repair login', 'confirmed', 'tr1', '2026', '2026')");
  database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES ('tr1', 't1', 1, '{}', '2026')");
  database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES ('n1', 't1', NULL, 'Repair login', 'verifying')");
  database.run(`
    INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at)
    VALUES ('nr1', 'n1', 'tr1', ?, '2026')
  `, JSON.stringify({
    id: "n1", parentId: null, title: "Repair login", children: [], objectives: ["Restore login"],
    acceptanceCriteria: ["login tests pass"], dependencies: [],
    requiredEvidence: [{ key: "test", description: "login test passes" }], executionPhase: "implementation",
  }));
  database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at) VALUES ('a1', 'p1', 't1', 'n1', 'nr1', 1, 'verifying', '2026')");
  database.run(`
    INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, execution_context_json, occurred_at, idempotency_key)
    VALUES ('trace-1', 'p1', 't1', 'n1', 'run', 'PostToolUse', ?, '{}', '2030', 'trace-1')
  `, JSON.stringify({
    sourceEvent: "PostToolUse", toolName: "Bash", toolInput: { command: "print super-secret source" },
    toolResponse: { ok: true, exitCode: 0, stdout: "super-secret source code" }, artifactRefs: ["artifact-1"],
  }));
  database.run("INSERT INTO execution_attempt_evidence (attempt_id, required_evidence_key, trace_event_id, created_at) VALUES ('a1', 'test', 'trace-1', '2030')");
  const config = resolveJevConfiguration({ HARNESS_JEV_ENABLED: "true", TYPESAFE_API_KEY: "api-key-must-not-persist" });
  return { directory, filename, database, config };
}

function passingProvider(onSnapshot?: (snapshot: SemanticEvidenceSnapshot) => void) {
  return {
    async evaluate(snapshot: SemanticEvidenceSnapshot) {
      onSnapshot?.(snapshot);
      return {
        model: "jev-1.13.0",
        answers: {
          evidence_0: {
            type: "choice" as const, choice: "supported" as const,
            probabilities: { supported: 0.91, unsupported: 0.04, insufficient_context: 0.05 }, confidence: 0.82,
          },
        },
        usage: { inputTokens: 120, outputTokens: 24 },
      };
    },
  };
}

describe("SemanticEvaluationService", () => {
  it("exposes misconfigured readiness without exposing the API key", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-semantic-runtime-"));
    dirs.push(directory);
    const projectDirectory = path.join(directory, "project");
    await import("node:fs/promises").then((fs) => fs.mkdir(projectDirectory));
    const runtime = openRuntime({
      AGENT_HARNESS_DATA_HOME: path.join(directory, "data"),
      HARNESS_JEV_ENABLED: "true",
    });
    try {
      const project = await runtime.projects.resolve(projectDirectory, "persist");
      const snapshot = runtime.queries.getRuntimeSnapshot(project.projectId);
      expect(snapshot.semanticEvaluation).toMatchObject({
        enabled: true, readiness: "misconfigured", provider: "typesafe_jev", model: "jev-1.13.0",
      });
      expect(JSON.stringify(snapshot)).not.toContain("apiKey");
    } finally {
      runtime.close();
    }
  });

  it("persists a bounded passed result and lets deterministic Evaluation reference it", async () => {
    const { filename, database, config } = await fixture();
    let sentSnapshot: SemanticEvidenceSnapshot | undefined;
    const service = new SemanticEvaluationService(database, config, passingProvider((snapshot) => { sentSnapshot = snapshot; }));
    const result = await service.evaluateAttempt("p1", "a1");
    if (!result.enabled) throw new Error("semantic evaluation was unexpectedly disabled");
    expect(result).toMatchObject({
      enabled: true, status: "passed", modelRequested: "jev-1.13.0", modelResolved: "jev-1.13.0",
      usage: { inputTokens: 120, outputTokens: 24 }, questionResults: [{ evidenceKey: "test", passed: true }],
    });
    expect(JSON.stringify(sentSnapshot)).not.toContain("super-secret");
    expect(sentSnapshot?.evidence[0]?.observations[0]).toEqual({
      traceEventId: "trace-1", eventName: "PostToolUse", sourceEvent: "PostToolUse", toolName: "Bash",
      artifactRefs: ["artifact-1"], outcome: { ok: true, exitCode: 0 },
    });
    const evaluation = new EvaluationService(database, undefined, undefined, { semanticEvaluationRequired: true })
      .evaluateAttempt({ projectId: "p1", attemptId: "a1", proposedVerdict: "succeeded", riskSummary: null });
    expect(evaluation.evaluation).toMatchObject({ verdict: "succeeded", semanticEvaluationResultId: result.resultId });
    expect(evaluation.transition).toMatchObject({ applied: true, targetStatus: "succeeded" });
    expect(JSON.stringify(database.all("SELECT * FROM semantic_evaluation_results"))).not.toContain("api-key-must-not-persist");
    database.close();

    const reopened = new RuntimeDatabase(filename);
    expect(new SemanticEvaluationService(reopened, config, passingProvider()).list("p1", "a1"))
      .toEqual([expect.objectContaining({ resultId: result.resultId, status: "passed" })]);
    reopened.close();
  });

  it("fails closed when the provider is unavailable and saves only a sanitized code", async () => {
    const { database, config } = await fixture();
    const service = new SemanticEvaluationService(database, config, {
      async evaluate() { throw new HarnessError("provider_authentication_failed", "response contained secret details"); },
    });
    const result = await service.evaluateAttempt("p1", "a1");
    if (!result.enabled) throw new Error("semantic evaluation was unexpectedly disabled");
    expect(result).toMatchObject({ status: "unavailable", errorCode: "provider_authentication_failed", usage: null });
    const evaluation = new EvaluationService(database, undefined, undefined, { semanticEvaluationRequired: true })
      .evaluateAttempt({ projectId: "p1", attemptId: "a1", proposedVerdict: "succeeded", riskSummary: null });
    expect(evaluation.evaluation).toMatchObject({ verdict: "uncertain", semanticEvaluationResultId: result.resultId });
    expect(evaluation.transition).toMatchObject({ applied: false, rejectionCode: "evaluation_uncertain" });
    expect(JSON.stringify(database.all("SELECT * FROM semantic_evaluation_results"))).not.toContain("secret details");
    database.close();
  });

  it("rejects a passed result after the evidence snapshot changes", async () => {
    const { database, config } = await fixture();
    const service = new SemanticEvaluationService(database, config, passingProvider());
    const result = await service.evaluateAttempt("p1", "a1");
    if (!result.enabled) throw new Error("semantic evaluation was unexpectedly disabled");
    database.run(`
      INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, execution_context_json, occurred_at, idempotency_key)
      VALUES ('trace-2', 'p1', 't1', 'n1', 'run', 'PostToolUseFailure', '{"sourceEvent":"PostToolUseFailure","toolName":"Bash","toolResponse":{"exitCode":1}}', '{}', '2031', 'trace-2')
    `);
    database.run("INSERT INTO execution_attempt_evidence (attempt_id, required_evidence_key, trace_event_id, created_at) VALUES ('a1', 'test', 'trace-2', '2031')");
    expect(loadSemanticEvidenceSnapshot(database, "p1", "a1").snapshotHash).not.toBe(result.snapshotHash);
    const evaluation = new EvaluationService(database, undefined, undefined, { semanticEvaluationRequired: true })
      .evaluateAttempt({ projectId: "p1", attemptId: "a1", proposedVerdict: "succeeded", riskSummary: null });
    expect(evaluation.evaluation).toMatchObject({ verdict: "uncertain", semanticEvaluationResultId: null });
    database.close();
  });
});
