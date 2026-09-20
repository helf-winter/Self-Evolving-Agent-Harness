import { HarnessError } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";

export type PlanDriftType =
  | "missing_planned_artifact"
  | "unexpected_artifact"
  | "artifact_replaced"
  | "responsibility_changed"
  | "relation_changed";
export type PlanDriftSeverity = "info" | "warning" | "blocking";
export type PlanDriftResolutionStatus = "pending_user_confirmation" | "accepted" | "rejected" | "branch_cancelled" | "recorded";

export interface RecordPlanDriftInput {
  projectId: string;
  treeId: string;
  nodeId?: string | null;
  plannedArtifactId?: string | null;
  actualArtifactId?: string | null;
  driftType: PlanDriftType;
  severity: PlanDriftSeverity;
  description: string;
  explanation: string;
  recommendation?: string | null;
  sourceTraceEventId?: string | null;
}

export interface PlanDriftView {
  driftId: string;
  traceEventId: string;
  projectId: string;
  treeId: string;
  nodeId: string | null;
  plannedArtifactId: string | null;
  actualArtifactId: string | null;
  driftType: PlanDriftType;
  severity: PlanDriftSeverity;
  description: string;
  explanation: string;
  recommendation: string | null;
  resolutionStatus: PlanDriftResolutionStatus;
  createdAt: string;
}

const driftTypes = new Set<PlanDriftType>([
  "missing_planned_artifact", "unexpected_artifact", "artifact_replaced", "responsibility_changed", "relation_changed",
]);
const severities = new Set<PlanDriftSeverity>(["info", "warning", "blocking"]);

export class PlanDriftService {
  constructor(private readonly database: RuntimeDatabase) {}

  recordDrift(input: RecordPlanDriftInput): PlanDriftView {
    return this.database.transaction(() => this.recordDriftWithinTransaction(input));
  }

  recordDriftWithinTransaction(input: RecordPlanDriftInput): PlanDriftView {
    this.validate(input);
    const driftId = newId();
    const traceEventId = newId();
    const createdAt = nowIso();
    const nodeId = input.nodeId ?? null;
    const plannedArtifactId = input.plannedArtifactId ?? null;
    const actualArtifactId = input.actualArtifactId ?? null;
    const recommendation = input.recommendation?.trim() || null;
    const resolutionStatus: PlanDriftResolutionStatus = input.severity === "blocking" ? "pending_user_confirmation" : "recorded";
    const sourceTrace = input.sourceTraceEventId
      ? this.database.get<{ id: string; session_id: string; project_id: string; tree_id: string | null }>(
          "SELECT id, session_id, project_id, tree_id FROM trace_events WHERE id = ?",
          input.sourceTraceEventId,
        )
      : undefined;
    if (input.sourceTraceEventId && (!sourceTrace || sourceTrace.project_id !== input.projectId || sourceTrace.tree_id !== input.treeId)) {
      throw new HarnessError("invalid_input", "source Trace Event must belong to the same Project and Task Tree");
    }
    const idempotencyKey = input.sourceTraceEventId
      ? `plan-drift:${input.sourceTraceEventId}:${nodeId ?? "tree"}:${actualArtifactId ?? plannedArtifactId ?? input.driftType}`
      : `plan-drift:${driftId}`;
    const payload = {
      driftId,
      driftType: input.driftType,
      severity: input.severity,
      description: input.description.trim(),
      explanation: input.explanation.trim(),
      recommendation,
      plannedArtifactId,
      actualArtifactId,
      ...(input.sourceTraceEventId ? { sourceTraceEventId: input.sourceTraceEventId } : {}),
    };

    this.database.run(
      `INSERT INTO trace_events (
         id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key
       ) VALUES (?, ?, ?, ?, ?, 'plan_drift', ?, ?, ?)`,
      traceEventId, input.projectId, input.treeId, nodeId, sourceTrace?.session_id ?? "harness-runtime",
      canonicalJson(payload), createdAt, idempotencyKey,
    );
    this.database.run(
      `INSERT INTO plan_drift_records (
         id, project_id, tree_id, task_node_id, planned_artifact_id, actual_artifact_id,
         drift_type, severity, trace_event_id, drift_explanation, agent_recommendation,
         resolution_status, user_decision, description, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      driftId, input.projectId, input.treeId, nodeId, plannedArtifactId, actualArtifactId,
      input.driftType, input.severity, traceEventId, input.explanation.trim(), recommendation,
      resolutionStatus, input.description.trim(), createdAt,
    );

    if (input.severity === "blocking") {
      this.database.run("UPDATE task_nodes SET status = 'blocked' WHERE id = ? AND tree_id = ?", nodeId, input.treeId);
      this.database.run(
        "UPDATE execution_attempts SET status = 'blocked', completed_at = ? WHERE task_node_id = ? AND tree_id = ? AND status IN ('running', 'verifying')",
        createdAt, nodeId, input.treeId,
      );
    }

    return {
      driftId, traceEventId, projectId: input.projectId, treeId: input.treeId, nodeId,
      plannedArtifactId, actualArtifactId, driftType: input.driftType, severity: input.severity,
      description: input.description.trim(), explanation: input.explanation.trim(), recommendation,
      resolutionStatus, createdAt,
    };
  }

  private validate(input: RecordPlanDriftInput): void {
    if (!driftTypes.has(input.driftType) || !severities.has(input.severity)) {
      throw new HarnessError("invalid_input", "unsupported Plan Drift type or severity");
    }
    if (!input.description.trim() || !input.explanation.trim()) {
      throw new HarnessError("invalid_input", "Plan Drift description and explanation are required");
    }
    if (input.severity === "blocking" && (!input.nodeId || !input.recommendation?.trim())) {
      throw new HarnessError("invalid_input", "blocking Plan Drift requires a Task Node and agent recommendation");
    }
    if (!this.database.get("SELECT id FROM task_trees WHERE id = ? AND project_id = ?", input.treeId, input.projectId)) {
      throw new HarnessError("not_found", "Task Tree was not found in this Project");
    }
    if (input.nodeId && !this.database.get("SELECT id FROM task_nodes WHERE id = ? AND tree_id = ?", input.nodeId, input.treeId)) {
      throw new HarnessError("not_found", "Task Node was not found in this Task Tree");
    }
    for (const artifactId of [input.plannedArtifactId, input.actualArtifactId]) {
      if (artifactId && !this.database.get(
        "SELECT id FROM artifacts WHERE id = ? AND project_id = ? AND (tree_id IS NULL OR tree_id = ?)",
        artifactId, input.projectId, input.treeId,
      )) {
        throw new HarnessError("not_found", "Artifact was not found in this Project and Task Tree");
      }
    }
  }
}
