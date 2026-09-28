import { HarnessError } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
import {
  aggregateSemanticAnswers,
  semanticSnapshotHash,
  type JevConfiguration,
  type SemanticEvidenceObservation,
  type SemanticEvidenceSnapshot,
  type SemanticEvaluationStatus,
} from "../domain/semantic-evaluation.js";
import type { TaskNodeInput } from "../domain/task-tree.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";
import type { JevEvaluationProvider } from "../bindings/typesafe/jev-evaluation-provider.js";

interface SemanticAttemptRow {
  id: string;
  project_id: string;
  tree_id: string;
  task_node_id: string;
  task_node_revision_id: string;
  status: string;
  body_json: string;
}

interface SemanticResultRow {
  id: string;
  project_id: string;
  tree_id: string;
  task_node_id: string;
  task_node_revision_id: string;
  execution_attempt_id: string;
  provider: string;
  status: SemanticEvaluationStatus;
  model_requested: string;
  model_resolved: string | null;
  snapshot_hash: string;
  question_results_json: string;
  thresholds_json: string;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number;
  error_code: string | null;
  created_at: string;
}

function safeToken(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,80}$/.test(value) ? value : null;
}

function safeObservation(row: { trace_event_id: string; event_name: string; payload_json: string }): SemanticEvidenceObservation {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  const response = payload.toolResponse && typeof payload.toolResponse === "object"
    ? payload.toolResponse as Record<string, unknown>
    : {};
  const outcome: SemanticEvidenceObservation["outcome"] = {};
  if (typeof response.ok === "boolean") outcome.ok = response.ok;
  if (typeof response.exitCode === "number" && Number.isFinite(response.exitCode)) outcome.exitCode = response.exitCode;
  const status = safeToken(response.status);
  if (status) outcome.status = status;
  const artifactRefs = Array.isArray(payload.artifactRefs)
    ? payload.artifactRefs.filter((value): value is string => typeof value === "string").slice(0, 20)
    : [];
  return {
    traceEventId: row.trace_event_id,
    eventName: row.event_name,
    sourceEvent: safeToken(payload.sourceEvent),
    toolName: safeToken(payload.toolName),
    artifactRefs,
    outcome,
  };
}

export function loadSemanticEvidenceSnapshot(database: RuntimeDatabase, projectId: string, attemptId: string): {
  attempt: SemanticAttemptRow;
  snapshot: SemanticEvidenceSnapshot;
  snapshotHash: string;
} {
  const attempt = database.get<SemanticAttemptRow>(`
    SELECT a.id, a.project_id, a.tree_id, a.task_node_id, a.task_node_revision_id, a.status, nr.body_json
    FROM execution_attempts a
    JOIN task_node_revisions nr ON nr.id = a.task_node_revision_id
    WHERE a.id = ? AND a.project_id = ?
  `, attemptId, projectId);
  if (!attempt) throw new HarnessError("not_found", "Execution Attempt was not found in this Project");
  const body = JSON.parse(attempt.body_json) as TaskNodeInput;
  const rows = database.all<{
    required_evidence_key: string; trace_event_id: string; event_name: string; payload_json: string;
  }>(`
    SELECT ae.required_evidence_key, ae.trace_event_id, t.event_name, t.payload_json
    FROM execution_attempt_evidence ae
    JOIN trace_events t ON t.id = ae.trace_event_id
    WHERE ae.attempt_id = ?
    ORDER BY ae.required_evidence_key, ae.created_at, ae.trace_event_id
  `, attemptId);
  const observations = new Map<string, SemanticEvidenceObservation[]>();
  for (const row of rows) {
    const values = observations.get(row.required_evidence_key) ?? [];
    values.push(safeObservation(row));
    observations.set(row.required_evidence_key, values);
  }
  const snapshot: SemanticEvidenceSnapshot = {
    schemaVersion: 1,
    task: {
      title: body.title ?? "",
      objectives: body.objectives ?? [],
      acceptanceCriteria: body.acceptanceCriteria ?? [],
    },
    evidence: (body.requiredEvidence ?? []).map((item) => ({
      key: item.key,
      description: item.description,
      observations: observations.get(item.key) ?? [],
    })),
  };
  return { attempt, snapshot, snapshotHash: semanticSnapshotHash(snapshot) };
}

export class SemanticEvaluationService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly config: JevConfiguration,
    private readonly provider: Pick<JevEvaluationProvider, "evaluate">,
  ) {}

  configuration() {
    return {
      enabled: this.config.enabled,
      readiness: this.config.readiness,
      provider: "typesafe_jev",
      model: this.config.model,
      timeoutMs: this.config.timeoutMs,
      minProbability: this.config.minProbability,
      minConfidence: this.config.minConfidence,
    };
  }

  async evaluateAttempt(projectId: string, attemptId: string) {
    if (!this.config.enabled) return { enabled: false as const, configuration: this.configuration() };
    const { attempt, snapshot, snapshotHash } = loadSemanticEvidenceSnapshot(this.database, projectId, attemptId);
    if (attempt.status !== "verifying") {
      throw new HarnessError("evaluation_not_applicable", "semantic evaluation requires a verifying Execution Attempt");
    }
    const startedAt = Date.now();
    let status: SemanticEvaluationStatus = "review";
    let modelResolved: string | null = null;
    let questionResults: unknown[] = [];
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let errorCode: string | null = snapshot.evidence.length ? null : "no_required_evidence";
    if (snapshot.evidence.length) {
      try {
        const response = await this.provider.evaluate(snapshot);
        const aggregate = aggregateSemanticAnswers({
          snapshot,
          answers: response.answers,
          minProbability: this.config.minProbability,
          minConfidence: this.config.minConfidence,
        });
        status = aggregate.status;
        modelResolved = response.model;
        questionResults = aggregate.results;
        inputTokens = response.usage.inputTokens;
        outputTokens = response.usage.outputTokens;
      } catch (error) {
        status = "unavailable";
        errorCode = error instanceof HarnessError ? error.code : "provider_failed";
      }
    }
    const resultId = newId();
    const createdAt = nowIso();
    const latencyMs = Math.max(0, Date.now() - startedAt);
    this.database.run(`
      INSERT INTO semantic_evaluation_results (
        id, project_id, tree_id, task_node_id, task_node_revision_id, execution_attempt_id,
        provider, status, model_requested, model_resolved, snapshot_hash, question_results_json,
        thresholds_json, input_tokens, output_tokens, latency_ms, error_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'typesafe_jev', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, resultId, attempt.project_id, attempt.tree_id, attempt.task_node_id, attempt.task_node_revision_id,
    attempt.id, status, this.config.model, modelResolved, snapshotHash, canonicalJson(questionResults),
    canonicalJson({ minProbability: this.config.minProbability, minConfidence: this.config.minConfidence }),
    inputTokens, outputTokens, latencyMs, errorCode, createdAt);
    return this.mapResult(this.requireResult(projectId, resultId));
  }

  list(projectId: string, attemptId?: string) {
    if (!this.database.get("SELECT id FROM projects WHERE id = ?", projectId)) throw new HarnessError("not_found", "Project was not found");
    return this.database.all<SemanticResultRow>(`
      SELECT * FROM semantic_evaluation_results
      WHERE project_id = ? AND (? IS NULL OR execution_attempt_id = ?)
      ORDER BY created_at DESC, id DESC
    `, projectId, attemptId ?? null, attemptId ?? null).map((row) => this.mapResult(row));
  }

  private requireResult(projectId: string, resultId: string): SemanticResultRow {
    const row = this.database.get<SemanticResultRow>(
      "SELECT * FROM semantic_evaluation_results WHERE id = ? AND project_id = ?", resultId, projectId,
    );
    if (!row) throw new HarnessError("not_found", "Semantic Evaluation Result was not found in this Project");
    return row;
  }

  private mapResult(row: SemanticResultRow) {
    return {
      enabled: true as const,
      resultId: row.id,
      projectId: row.project_id,
      treeId: row.tree_id,
      nodeId: row.task_node_id,
      nodeRevisionId: row.task_node_revision_id,
      attemptId: row.execution_attempt_id,
      provider: row.provider,
      status: row.status,
      modelRequested: row.model_requested,
      modelResolved: row.model_resolved,
      snapshotHash: row.snapshot_hash,
      questionResults: JSON.parse(row.question_results_json) as unknown[],
      thresholds: JSON.parse(row.thresholds_json) as Record<string, number>,
      usage: row.input_tokens === null ? null : { inputTokens: row.input_tokens, outputTokens: row.output_tokens ?? 0 },
      latencyMs: row.latency_ms,
      errorCode: row.error_code,
      createdAt: row.created_at,
    };
  }
}
