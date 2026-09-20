import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlanDriftService } from "../../src/application/plan-drift-service.js";
import { RuntimeActionService } from "../../src/application/runtime-action-service.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
const databases: RuntimeDatabase[] = [];

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-runtime-action-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  databases.push(database);
  for (const [projectId, treeId, revisionId, nodeId] of [
    ["p1", "t1", "tr1", "n1"], ["p2", "t2", "tr2", "n2"],
  ] as const) {
    database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES (?, ?, 'now', 'now')", projectId, `/${projectId}`);
    database.run("INSERT INTO task_trees (id, project_id, title, status, current_revision_id, created_at, updated_at) VALUES (?, ?, 'Tree', 'confirmed', ?, 'now', 'now')", treeId, projectId, revisionId);
    database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES (?, ?, 1, '{}', 'now')", revisionId, treeId);
    database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES (?, ?, NULL, 'Node', 'running')", nodeId, treeId);
    database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES (?, ?, ?, '{}', 'now')", `${nodeId}-r1`, nodeId, revisionId);
    database.run("INSERT INTO runtime_states (project_id, selected_tree_id, selected_node_id, state_json, updated_at) VALUES (?, ?, ?, '{}', 'now')", projectId, treeId, nodeId);
  }
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('source-1', 'p1', 't1', 'n1', 's1', 'UserPromptSubmit', '{}', '2026-01-01', 'source-1')");
  database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('source-2', 'p2', 't2', 'n2', 's2', 'UserPromptSubmit', '{}', '2026-01-01', 'source-2')");
  const drifts = new PlanDriftService(database);
  const blocking = drifts.recordDrift({
    projectId: "p1", treeId: "t1", nodeId: "n1", driftType: "responsibility_changed", severity: "blocking",
    description: "Responsibility moved", explanation: "Observed implementation crossed the planned boundary",
    recommendation: "Accept the new responsibility or restore the original plan",
  });
  const warning = drifts.recordDrift({
    projectId: "p1", treeId: "t1", nodeId: "n1", driftType: "relation_changed", severity: "warning",
    description: "Relation changed", explanation: "Observed relation differs",
  });
  return { database, blocking, warning, service: new RuntimeActionService(database) };
}

function addAnswer(database: RuntimeDatabase, id: string, projectId = "p1", treeId = "t1", occurredAt = "2099-01-01") {
  database.run(
    "INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES (?, ?, ?, NULL, 'answer-session', 'UserPromptSubmit', '{}', ?, ?)",
    id, projectId, treeId, occurredAt, id,
  );
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    try { database.close(); } catch { /* already closed */ }
  }
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("RuntimeActionService Plan Drift resolution", () => {
  it("proposes a typed high-risk action and confirmation without resolving Drift", async () => {
    const { database, blocking, service } = await fixture();
    const proposal = service.proposePlanDriftResolution({
      projectId: "p1", driftId: blocking.driftId, expectedTreeRevisionId: "tr1", decision: "accepted",
      reason: "Accept the observed responsibility after review", sourceMessageTraceEventId: "source-1",
    });
    expect(proposal).toMatchObject({ status: "pending_confirmation", confirmationRequirement: "required", targetId: blocking.driftId });
    expect(database.get<{ prompt_type: string; status: string; runtime_action_id: string }>("SELECT prompt_type, status, runtime_action_id FROM runtime_confirmation_prompts WHERE id = ?", proposal.confirmationId))
      .toEqual({ prompt_type: "drift_resolution", status: "pending", runtime_action_id: proposal.actionId });
    expect(database.get<{ resolution_status: string }>("SELECT resolution_status FROM plan_drift_records WHERE id = ?", blocking.driftId))
      .toEqual({ resolution_status: "pending_user_confirmation" });
    expect(JSON.parse(database.get<{ state_json: string }>("SELECT state_json FROM runtime_states WHERE project_id = 'p1'")!.state_json))
      .toMatchObject({ state: "waiting_for_drift_resolution", waitingItemId: proposal.confirmationId });
  });

  it("commits an accepted Drift exactly once from recorded answer evidence", async () => {
    const { database, blocking, service } = await fixture();
    const proposal = service.proposePlanDriftResolution({
      projectId: "p1", driftId: blocking.driftId, expectedTreeRevisionId: "tr1", decision: "accepted",
      reason: "Accept after review", sourceMessageTraceEventId: "source-1",
    });
    addAnswer(database, "answer-yes");
    const resolved = service.resolveConfirmation({ projectId: "p1", confirmationId: proposal.confirmationId, answer: "yes", answerTraceEventId: "answer-yes" });
    expect(resolved).toMatchObject({ actionId: proposal.actionId, status: "committed", decision: "accepted" });
    expect(database.get<{ resolution_status: string; user_decision: string }>("SELECT resolution_status, user_decision FROM plan_drift_records WHERE id = ?", blocking.driftId))
      .toEqual({ resolution_status: "accepted", user_decision: "accepted" });
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = 'n1'")).toEqual({ status: "needs_revalidation" });
    expect(service.resolveConfirmation({ projectId: "p1", confirmationId: proposal.confirmationId, answer: "yes", answerTraceEventId: "answer-yes" }))
      .toMatchObject({ actionId: proposal.actionId, status: "committed", decision: "accepted" });
    expect(database.get<{ count: number }>("SELECT count(*) AS count FROM trace_events WHERE event_name = 'plan_drift_resolved'")?.count).toBe(1);
  });

  it("supports pause and rejection without mutating the pending Drift", async () => {
    const { database, blocking, service } = await fixture();
    const proposal = service.proposePlanDriftResolution({
      projectId: "p1", driftId: blocking.driftId, expectedTreeRevisionId: "tr1", decision: "rejected",
      reason: "Restore the original responsibility", sourceMessageTraceEventId: "source-1",
    });
    addAnswer(database, "answer-pause");
    expect(service.resolveConfirmation({ projectId: "p1", confirmationId: proposal.confirmationId, answer: "pause", answerTraceEventId: "answer-pause" }))
      .toMatchObject({ status: "pending_confirmation", paused: true });
    expect(database.get<{ resolution_status: string }>("SELECT resolution_status FROM plan_drift_records WHERE id = ?", blocking.driftId))
      .toEqual({ resolution_status: "pending_user_confirmation" });
    addAnswer(database, "answer-no");
    expect(service.resolveConfirmation({ projectId: "p1", confirmationId: proposal.confirmationId, answer: "no", answerTraceEventId: "answer-no" }))
      .toMatchObject({ status: "rejected" });
    expect(database.get<{ resolution_status: string }>("SELECT resolution_status FROM plan_drift_records WHERE id = ?", blocking.driftId))
      .toEqual({ resolution_status: "pending_user_confirmation" });
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = 'n1'")).toEqual({ status: "blocked" });
  });

  it("keeps Runtime State pointed at another pending confirmation after one action resolves", async () => {
    const { database, blocking, service } = await fixture();
    const another = new PlanDriftService(database).recordDrift({
      projectId: "p1", treeId: "t1", nodeId: "n1", driftType: "relation_changed", severity: "blocking",
      description: "A second contract conflict", explanation: "Another confirmed boundary changed",
      recommendation: "Accept the updated relation or restore the confirmed relation",
    });
    const first = service.proposePlanDriftResolution({
      projectId: "p1", driftId: blocking.driftId, expectedTreeRevisionId: "tr1", decision: "accepted",
      reason: "Accept the first boundary", sourceMessageTraceEventId: "source-1",
    });
    const second = service.proposePlanDriftResolution({
      projectId: "p1", driftId: another.driftId, expectedTreeRevisionId: "tr1", decision: "accepted",
      reason: "Accept the second boundary", sourceMessageTraceEventId: "source-1",
    });
    addAnswer(database, "answer-first-yes");
    service.resolveConfirmation({
      projectId: "p1", confirmationId: first.confirmationId, answer: "yes", answerTraceEventId: "answer-first-yes",
    });
    expect(JSON.parse(database.get<{ state_json: string }>(
      "SELECT state_json FROM runtime_states WHERE project_id = 'p1'",
    )!.state_json)).toMatchObject({
      state: "waiting_for_drift_resolution", waitingItemType: "drift_resolution", waitingItemId: second.confirmationId,
    });
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = 'n1'"))
      .toEqual({ status: "blocked" });
  });

  it("rejects non-blocking, stale, foreign, and early-evidence operations", async () => {
    const { database, blocking, warning, service } = await fixture();
    const common = { projectId: "p1", expectedTreeRevisionId: "tr1", decision: "accepted" as const, reason: "Review", sourceMessageTraceEventId: "source-1" };
    expect(() => service.proposePlanDriftResolution({ ...common, driftId: warning.driftId }))
      .toThrow(expect.objectContaining({ code: "confirmation_not_applicable" }));
    expect(() => service.proposePlanDriftResolution({ ...common, driftId: blocking.driftId, expectedTreeRevisionId: "stale" }))
      .toThrow(expect.objectContaining({ code: "revision_conflict" }));
    expect(() => service.proposePlanDriftResolution({ ...common, projectId: "p2", driftId: blocking.driftId, expectedTreeRevisionId: "tr2", sourceMessageTraceEventId: "source-2" }))
      .toThrow(expect.objectContaining({ code: "not_found" }));

    const proposal = service.proposePlanDriftResolution({ ...common, driftId: blocking.driftId });
    addAnswer(database, "answer-early", "p1", "t1", "2020-01-01");
    expect(() => service.resolveConfirmation({ projectId: "p1", confirmationId: proposal.confirmationId, answer: "yes", answerTraceEventId: "answer-early" }))
      .toThrow(expect.objectContaining({ code: "runtime_action_rejected" }));
  });
});
