import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";

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
