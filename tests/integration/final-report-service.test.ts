import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";

const dirs: string[] = [];
const runtimes: Array<ReturnType<typeof openRuntime>> = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function finalStageFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-final-report-"));
  dirs.push(directory);
  const projectDir = path.join(directory, "project");
  await mkdir(projectDir);
  const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") };
  const runtime = openRuntime(environment);
  runtimes.push(runtime);
  const project = await runtime.projects.resolve(projectDir, "persist");
  const tree = await runtime.taskTrees.createTaskRoot({ projectId: project.projectId, title: "Close lifecycle" });
  const rootNodeId = tree.document.nodes[0]!.id;
  runtime.database.run("UPDATE task_nodes SET status = 'succeeded' WHERE tree_id = ?", tree.treeId);
  runtime.database.run(
    "UPDATE workflow_states SET stage = 'final_report', revision = 8, active = 1 WHERE project_id = ? AND tree_id = ?",
    project.projectId, tree.treeId,
  );
  runtime.database.run(`
    INSERT INTO workflow_phase_gate_results (
      id, project_id, tree_id, tree_revision_id, workflow_revision, stage, branch_node_id,
      status, required_node_ids_json, incomplete_node_ids_json, blocking_drift_ids_json,
      blocker_codes_json, next_stage, next_branch_node_id, created_at
    ) VALUES ('root-gate', ?, ?, ?, 7, 'root_verification', NULL,
      'passed', ?, '[]', '[]', '[]', 'final_report', NULL, '2030-01-01T00:00:00.000Z')
  `, project.projectId, tree.treeId, tree.revisionId, JSON.stringify([rootNodeId]));
  return { directory, projectDir, environment, runtime, project, tree, rootNodeId };
}

async function sharedBranchesFixture() {
  const fixture = await finalStageFixture();
  fixture.runtime.database.run(
    "UPDATE task_node_revisions SET body_json = ? WHERE tree_revision_id = ? AND node_id = ?",
    JSON.stringify({ id: fixture.rootNodeId, parentId: null, title: "Root verification", children: ["branch-a", "branch-b"], executionPhase: "verification", requiredEvidence: [{ key: "root", description: "root evidence" }] }),
    fixture.tree.revisionId, fixture.rootNodeId,
  );
  for (const [branchId, order] of [["branch-a", 0], ["branch-b", 1]] as const) {
    fixture.runtime.database.run(
      "INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES (?, ?, ?, ?, 'succeeded')",
      branchId, fixture.tree.treeId, fixture.rootNodeId, branchId,
    );
    fixture.runtime.database.run(
      "INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES (?, ?, ?, ?, '2030')",
      `${branchId}-revision`, branchId, fixture.tree.revisionId,
      JSON.stringify({ id: branchId, parentId: fixture.rootNodeId, title: branchId, children: [`${branchId}-impl`, `${branchId}-verify`] }),
    );
    for (const phase of ["implementation", "verification"] as const) {
      const nodeId = `${branchId}-${phase === "implementation" ? "impl" : "verify"}`;
      fixture.runtime.database.run(
        "INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES (?, ?, ?, ?, 'succeeded')",
        nodeId, fixture.tree.treeId, branchId, nodeId,
      );
      fixture.runtime.database.run(
        "INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES (?, ?, ?, ?, '2030')",
        `${nodeId}-revision`, nodeId, fixture.tree.revisionId,
        JSON.stringify({ id: nodeId, parentId: branchId, title: nodeId, children: [], executionPhase: phase, requiredEvidence: [{ key: phase, description: `${phase} evidence` }] }),
      );
    }
    fixture.runtime.database.run(`
      INSERT INTO workflow_branch_states (
        project_id, tree_id, tree_revision_id, branch_node_id, branch_order, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'verified', '2030')
    `, fixture.project.projectId, fixture.tree.treeId, fixture.tree.revisionId, branchId, order);
  }
  fixture.runtime.database.run(`
    INSERT INTO artifacts (
      id, project_id, tree_id, kind, locator, status, metadata_json, created_at, updated_at
    ) VALUES ('shared-file', ?, ?, 'file', 'src/shared.ts', 'verified', '{}', '2030', '2030')
  `, fixture.project.projectId, fixture.tree.treeId);
  fixture.runtime.database.run(`
    INSERT INTO artifacts (
      id, project_id, tree_id, kind, locator, status, metadata_json, created_at, updated_at
    ) VALUES ('shared-contract', ?, ?, 'contract', 'shared.contract', 'verified', '{}', '2030', '2030')
  `, fixture.project.projectId, fixture.tree.treeId);
  fixture.runtime.database.run(`
    INSERT INTO artifact_graph_relations (
      id, project_id, tree_id, tree_revision_id, from_artifact_id, to_artifact_id,
      kind, source_planning_revision_id, created_at
    ) VALUES ('file-contract-relation', ?, ?, ?, 'shared-file', 'shared-contract',
      'implements', ?, '2030')
  `, fixture.project.projectId, fixture.tree.treeId, fixture.tree.revisionId, fixture.tree.revisionId);
  fixture.runtime.database.run(`
    INSERT INTO task_node_artifact_links (
      id, project_id, tree_id, tree_revision_id, task_node_id, task_node_revision_id,
      artifact_id, relation_type, source_planning_revision_id, created_at
    ) VALUES ('shared-branch-a', ?, ?, ?, 'branch-a-impl', 'branch-a-impl-revision',
      'shared-file', 'modifies', ?, '2030')
  `, fixture.project.projectId, fixture.tree.treeId, fixture.tree.revisionId, fixture.tree.revisionId);
  fixture.runtime.database.run(`
    INSERT INTO task_node_artifact_links (
      id, project_id, tree_id, tree_revision_id, task_node_id, task_node_revision_id,
      artifact_id, relation_type, source_planning_revision_id, created_at
    ) VALUES ('shared-branch-b', ?, ?, ?, 'branch-b-impl', 'branch-b-impl-revision',
      'shared-contract', 'consumes', ?, '2030')
  `, fixture.project.projectId, fixture.tree.treeId, fixture.tree.revisionId, fixture.tree.revisionId);
  return fixture;
}

describe("FinalReportService", () => {
  it("atomically persists an immutable fact report and completes the Task Tree", async () => {
    const fixture = await finalStageFixture();
    expect(fixture.runtime.queries.getRuntimeSnapshot(fixture.project.projectId)).toMatchObject({
      workflow: { stage: "final_report", revision: 8 },
      availableActions: ["finalize_task_tree", "inspect_detail"],
    });
    const report = fixture.runtime.finalReports.finalize({
      projectId: fixture.project.projectId,
      treeId: fixture.tree.treeId,
      workflowRevision: 8,
      idempotencyKey: "finish-1",
    });

    expect(report).toMatchObject({
      created: true,
      projectId: fixture.project.projectId,
      treeId: fixture.tree.treeId,
      treeRevisionId: fixture.tree.revisionId,
      workflowRevision: 8,
      status: "completed",
      rootPhaseGateResultId: "root-gate",
      summary: {
        taskNodes: { total: 1, succeeded: 1, failed: 0, blocked: 0 },
        branches: { total: 0, verified: 0 },
        unresolved: { activeAttempts: 0, blockingDrifts: 0, pendingConfirmations: 0, pendingChanges: 0 },
      },
      evidenceRefs: { phaseGateResultIds: ["root-gate"] },
    });
    expect(fixture.runtime.database.get("SELECT status FROM task_trees WHERE id = ?", fixture.tree.treeId))
      .toEqual({ status: "completed" });
    expect(fixture.runtime.database.get("SELECT active FROM workflow_states WHERE project_id = ? AND tree_id = ?", fixture.project.projectId, fixture.tree.treeId))
      .toEqual({ active: 0 });
    expect(fixture.runtime.database.get("SELECT selected_tree_id FROM runtime_states WHERE project_id = ?", fixture.project.projectId))
      .toEqual({ selected_tree_id: fixture.tree.treeId });
    expect(fixture.runtime.queries.getRuntimeSnapshot(fixture.project.projectId)).toMatchObject({
      selectedTreeId: fixture.tree.treeId,
      workflow: null,
    });
    expect(fixture.runtime.finalReports.list(fixture.project.projectId, { treeId: fixture.tree.treeId }))
      .toEqual([expect.objectContaining({ reportId: report.reportId, created: false, status: "completed" })]);
    expect(() => fixture.runtime.taskTrees.saveDraftRevision({
      projectId: fixture.project.projectId,
      treeId: fixture.tree.treeId,
      baseRevisionId: fixture.tree.revisionId,
      document: fixture.tree.document,
    })).toThrow(expect.objectContaining({ code: "task_tree_transition_rejected" }));

    expect(() => fixture.runtime.database.run("UPDATE final_reports SET status = 'completed' WHERE id = ?", report.reportId))
      .toThrow(expect.objectContaining({ code: "storage_failure" }));
    const reopened = openRuntime(fixture.environment);
    runtimes.push(reopened);
    expect(reopened.finalReports.list(fixture.project.projectId, { reportId: report.reportId }))
      .toEqual([expect.objectContaining({ treeRevisionId: fixture.tree.revisionId, rootPhaseGateResultId: "root-gate" })]);
  });

  it("returns the same report for an idempotent retry and rejects a second completion key", async () => {
    const fixture = await finalStageFixture();
    const first = fixture.runtime.finalReports.finalize({
      projectId: fixture.project.projectId, treeId: fixture.tree.treeId,
      workflowRevision: 8, idempotencyKey: "finish-once",
    });
    expect(fixture.runtime.finalReports.finalize({
      projectId: fixture.project.projectId, treeId: fixture.tree.treeId,
      workflowRevision: 8, idempotencyKey: "finish-once",
    })).toMatchObject({ reportId: first.reportId, created: false });
    expect(() => fixture.runtime.finalReports.finalize({
      projectId: fixture.project.projectId, treeId: fixture.tree.treeId,
      workflowRevision: 8, idempotencyKey: "different-key",
    })).toThrow(expect.objectContaining({ code: "task_tree_transition_rejected" }));
    expect(fixture.runtime.database.all("SELECT id FROM final_reports WHERE tree_id = ?", fixture.tree.treeId)).toHaveLength(1);
  });

  it("invalidates root verification when project code changes during final_report", async () => {
    const fixture = await finalStageFixture();
    const nodeRevisionId = fixture.runtime.database.get<{ id: string }>(
      "SELECT id FROM task_node_revisions WHERE tree_revision_id = ? AND node_id = ?",
      fixture.tree.revisionId, fixture.rootNodeId,
    )!.id;
    fixture.runtime.database.run(`
      INSERT INTO artifacts (
        id, project_id, tree_id, kind, locator, status, metadata_json, created_at, updated_at
      ) VALUES ('final-file', ?, ?, 'file', 'src/final.ts', 'verified', '{}', '2030', '2030')
    `, fixture.project.projectId, fixture.tree.treeId);
    fixture.runtime.database.run(`
      INSERT INTO task_node_artifact_links (
        id, project_id, tree_id, tree_revision_id, task_node_id, task_node_revision_id,
        artifact_id, relation_type, source_planning_revision_id, created_at
      ) VALUES ('final-file-link', ?, ?, ?, ?, ?, 'final-file', 'modifies', ?, '2030')
    `, fixture.project.projectId, fixture.tree.treeId, fixture.tree.revisionId,
    fixture.rootNodeId, nodeRevisionId, fixture.tree.revisionId);

    await fixture.runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse",
      session_id: "read-after-root-gate",
      cwd: fixture.projectDir,
      tool_name: "Read",
      tool_use_id: "read-after-root-gate",
      tool_input: { file_path: path.join(fixture.projectDir, "src", "final.ts") },
      tool_response: { ok: true },
    }));
    await fixture.runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUseFailure",
      session_id: "failed-edit-after-root-gate",
      cwd: fixture.projectDir,
      tool_name: "Edit",
      tool_use_id: "failed-edit-after-root-gate",
      tool_input: { file_path: path.join(fixture.projectDir, "src", "final.ts") },
      tool_response: { error: "write failed" },
    }));
    expect(fixture.runtime.freshness.list(fixture.project.projectId, { treeId: fixture.tree.treeId })).toEqual([]);
    expect(fixture.runtime.database.get<{ status: string }>(
      "SELECT status FROM task_nodes WHERE id = ?", fixture.rootNodeId,
    )).toEqual({ status: "succeeded" });

    const hookResult = await fixture.runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse",
      session_id: "post-root-change",
      cwd: fixture.projectDir,
      tool_name: "Edit",
      tool_use_id: "edit-after-root-gate",
      tool_input: { file_path: path.join(fixture.projectDir, "src", "final.ts") },
      tool_response: { ok: true },
    }));

    expect(hookResult).toMatchObject({ recorded: true, violation: false, blocked: false });
    expect(fixture.runtime.database.get<{ status: string }>(
      "SELECT status FROM task_nodes WHERE id = ?", fixture.rootNodeId,
    )).toEqual({ status: "needs_revalidation" });
    expect(fixture.runtime.database.get<{ stage: string; revision: number; active: number }>(
      "SELECT stage, revision, active FROM workflow_states WHERE tree_id = ?", fixture.tree.treeId,
    )).toEqual({ stage: "root_verification", revision: 9, active: 1 });
    expect(fixture.runtime.database.get<{
      source_trace_event_id: string; affected_node_ids_json: string; invalidated_gate_result_ids_json: string;
    }>("SELECT source_trace_event_id, affected_node_ids_json, invalidated_gate_result_ids_json FROM verification_invalidations"))
      .toMatchObject({
        source_trace_event_id: hookResult.recorded ? hookResult.eventId : "",
        affected_node_ids_json: JSON.stringify([fixture.rootNodeId]),
        invalidated_gate_result_ids_json: JSON.stringify(["root-gate"]),
      });
    const invalidations = fixture.runtime.freshness.list(
      fixture.project.projectId, { treeId: fixture.tree.treeId },
    );
    expect(invalidations).toEqual([
      expect.objectContaining({
        sourceTraceEventId: hookResult.recorded ? hookResult.eventId : "",
        affectedNodeIds: [fixture.rootNodeId],
        invalidatedGateResultIds: ["root-gate"],
        priorStage: "final_report",
        nextStage: "root_verification",
      }),
    ]);
    const invalidationId = invalidations[0]!.invalidationId;
    expect(() => fixture.runtime.database.run(
      "UPDATE verification_invalidations SET next_stage = 'final_report' WHERE id = ?", invalidationId,
    )).toThrow(expect.objectContaining({ code: "storage_failure" }));
    expect(() => fixture.runtime.database.run(
      "DELETE FROM verification_invalidations WHERE id = ?", invalidationId,
    )).toThrow(expect.objectContaining({ code: "storage_failure" }));

    fixture.runtime.close();
    runtimes.splice(runtimes.indexOf(fixture.runtime), 1);
    fixture.runtime = openRuntime(fixture.environment);
    runtimes.push(fixture.runtime);
    expect(fixture.runtime.freshness.list(fixture.project.projectId, { invalidationId })).toEqual([
      expect.objectContaining({ invalidationId, treeId: fixture.tree.treeId }),
    ]);
    const otherDir = path.join(fixture.directory, "other-project");
    await mkdir(otherDir);
    const otherProject = await fixture.runtime.projects.resolve(otherDir, "persist");
    expect(fixture.runtime.freshness.list(otherProject.projectId, { invalidationId })).toEqual([]);
    expect(() => fixture.runtime.finalReports.finalize({
      projectId: fixture.project.projectId,
      treeId: fixture.tree.treeId,
      workflowRevision: 9,
      idempotencyKey: "stale-root-gate",
    })).toThrow(expect.objectContaining({ code: "workflow_transition_rejected" }));

    fixture.runtime.database.run("UPDATE task_nodes SET status = 'succeeded' WHERE id = ?", fixture.rootNodeId);
    fixture.runtime.database.run(`
      INSERT INTO workflow_phase_gate_results (
        id, project_id, tree_id, tree_revision_id, workflow_revision, stage, branch_node_id,
        status, required_node_ids_json, incomplete_node_ids_json, blocking_drift_ids_json,
        blocker_codes_json, next_stage, next_branch_node_id, created_at
      ) VALUES ('root-gate-after-change', ?, ?, ?, 9, 'root_verification', NULL,
        'passed', ?, '[]', '[]', '[]', 'final_report', NULL, '2031-01-01T00:00:00.000Z')
    `, fixture.project.projectId, fixture.tree.treeId, fixture.tree.revisionId,
    JSON.stringify([fixture.rootNodeId]));
    fixture.runtime.database.run(
      "UPDATE workflow_states SET stage = 'final_report', revision = 10 WHERE tree_id = ?",
      fixture.tree.treeId,
    );
    expect(fixture.runtime.finalReports.finalize({
      projectId: fixture.project.projectId,
      treeId: fixture.tree.treeId,
      workflowRevision: 10,
      idempotencyKey: "fresh-root-gate",
    })).toMatchObject({
      status: "completed",
      summary: { verificationFreshness: { invalidationCount: 1 } },
      evidenceRefs: {
        verificationInvalidationIds: [expect.any(String)],
        phaseGateResultIds: ["root-gate-after-change"],
      },
    });
  });

  it("rewinds every verified branch that shares a changed Artifact", async () => {
    const fixture = await sharedBranchesFixture();

    await fixture.runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse",
      session_id: "shared-contract-change",
      cwd: fixture.projectDir,
      tool_name: "Edit",
      tool_use_id: "edit-shared-artifact",
      tool_input: { file_path: path.join(fixture.projectDir, "src", "shared.ts") },
      tool_response: { ok: true },
    }));

    expect(fixture.runtime.database.all<{ id: string; status: string }>(
      "SELECT id, status FROM task_nodes WHERE tree_id = ? ORDER BY id", fixture.tree.treeId,
    )).toEqual(expect.arrayContaining([
      { id: "branch-a", status: "succeeded" },
      { id: "branch-a-impl", status: "needs_revalidation" },
      { id: "branch-a-verify", status: "needs_revalidation" },
      { id: "branch-b", status: "succeeded" },
      { id: "branch-b-impl", status: "needs_revalidation" },
      { id: "branch-b-verify", status: "needs_revalidation" },
      { id: fixture.rootNodeId, status: "needs_revalidation" },
    ]));
    expect(fixture.runtime.database.get<{ stage: string; revision: number; active_branch_node_id: string }>(
      "SELECT stage, revision, active_branch_node_id FROM workflow_states WHERE tree_id = ?", fixture.tree.treeId,
    )).toEqual({ stage: "branch_implementation", revision: 9, active_branch_node_id: "branch-a" });
    expect(fixture.runtime.database.all<{ branch_node_id: string; status: string }>(
      "SELECT branch_node_id, status FROM workflow_branch_states WHERE tree_revision_id = ? ORDER BY branch_order",
      fixture.tree.revisionId,
    )).toEqual([
      { branch_node_id: "branch-a", status: "active" },
      { branch_node_id: "branch-b", status: "pending" },
    ]);
  });

  it("propagates freshness invalidation through Task dependency edges", async () => {
    const fixture = await sharedBranchesFixture();
    fixture.runtime.database.run("DELETE FROM artifact_graph_relations WHERE tree_revision_id = ?", fixture.tree.revisionId);
    fixture.runtime.database.run("DELETE FROM task_node_artifact_links WHERE id = 'shared-branch-b'");
    fixture.runtime.database.run(`
      INSERT INTO task_relation_edges (
        id, tree_revision_id, from_node_id, to_node_id, kind, artifact_id
      ) VALUES ('branch-b-depends-on-a', ?, 'branch-b-impl', 'branch-a-impl', 'depends_on', NULL)
    `, fixture.tree.revisionId);

    await fixture.runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse",
      session_id: "task-dependency-change",
      cwd: fixture.projectDir,
      tool_name: "Edit",
      tool_use_id: "edit-task-dependency-provider",
      tool_input: { file_path: path.join(fixture.projectDir, "src", "shared.ts") },
      tool_response: { ok: true },
    }));

    expect(fixture.runtime.database.get<{ status: string }>(
      "SELECT status FROM task_nodes WHERE id = 'branch-b-impl'",
    )).toEqual({ status: "needs_revalidation" });
    expect(fixture.runtime.database.get<{ status: string }>(
      "SELECT status FROM task_nodes WHERE id = 'branch-b-verify'",
    )).toEqual({ status: "needs_revalidation" });
  });

  it("invalidates an earlier verified branch without interrupting the current implementation Attempt", async () => {
    const fixture = await sharedBranchesFixture();
    fixture.runtime.database.run(`
      UPDATE workflow_states SET stage = 'branch_implementation', revision = 6,
        active_branch_node_id = 'branch-b' WHERE tree_id = ?
    `, fixture.tree.treeId);
    fixture.runtime.database.run(`
      UPDATE workflow_branch_states SET status = CASE branch_node_id
        WHEN 'branch-a' THEN 'verified' ELSE 'active' END
      WHERE tree_revision_id = ?
    `, fixture.tree.revisionId);
    fixture.runtime.database.run(
      "UPDATE task_nodes SET status = 'running' WHERE id = 'branch-b-impl'",
    );
    fixture.runtime.database.run(`
      INSERT INTO execution_attempts (
        id, project_id, tree_id, task_node_id, task_node_revision_id,
        attempt_number, status, started_at
      ) VALUES ('branch-b-active-attempt', ?, ?, 'branch-b-impl',
        'branch-b-impl-revision', 1, 'running', '2030')
    `, fixture.project.projectId, fixture.tree.treeId);
    fixture.runtime.database.run(
      "UPDATE runtime_states SET selected_node_id = 'branch-b-impl' WHERE project_id = ?",
      fixture.project.projectId,
    );

    await fixture.runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse",
      session_id: "later-branch-change",
      cwd: fixture.projectDir,
      tool_name: "Edit",
      tool_use_id: "later-branch-shared-edit",
      tool_input: { file_path: path.join(fixture.projectDir, "src", "shared.ts") },
      tool_response: { ok: true },
    }));

    expect(fixture.runtime.database.get<{ status: string }>(
      "SELECT status FROM execution_attempts WHERE id = 'branch-b-active-attempt'",
    )).toEqual({ status: "running" });
    expect(fixture.runtime.database.all<{ id: string; status: string }>(`
      SELECT id, status FROM task_nodes
      WHERE id IN ('branch-a-impl', 'branch-a-verify', 'branch-b-impl', 'branch-b-verify')
      ORDER BY id
    `)).toEqual([
      { id: "branch-a-impl", status: "needs_revalidation" },
      { id: "branch-a-verify", status: "needs_revalidation" },
      { id: "branch-b-impl", status: "running" },
      { id: "branch-b-verify", status: "needs_revalidation" },
    ]);
    expect(fixture.runtime.database.get<{ stage: string; revision: number; active_branch_node_id: string }>(
      "SELECT stage, revision, active_branch_node_id FROM workflow_states WHERE tree_id = ?", fixture.tree.treeId,
    )).toEqual({ stage: "branch_implementation", revision: 7, active_branch_node_id: "branch-b" });
    expect(fixture.runtime.database.all<{ branch_node_id: string; status: string }>(
      "SELECT branch_node_id, status FROM workflow_branch_states WHERE tree_revision_id = ? ORDER BY branch_order",
      fixture.tree.revisionId,
    )).toEqual([
      { branch_node_id: "branch-a", status: "pending" },
      { branch_node_id: "branch-b", status: "active" },
    ]);
  });

  it("aborts an in-flight verification Attempt when an earlier implementation fact becomes stale", async () => {
    const fixture = await sharedBranchesFixture();
    fixture.runtime.database.run(`
      UPDATE workflow_states SET stage = 'branch_verification', revision = 6,
        active_branch_node_id = 'branch-a' WHERE tree_id = ?
    `, fixture.tree.treeId);
    fixture.runtime.database.run(`
      UPDATE workflow_branch_states SET status = CASE branch_node_id
        WHEN 'branch-a' THEN 'implemented' ELSE 'pending' END
      WHERE tree_revision_id = ?
    `, fixture.tree.revisionId);
    fixture.runtime.database.run("UPDATE task_nodes SET status = 'verifying' WHERE id = 'branch-a-verify'");
    fixture.runtime.database.run(`
      INSERT INTO execution_attempts (
        id, project_id, tree_id, task_node_id, task_node_revision_id,
        attempt_number, status, started_at
      ) VALUES ('stale-verification-attempt', ?, ?, 'branch-a-verify',
        'branch-a-verify-revision', 1, 'verifying', '2030')
    `, fixture.project.projectId, fixture.tree.treeId);
    fixture.runtime.database.run(
      "UPDATE runtime_states SET selected_node_id = 'branch-a-verify' WHERE project_id = ?",
      fixture.project.projectId,
    );

    await fixture.runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse",
      session_id: "verification-invalidated",
      cwd: fixture.projectDir,
      tool_name: "Edit",
      tool_use_id: "edit-during-verification",
      tool_input: { file_path: path.join(fixture.projectDir, "src", "shared.ts") },
      tool_response: { ok: true },
    }));

    expect(fixture.runtime.database.get<{ status: string; completed_at: string | null }>(
      "SELECT status, completed_at FROM execution_attempts WHERE id = 'stale-verification-attempt'",
    )).toMatchObject({ status: "aborted", completed_at: expect.any(String) });
    expect(fixture.runtime.database.get<{ status: string }>(
      "SELECT status FROM task_nodes WHERE id = 'branch-a-verify'",
    )).toEqual({ status: "needs_revalidation" });
    expect(fixture.runtime.database.get<{ stage: string; revision: number; active_branch_node_id: string }>(
      "SELECT stage, revision, active_branch_node_id FROM workflow_states WHERE tree_id = ?", fixture.tree.treeId,
    )).toEqual({ stage: "branch_implementation", revision: 7, active_branch_node_id: "branch-a" });
  });

  it("rejects stale revisions, non-final workflows, and another Project's tree", async () => {
    const stale = await finalStageFixture();
    expect(() => stale.runtime.finalReports.finalize({
      projectId: stale.project.projectId, treeId: stale.tree.treeId,
      workflowRevision: 7, idempotencyKey: "stale",
    })).toThrow(expect.objectContaining({ code: "revision_conflict" }));
    stale.runtime.database.run("UPDATE workflow_states SET stage = 'root_verification' WHERE tree_id = ?", stale.tree.treeId);
    expect(() => stale.runtime.finalReports.finalize({
      projectId: stale.project.projectId, treeId: stale.tree.treeId,
      workflowRevision: 8, idempotencyKey: "early",
    })).toThrow(expect.objectContaining({ code: "workflow_transition_rejected" }));

    const otherDir = path.join(stale.directory, "other-project");
    await mkdir(otherDir);
    const other = await stale.runtime.projects.resolve(otherDir, "persist");
    expect(() => stale.runtime.finalReports.finalize({
      projectId: other.projectId, treeId: stale.tree.treeId,
      workflowRevision: 8, idempotencyKey: "cross-project",
    })).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(stale.runtime.finalReports.list(other.projectId, { treeId: stale.tree.treeId })).toEqual([]);
  });

  it.each(["active_attempt", "blocking_drift", "pending_confirmation", "pending_change"] as const)(
    "rejects completion while %s remains",
    async (blocker) => {
      const fixture = await finalStageFixture();
      if (blocker === "active_attempt") {
        const nodeRevisionId = fixture.runtime.database.get<{ id: string }>(
          "SELECT id FROM task_node_revisions WHERE tree_revision_id = ? LIMIT 1", fixture.tree.revisionId,
        )!.id;
        fixture.runtime.database.run(`
          INSERT INTO execution_attempts (
            id, project_id, tree_id, task_node_id, task_node_revision_id,
            attempt_number, status, started_at, completed_at
          ) VALUES ('active-attempt', ?, ?, ?, ?, 1, 'running', '2030', NULL)
        `, fixture.project.projectId, fixture.tree.treeId, fixture.rootNodeId, nodeRevisionId);
      } else if (blocker === "blocking_drift") {
        fixture.runtime.database.run(`
          INSERT INTO trace_events (
            id, project_id, tree_id, node_id, session_id, event_name, payload_json,
            occurred_at, idempotency_key, execution_context_json
          ) VALUES ('drift-trace', ?, ?, ?, 'run', 'PostToolUse', '{}', '2030', 'drift-trace', '{}')
        `, fixture.project.projectId, fixture.tree.treeId, fixture.rootNodeId);
        fixture.runtime.database.run(`
          INSERT INTO plan_drift_records (
            id, project_id, tree_id, task_node_id, planned_artifact_id, actual_artifact_id,
            drift_type, severity, trace_event_id, drift_explanation, agent_recommendation,
            resolution_status, user_decision, description, created_at
          ) VALUES ('blocking-drift', ?, ?, ?, NULL, NULL, 'unexpected_artifact', 'blocking',
            'drift-trace', 'blocking', NULL, 'pending_user_confirmation', NULL, 'blocking', '2030')
        `, fixture.project.projectId, fixture.tree.treeId, fixture.rootNodeId);
      } else if (blocker === "pending_confirmation") {
        fixture.runtime.database.run(`
          INSERT INTO runtime_confirmation_prompts (
            id, project_id, tree_id, scope_id, prompt, status, answer,
            answer_trace_event_id, created_at, resolved_at
          ) VALUES ('pending-confirmation', ?, ?, 'root', 'Confirm?', 'pending', NULL, NULL, '2030', NULL)
        `, fixture.project.projectId, fixture.tree.treeId);
      } else {
        fixture.runtime.database.run(`
          INSERT INTO trace_events (
            id, project_id, tree_id, node_id, session_id, event_name, payload_json,
            occurred_at, idempotency_key, execution_context_json
          ) VALUES ('change-trace', ?, ?, ?, 'run', 'UserPromptSubmit', '{}', '2030', 'change-trace', '{}')
        `, fixture.project.projectId, fixture.tree.treeId, fixture.rootNodeId);
        fixture.runtime.database.run(`
          INSERT INTO runtime_actions (id, project_id, kind, input_json, result_json, created_at)
          VALUES ('change-action', ?, 'scope_change', '{}', '{}', '2030')
        `, fixture.project.projectId);
        fixture.runtime.database.run(`
          INSERT INTO user_change_requests (
            id, project_id, tree_id, task_node_id, change_type, source_trace_event_id,
            expected_tree_revision_id, summary, change_impact_json, proposed_document_json,
            priority_target_node_id, prior_node_status, status, runtime_action_id,
            created_at, updated_at, resolved_at
          ) VALUES ('pending-change', ?, ?, ?, 'scope_change', 'change-trace', ?, 'pending', '{}',
            NULL, NULL, NULL, 'proposed', 'change-action', '2030', '2030', NULL)
        `, fixture.project.projectId, fixture.tree.treeId, fixture.rootNodeId, fixture.tree.revisionId);
      }

      expect(() => fixture.runtime.finalReports.finalize({
        projectId: fixture.project.projectId, treeId: fixture.tree.treeId,
        workflowRevision: 8, idempotencyKey: blocker,
      })).toThrow(expect.objectContaining({ code: "workflow_transition_rejected" }));
      expect(fixture.runtime.database.all("SELECT id FROM final_reports")).toEqual([]);
      expect(fixture.runtime.database.get("SELECT status FROM task_trees WHERE id = ?", fixture.tree.treeId))
        .not.toEqual({ status: "completed" });
    },
  );

  it("allows selecting a completed tree for inspection without reactivating its Workflow", async () => {
    const fixture = await finalStageFixture();
    fixture.runtime.finalReports.finalize({
      projectId: fixture.project.projectId, treeId: fixture.tree.treeId,
      workflowRevision: 8, idempotencyKey: "complete-for-inspection",
    });
    await fixture.runtime.taskTrees.createTaskRoot({
      projectId: fixture.project.projectId, title: "Current work",
    });

    expect(fixture.runtime.taskTrees.selectTaskTree({
      projectId: fixture.project.projectId, treeId: fixture.tree.treeId,
    })).toMatchObject({ selected: true, status: "completed" });
    expect(fixture.runtime.queries.getRuntimeSnapshot(fixture.project.projectId)).toMatchObject({
      selectedTreeId: fixture.tree.treeId,
      workflow: null,
    });
    expect(fixture.runtime.database.all(
      "SELECT id FROM workflow_states WHERE project_id = ? AND active = 1",
      fixture.project.projectId,
    )).toEqual([]);
  });

  it("rolls back the report when Task Tree completion cannot commit", async () => {
    const fixture = await finalStageFixture();
    fixture.runtime.database.run(`
      CREATE TRIGGER test_reject_tree_completion
      BEFORE UPDATE OF status ON task_trees WHEN NEW.status = 'completed'
      BEGIN SELECT RAISE(ABORT, 'test completion failure'); END
    `);
    expect(() => fixture.runtime.finalReports.finalize({
      projectId: fixture.project.projectId, treeId: fixture.tree.treeId,
      workflowRevision: 8, idempotencyKey: "rollback",
    })).toThrow(expect.objectContaining({ code: "storage_failure" }));
    expect(fixture.runtime.database.all("SELECT id FROM final_reports")).toEqual([]);
    expect(fixture.runtime.database.get("SELECT active FROM workflow_states WHERE tree_id = ?", fixture.tree.treeId))
      .toEqual({ active: 1 });
  });
});
