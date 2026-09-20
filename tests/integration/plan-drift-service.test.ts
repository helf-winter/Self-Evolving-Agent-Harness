import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlanDriftService } from "../../src/application/plan-drift-service.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
const databases: RuntimeDatabase[] = [];

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-drift-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  databases.push(database);
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/project', 'now', 'now')");
  database.run("INSERT INTO task_trees (id, project_id, title, status, current_revision_id, created_at, updated_at) VALUES ('t1', 'p1', 'Tree', 'confirmed', 'tr1', 'now', 'now')");
  database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES ('tr1', 't1', 1, '{}', 'now')");
  database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES ('n1', 't1', NULL, 'Implement', 'running')");
  database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES ('n1-r1', 'n1', 'tr1', '{}', 'now')");
  return { database, service: new PlanDriftService(database) };
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {
      // A test may have closed the database explicitly before teardown.
    }
  }
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PlanDriftService", () => {
  it("records info and warning Drift with paired Trace facts", async () => {
    const { database, service } = await fixture();
    const info = service.recordDrift({
      projectId: "p1", treeId: "t1", nodeId: "n1", driftType: "relation_changed", severity: "info",
      description: "Observed relation differs", explanation: "Runtime evidence changed the relation", recommendation: null,
    });
    const warning = service.recordDrift({
      projectId: "p1", treeId: "t1", nodeId: "n1", driftType: "unexpected_artifact", severity: "warning",
      description: "Unexpected file", explanation: "The selected node did not plan this file", recommendation: "Review the plan",
    });

    expect(info).toMatchObject({ severity: "info", resolutionStatus: "recorded", nodeId: "n1" });
    expect(warning).toMatchObject({ severity: "warning", resolutionStatus: "recorded", nodeId: "n1" });
    expect(database.all<{ event_name: string }>("SELECT event_name FROM trace_events ORDER BY occurred_at, id"))
      .toEqual([{ event_name: "plan_drift" }, { event_name: "plan_drift" }]);
    expect(JSON.parse(database.get<{ payload_json: string }>("SELECT payload_json FROM trace_events WHERE id = ?", warning.traceEventId)!.payload_json))
      .toMatchObject({ driftId: warning.driftId, severity: "warning", driftType: "unexpected_artifact" });
  });

  it("rejects invalid values and blocking Drift without a recommendation", async () => {
    const { service } = await fixture();
    const base = {
      projectId: "p1", treeId: "t1", nodeId: "n1", description: "Changed", explanation: "Changed at runtime", recommendation: "Review",
    };
    expect(() => service.recordDrift({ ...base, driftType: "unknown" as never, severity: "warning" }))
      .toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(() => service.recordDrift({ ...base, driftType: "unexpected_artifact", severity: "critical" as never }))
      .toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(() => service.recordDrift({ ...base, driftType: "unexpected_artifact", severity: "blocking", recommendation: null }))
      .toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("pauses the node and its active attempt for blocking Drift", async () => {
    const { database, service } = await fixture();
    database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at) VALUES ('a1', 'p1', 't1', 'n1', 'n1-r1', 1, 'running', 'now')");

    const drift = service.recordDrift({
      projectId: "p1", treeId: "t1", nodeId: "n1", driftType: "responsibility_changed", severity: "blocking",
      description: "Branch ownership changed", explanation: "The active implementation crossed a confirmed boundary",
      recommendation: "Ask the user whether to revise or cancel the branch",
    });

    expect(drift.resolutionStatus).toBe("pending_user_confirmation");
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = 'n1'")).toEqual({ status: "blocked" });
    expect(database.get<{ status: string; completed_at: string | null }>("SELECT status, completed_at FROM execution_attempts WHERE id = 'a1'"))
      .toMatchObject({ status: "blocked", completed_at: expect.any(String) });
  });
});
