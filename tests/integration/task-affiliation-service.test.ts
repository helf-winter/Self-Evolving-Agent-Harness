import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskAffiliationService } from "../../src/application/task-affiliation-service.js";
import { TaskTreeService } from "../../src/application/task-tree-service.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-affiliation-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/a', 'now', 'now')");
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p2', '/b', 'now', 'now')");
  return { database, service: new TaskAffiliationService(database), trees: new TaskTreeService(database) };
}

function answer(database: RuntimeDatabase, projectId: string, eventId: string, occurredAt = "9999-01-01") {
  database.run(`
    INSERT INTO trace_events (id, project_id, session_id, event_name, payload_json, execution_context_json, occurred_at, idempotency_key)
    VALUES (?, ?, 'run', 'UserPromptSubmit', '{}', '{}', ?, ?)
  `, eventId, projectId, occurredAt, eventId);
}

describe("TaskAffiliationService", () => {
  it("persists bounded deterministic candidates and permits only one pending choice", async () => {
    const { database, service, trees } = await fixture();
    const existing = await trees.createTaskRoot({ projectId: "p1", title: "Authentication repair" });
    const proposed = service.propose({
      projectId: "p1", requestTitle: "Repair authentication token", candidateQuery: "authentication",
      recommendation: "merge", recommendedTreeId: existing.treeId,
    });
    expect(proposed).toMatchObject({
      status: "pending", recommendation: "merge", recommendedTreeId: existing.treeId,
      candidates: [expect.objectContaining({ treeId: existing.treeId, matchedBy: ["title"] })],
      options: ["new_tree", "merge", "pause"],
    });
    expect(database.all("SELECT id FROM task_trees WHERE project_id = 'p1'")).toHaveLength(1);
    expect(() => service.propose({ projectId: "p1", requestTitle: "Second", recommendation: "new_tree" }))
      .toThrow(expect.objectContaining({ code: "confirmation_required" }));
    expect(database.get<{ status: string }>("SELECT status FROM runtime_actions WHERE id = ?", proposed.actionId))
      .toEqual({ status: "pending_confirmation" });
    expect(database.get<{ event_name: string }>("SELECT event_name FROM trace_events WHERE id = ?", proposed.requestTraceEventId))
      .toEqual({ event_name: "task_affiliation_requested" });
    database.close();
  });

  it("resolves merge idempotently with later same-Project evidence and rejects foreign evidence", async () => {
    const { database, service, trees } = await fixture();
    const existing = await trees.createTaskRoot({ projectId: "p1", title: "Runtime" });
    const outsideSnapshot = await trees.createTaskRoot({ projectId: "p1", title: "Unrelated work" });
    const proposal = service.propose({
      projectId: "p1", requestTitle: "Extend runtime", candidateQuery: "runtime",
      recommendation: "merge", recommendedTreeId: existing.treeId,
    });
    answer(database, "p2", "foreign-answer");
    await expect(service.resolve({
      projectId: "p1", decisionId: proposal.decisionId, choice: "merge",
      chosenTreeId: existing.treeId, answerTraceEventId: "foreign-answer",
    })).rejects.toMatchObject({ code: "evidence_scope_mismatch" });
    answer(database, "p1", "merge-answer");
    await expect(service.resolve({
      projectId: "p1", decisionId: proposal.decisionId, choice: "merge",
      chosenTreeId: outsideSnapshot.treeId, answerTraceEventId: "merge-answer",
    })).rejects.toMatchObject({ code: "not_found" });
    const resolved = await service.resolve({
      projectId: "p1", decisionId: proposal.decisionId, choice: "merge",
      chosenTreeId: existing.treeId, answerTraceEventId: "merge-answer",
    });
    expect(resolved).toMatchObject({ status: "merged", resolvedTreeId: existing.treeId, answerTraceEventId: "merge-answer" });
    expect(await service.resolve({
      projectId: "p1", decisionId: proposal.decisionId, choice: "merge",
      chosenTreeId: existing.treeId, answerTraceEventId: "merge-answer",
    })).toEqual(resolved);
    await expect(service.resolve({
      projectId: "p1", decisionId: proposal.decisionId, choice: "pause", answerTraceEventId: "merge-answer",
    })).rejects.toMatchObject({ code: "confirmation_not_applicable" });
    database.close();
  });

  it("creates a new root only after confirmation and pause leaves Task Trees unchanged", async () => {
    const { database, service } = await fixture();
    const newProposal = service.propose({ projectId: "p1", requestTitle: "Build search", recommendation: "new_tree" });
    expect(database.all("SELECT id FROM task_trees WHERE project_id = 'p1'")).toHaveLength(0);
    answer(database, "p1", "new-answer");
    const created = await service.resolve({
      projectId: "p1", decisionId: newProposal.decisionId, choice: "new_tree", answerTraceEventId: "new-answer",
    });
    expect(created).toMatchObject({ status: "new_tree", resolvedTreeId: expect.any(String) });
    expect(database.get<{ title: string }>("SELECT title FROM task_trees WHERE id = ?", created.resolvedTreeId!))
      .toEqual({ title: "Build search" });

    const pauseProposal = service.propose({ projectId: "p2", requestTitle: "Do not start", recommendation: "new_tree" });
    answer(database, "p2", "pause-answer");
    expect(await service.resolve({
      projectId: "p2", decisionId: pauseProposal.decisionId, choice: "pause", answerTraceEventId: "pause-answer",
    })).toMatchObject({ status: "paused", resolvedTreeId: null });
    expect(database.all("SELECT id FROM task_trees WHERE project_id = 'p2'")).toHaveLength(0);
    database.close();
  });
});

