import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Task affiliation confirmation vertical slice", () => {
  it("does not create a Task Tree until a traced user choice and restores the result after restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-affiliation-e2e-"));
    dirs.push(directory);
    const projectDir = path.join(directory, "project");
    await import("node:fs/promises").then((fs) => fs.mkdir(projectDir));
    const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") };

    const first = openRuntime(environment);
    const project = await first.projects.resolve(projectDir, "persist");
    const proposal = first.affiliations.propose({
      projectId: project.projectId,
      requestTitle: "Add an audit endpoint",
      candidateQuery: "audit endpoint",
      recommendation: "new_tree",
      runId: "affiliation-run",
    });
    expect(first.database.all("SELECT id FROM task_trees")).toEqual([]);
    expect(first.queries.getRuntimeSnapshot(project.projectId)).toMatchObject({
      workflow: null,
      pendingAffiliationCount: 1,
      pendingConfirmation: { confirmationId: proposal.confirmationId, scopeId: proposal.decisionId },
      availableActions: expect.arrayContaining(["resolve_task_affiliation"]),
    });

    const answer = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "affiliation-run",
      cwd: projectDir,
      prompt: "Create a new tree",
    }));
    if (!answer.recorded) throw new Error("answer Trace was not recorded");
    const resolved = await first.affiliations.resolve({
      projectId: project.projectId,
      decisionId: proposal.decisionId,
      choice: "new_tree",
      answerTraceEventId: answer.eventId,
    });
    expect(resolved).toMatchObject({ status: "new_tree", answerTraceEventId: answer.eventId });
    expect(resolved.resolvedTreeId).toEqual(expect.any(String));
    first.close();

    const reopened = openRuntime(environment);
    try {
      const inspected = await reopened.projects.resolve(projectDir, "inspect");
      expect(reopened.affiliations.get(inspected.projectId, proposal.decisionId)).toMatchObject({
        status: "new_tree",
        resolvedTreeId: resolved.resolvedTreeId,
        answerTraceEventId: answer.eventId,
      });
      expect(reopened.queries.getRuntimeSnapshot(inspected.projectId)).toMatchObject({
        selectedTreeId: resolved.resolvedTreeId,
        workflow: { treeId: resolved.resolvedTreeId, stage: "draft_task_tree" },
        pendingAffiliationCount: 0,
        pendingConfirmation: null,
      });
      expect(reopened.database.all<{ event_name: string }>(
        "SELECT event_name FROM trace_events WHERE project_id = ? ORDER BY occurred_at, rowid",
        inspected.projectId,
      ).map((row) => row.event_name)).toEqual([
        "task_affiliation_requested",
        "UserPromptSubmit",
        "task_affiliation_resolved",
      ]);
      expect(reopened.database.get<{ status: string; answer: string }>(
        "SELECT status, answer FROM runtime_confirmation_prompts WHERE id = ?", proposal.confirmationId,
      )).toEqual({ status: "confirmed", answer: "new_tree" });
    } finally {
      reopened.close();
    }
  });
});
