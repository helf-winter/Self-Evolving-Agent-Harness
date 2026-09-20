import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeQueryService } from "../../src/application/runtime-query-service.js";
import { PlanDriftService } from "../../src/application/plan-drift-service.js";
import { TaskTreeService } from "../../src/application/task-tree-service.js";
import { FailureCaseService } from "../../src/application/failure-case-service.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-query-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/a', 'now', 'now')");
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p2', '/b', 'now', 'now')");
  const tree = await new TaskTreeService(database).createTaskRoot({ projectId: "p1", title: "Runtime" });
  database.run("INSERT INTO runtime_confirmation_prompts (id, project_id, tree_id, scope_id, prompt, status, created_at) VALUES ('c1', 'p1', ?, ?, 'Execute?', 'pending', 'now')", tree.treeId, tree.treeId);
  for (const [id, at] of [["e1", "2026-01-01"], ["e2", "2026-01-02"]] as const) {
    database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES (?, 'p1', ?, ?, 's', 'PostToolUse', '{}', ?, ?)", id, tree.treeId, tree.document.nodes[0]!.id, at, `k-${id}`);
  }
  const nodeId = tree.document.nodes[0]!.id;
  const nodeRevision = database.get<{ id: string }>("SELECT id FROM task_node_revisions WHERE node_id = ?", nodeId)!;
  database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at, completed_at) VALUES ('a1', 'p1', ?, ?, ?, 1, 'failed', '2026-01-03', '2026-01-04')", tree.treeId, nodeId, nodeRevision.id);
  database.run("INSERT INTO evaluations (id, project_id, tree_id, task_node_id, task_node_revision_id, execution_attempt_id, verdict, evidence_refs_json, covered_required_evidence_json, missing_required_evidence_json, risk_summary, created_at) VALUES ('v1', 'p1', ?, ?, ?, 'a1', 'failed', '[]', '[]', '[]', 'failed check', '2026-01-04')", tree.treeId, nodeId, nodeRevision.id);
  database.run("INSERT INTO artifacts (id, project_id, tree_id, kind, locator, status, metadata_json, created_at, updated_at, granularity, artifact_type, path_or_name, identity_strategy, confidence, source_trace_event_id, source_planning_revision_id) VALUES ('route-file', 'p1', ?, 'file', 'src/route.ts', 'modified', '{}', 'now', 'now', 'structural', 'file', 'src/route.ts', 'path', 'observed', 'e1', ?)", tree.treeId, tree.revisionId);
  database.run("INSERT INTO artifacts (id, project_id, tree_id, kind, locator, status, metadata_json, created_at, updated_at, granularity, artifact_type, path_or_name, identity_strategy, confidence, source_planning_revision_id) VALUES ('route-contract', 'p1', ?, 'contract', 'route.request', 'planned', '{}', 'now', 'now', 'contract', 'interface', 'route.request', 'logical_contract_id', 'planned', ?)", tree.treeId, tree.revisionId);
  database.run("INSERT INTO artifacts (id, project_id, tree_id, kind, locator, status, metadata_json, created_at, updated_at) VALUES ('foreign-file', 'p2', NULL, 'file', 'secret.ts', 'observed', '{}', 'now', 'now')");
  database.run("INSERT INTO task_node_artifact_links (id, project_id, tree_id, tree_revision_id, task_node_id, task_node_revision_id, artifact_id, relation_type, source_planning_revision_id, created_at) VALUES ('link-1', 'p1', ?, ?, ?, ?, 'route-file', 'modifies', ?, 'now')", tree.treeId, tree.revisionId, nodeId, nodeRevision.id, tree.revisionId);
  database.run("INSERT INTO artifact_graph_relations (id, project_id, tree_id, tree_revision_id, from_artifact_id, to_artifact_id, kind, source_trace_event_id, source_planning_revision_id, created_at) VALUES ('relation-1', 'p1', ?, ?, 'route-file', 'route-contract', 'implements', 'e1', ?, 'now')", tree.treeId, tree.revisionId, tree.revisionId);
  database.run("INSERT INTO artifact_contracts (id, contract_id, project_id, tree_id, tree_revision_id, artifact_id, contract_name, contract_version, compatibility_policy, schema_or_signature, provider_revision_ids_json, consumer_revision_ids_json, validation_refs_json, created_at) VALUES ('contract-row', 'route-contract-v1', 'p1', ?, ?, 'route-contract', 'Route request', '1', 'exact', 'GET /route', ?, '[]', ?, 'now')", tree.treeId, tree.revisionId, JSON.stringify([nodeRevision.id]), JSON.stringify(["npm test"]));
  const drifts = new PlanDriftService(database);
  drifts.recordDrift({ projectId: "p1", treeId: tree.treeId, nodeId, actualArtifactId: "route-file", driftType: "relation_changed", severity: "warning", description: "Observed relation differs", explanation: "Implementation updated the relation" });
  drifts.recordDrift({ projectId: "p1", treeId: tree.treeId, nodeId, plannedArtifactId: "route-contract", driftType: "responsibility_changed", severity: "blocking", description: "Responsibility moved", explanation: "The confirmed owner no longer applies", recommendation: "Refine this branch" });
  database.run("INSERT INTO lifecycle_transition_records (id, evaluation_id, task_node_id, policy_version, from_status, target_status, applied, rejection_code, created_at) VALUES ('lt-query', 'v1', ?, 'v1', 'verifying', 'failed', 1, NULL, '2026-01-04')", nodeId);
  const failure = new FailureCaseService(database).captureFailedEvaluationWithinTransaction({ projectId: "p1", evaluationId: "v1" });
  return { database, tree, failure, service: new RuntimeQueryService(database) };
}
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("RuntimeQueryService", () => {
  it("returns a compact Snapshot and richer Summary", async () => {
    const { database, tree, service } = await fixture();
    expect(service.getRuntimeSnapshot("p1")).toMatchObject({
      selectedTreeId: tree.treeId, workflow: { stage: "draft_task_tree", revision: 1 }, pendingConfirmation: { confirmationId: "c1" },
      activeAttemptCount: 0, confirmationCounts: { draft: 1, pendingUserConfirmation: 0, confirmed: 0, partialConfirmed: 0 },
      driftCounts: { warning: 1, blocking: 1 },
    });
    expect(service.getTaskTreeSummary("p1", tree.treeId)).toMatchObject({
      treeId: tree.treeId, title: "Runtime", traceCount: 4, attemptCount: 1, evaluationCount: 1,
      artifactCounts: { total: 2 }, driftCounts: { warning: 1, blocking: 1 },
      confirmationCounts: { draft: 1, pendingUserConfirmation: 0, confirmed: 0, partialConfirmed: 0 },
      nodes: [expect.objectContaining({ confirmationState: "draft" })],
    });
    database.close();
  });

  it("paginates evidence and never reveals another project's identifiers", async () => {
    const { database, tree, service } = await fixture();
    const nodeId = tree.document.nodes[0]!.id;
    const detail = service.getTaskNodeDetail("p1", nodeId, { limit: 1 });
    expect(detail.confirmationState).toBe("draft");
    expect(detail.evidence).toHaveLength(1);
    expect(detail.attempts).toEqual([expect.objectContaining({ attemptId: "a1", attemptNumber: 1, status: "failed" })]);
    expect(detail.evaluations).toEqual([expect.objectContaining({ evaluationId: "v1", attemptId: "a1", verdict: "failed" })]);
    expect(detail.nextCursor).toBeTruthy();
    expect(service.getTraceEvents("p1", { limit: 10 }).items.map((event) => event.eventId)).toContain("e1");
    const nodeRevision = database.get<{ id: string }>("SELECT id FROM task_node_revisions WHERE node_id = ?", nodeId)!;
    database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at, completed_at) VALUES ('a2', 'p1', ?, ?, ?, 2, 'aborted', '2026-01-05', '2026-01-06')", tree.treeId, nodeId, nodeRevision.id);
    database.run("INSERT INTO evaluations (id, project_id, tree_id, task_node_id, task_node_revision_id, execution_attempt_id, verdict, evidence_refs_json, covered_required_evidence_json, missing_required_evidence_json, risk_summary, created_at) VALUES ('v2', 'p1', ?, ?, ?, 'a2', 'uncertain', '[]', '[]', '[]', '', '2026-01-06')", tree.treeId, nodeId, nodeRevision.id);
    const firstHistory = service.getTaskNodeDetail("p1", nodeId, { attemptLimit: 1, evaluationLimit: 1 });
    expect(firstHistory.attempts[0]?.attemptId).toBe("a2");
    expect(firstHistory.evaluations[0]?.evaluationId).toBe("v2");
    expect(firstHistory.attemptNextCursor).toBeTruthy();
    expect(firstHistory.evaluationNextCursor).toBeTruthy();
    const secondHistory = service.getTaskNodeDetail("p1", nodeId, {
      attemptLimit: 1, attemptCursor: firstHistory.attemptNextCursor!,
      evaluationLimit: 1, evaluationCursor: firstHistory.evaluationNextCursor!,
    });
    expect(secondHistory.attempts[0]?.attemptId).toBe("a1");
    expect(secondHistory.evaluations[0]?.evaluationId).toBe("v1");
    expect(() => service.getTaskTreeSummary("p2", tree.treeId)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => service.getTaskNodeDetail("p2", nodeId, {})).toThrow(expect.objectContaining({ code: "not_found" }));
    database.close();
  });

  it("returns project-scoped Artifact Graph and filtered Plan Drift views", async () => {
    const { database, tree, service } = await fixture();
    const graph = service.getArtifactGraphSummary("p1", { treeId: tree.treeId, limit: 10 });
    expect(graph.items.map((artifact) => artifact.artifactId)).toEqual(["route-contract", "route-file"]);
    expect(graph.relations).toEqual([expect.objectContaining({ relationId: "relation-1", kind: "implements" })]);
    expect(graph.contracts).toEqual([expect.objectContaining({ contractId: "route-contract-v1", artifactId: "route-contract" })]);
    expect(graph.taskLinks).toEqual([expect.objectContaining({ artifactId: "route-file", nodeId: tree.document.nodes[0]!.id })]);
    expect(graph.nextCursor).toBeNull();

    const detail = service.getArtifactDetail("p1", "route-file");
    expect(detail.artifact).toMatchObject({ artifactId: "route-file", locator: "src/route.ts", status: "modified", sourceTraceEventId: "e1" });
    expect(detail.traceEventIds).toContain("e1");
    expect(detail.drifts).toEqual([expect.objectContaining({ severity: "warning", resolutionStatus: "recorded" })]);

    const blocking = service.getPlanDriftSummary("p1", { treeId: tree.treeId, severity: "blocking", resolutionStatus: "pending_user_confirmation" });
    expect(blocking.items).toEqual([expect.objectContaining({ severity: "blocking", resolutionStatus: "pending_user_confirmation" })]);
    expect(service.getPlanDriftSummary("p1", { treeId: tree.treeId, severity: "warning" }).items).toHaveLength(1);
    expect(() => service.getArtifactDetail("p1", "foreign-file")).toThrow(expect.objectContaining({ code: "not_found" }));
    database.close();
  });

  it("returns typed waiting items, User Changes, and Runtime Action detail", async () => {
    const { database, tree, service } = await fixture();
    const nodeId = tree.document.nodes[0]!.id;
    database.run("INSERT INTO runtime_actions (id, project_id, kind, input_json, result_json, created_at, action_type, target_type, target_id, expected_revision, reason, source_message_ref, risk_level, confirmation_requirement, confirmation_prompt_id, status) VALUES ('ra-query', 'p1', 'record_user_change', ?, '{}', '2030-01-01', 'record_user_change', 'user_change', 'uc-query', ?, 'Change scope', 'e1', 'high', 'required', 'confirmation-query', 'pending_confirmation')", JSON.stringify({ userChangeId: "uc-query", changeType: "scope_change" }), tree.revisionId);
    database.run("INSERT INTO runtime_confirmation_prompts (id, project_id, tree_id, scope_id, prompt, status, created_at, tree_revision_id, scope_kind, scope_root_node_id, prompt_type, related_task_node_id, related_artifact_ids_json, options_json, runtime_action_id) VALUES ('confirmation-query', 'p1', ?, 'uc-query', 'Apply scope?', 'pending', '2030-01-01', ?, 'branch', ?, 'change_confirmation', ?, '[]', '[\"yes\",\"no\",\"pause\"]', 'ra-query')", tree.treeId, tree.revisionId, nodeId, nodeId);
    database.run("INSERT INTO user_change_requests (id, project_id, tree_id, task_node_id, change_type, source_trace_event_id, expected_tree_revision_id, summary, change_impact_json, proposed_document_json, priority_target_node_id, prior_node_status, status, runtime_action_id, created_at, updated_at) VALUES ('uc-query', 'p1', ?, ?, 'scope_change', 'e1', ?, 'Change scope', '{\"changedNodes\":[]}', '{}', NULL, 'blocked', 'pending_confirmation', 'ra-query', '2030-01-01', '2030-01-01')", tree.treeId, nodeId, tree.revisionId);

    expect(service.getRuntimeSnapshot("p1")).toMatchObject({ pendingConfirmationCount: 2 });
    const waiting = service.getWaitingItems("p1", { promptType: "change_confirmation", limit: 10 });
    expect(waiting.items).toEqual([expect.objectContaining({ confirmationId: "confirmation-query", promptType: "change_confirmation", actionStatus: "pending_confirmation" })]);
    const changes = service.getUserChangeRequests("p1", { treeId: tree.treeId, changeType: "scope_change", status: "pending_confirmation" });
    expect(changes.items).toEqual([expect.objectContaining({ userChangeId: "uc-query", nodeId, summary: "Change scope" })]);
    expect(service.getRuntimeActionDetail("p1", "ra-query")).toMatchObject({
      action: { actionId: "ra-query", actionType: "record_user_change", targetId: "uc-query" },
      confirmation: { confirmationId: "confirmation-query", promptType: "change_confirmation" },
      userChange: { userChangeId: "uc-query", changeType: "scope_change" },
    });
    expect(() => service.getRuntimeActionDetail("p2", "ra-query")).toThrow(expect.objectContaining({ code: "not_found" }));
    database.close();
  });

  it("paginates Failure Cases and returns source-linked reproduction detail", async () => {
    const { database, tree, failure, service } = await fixture();
    const nodeId = tree.document.nodes[0]!.id;
    const nodeRevision = database.get<{ id: string }>("SELECT id FROM task_node_revisions WHERE node_id = ?", nodeId)!;
    database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at, completed_at) VALUES ('a-f2', 'p1', ?, ?, ?, 2, 'failed', '2030-01-01', '2030-01-02')", tree.treeId, nodeId, nodeRevision.id);
    database.run("INSERT INTO evaluations (id, project_id, tree_id, task_node_id, task_node_revision_id, execution_attempt_id, verdict, evidence_refs_json, covered_required_evidence_json, missing_required_evidence_json, risk_summary, created_at) VALUES ('v-f2', 'p1', ?, ?, ?, 'a-f2', 'failed', '[\"e2\"]', '[]', '[]', 'different failure signature', '2030-01-02')", tree.treeId, nodeId, nodeRevision.id);
    database.run("INSERT INTO lifecycle_transition_records (id, evaluation_id, task_node_id, policy_version, from_status, target_status, applied, rejection_code, created_at) VALUES ('lt-f2', 'v-f2', ?, 'v1', 'verifying', 'failed', 1, NULL, '2030-01-02')", nodeId);
    new FailureCaseService(database).captureFailedEvaluationWithinTransaction({ projectId: "p1", evaluationId: "v-f2" });

    const first = service.getFailureCases("p1", {
      treeId: tree.treeId, nodeId, maturityLevel: "L0_observed", availabilityStatus: "active", limit: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    expect(service.getFailureCases("p1", { limit: 1, cursor: first.nextCursor! }).items).toHaveLength(1);
    const detail = service.getFailureCaseDetail("p1", failure.failureCaseId);
    expect(detail.failureCase).toMatchObject({
      failureCaseId: failure.failureCaseId, treeId: tree.treeId, sourceNodeId: nodeId,
      sourceAttemptId: "a1", sourceEvaluationId: "v1", maturityLevel: "L0_observed",
    });
    expect(detail.occurrences).toEqual([expect.objectContaining({ attemptId: "a1", evaluationId: "v1" })]);
    expect(detail.reproductionRevisions).toEqual([expect.objectContaining({
      reproductionRevisionId: failure.reproductionRevisionId, revisionNumber: 1, mode: "observed",
    })]);
    expect(detail.validationResults).toEqual([]);
    expect(detail.relatedArtifacts).toEqual([expect.objectContaining({ artifactId: "route-file" })]);
    expect(() => service.getFailureCaseDetail("p2", failure.failureCaseId)).toThrow(expect.objectContaining({ code: "not_found" }));
    database.close();
  });
});
