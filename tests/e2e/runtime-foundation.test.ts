import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("runtime foundation vertical slice", () => {
  it("persists planning, confirmation, Trace, and Artifact state across a runtime restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-e2e-")); dirs.push(directory);
    const projectDir = path.join(directory, "project");
    await import("node:fs/promises").then((fs) => fs.mkdir(projectDir));
    const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") };
    const first = openRuntime(environment);
    const project = await first.projects.resolve(projectDir, "persist");
    const root = await first.taskTrees.createTaskRoot({ projectId: project.projectId, title: "Add health endpoint" });
    const document = {
      nodes: [
        { id: "health-root", parentId: null, title: "Add health endpoint", children: ["health-leaf"] },
        {
          id: "health-leaf", parentId: "health-root", title: "Implement route", children: [],
          objectives: ["Expose health state"], expectedOutputs: ["src/health.ts"], acceptanceCriteria: ["returns ok"],
          unresolvedQuestions: [], unresolvedDecisions: [], dependencies: [], requiredEvidence: [{ key: "route-test", description: "route test" }],
          executionPhase: "implementation" as const, stopDecompositionReason: "one independently testable route",
        },
      ],
      relations: [],
      artifacts: [{ id: "health-file", kind: "file" as const, locator: "src/health.ts", status: "draft" as const }],
    };
    first.taskTrees.saveDraftRevision({ projectId: project.projectId, treeId: root.treeId, baseRevisionId: root.revisionId, document });
    expect(first.taskTrees.scanPlanReadiness({ projectId: project.projectId, treeId: root.treeId }).ready).toBe(true);
    const confirmation = first.workflows.createConfirmationPrompt({ projectId: project.projectId, treeId: root.treeId, scopeId: root.treeId, prompt: "Execute this tree?", workflowRevision: 3 });
    const answer = await first.hooks.ingest(mapClaudeHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: projectDir, prompt: "yes" }));
    if (!answer.recorded) throw new Error("answer Trace was not recorded");
    first.workflows.confirmScope({ projectId: project.projectId, confirmationId: confirmation.confirmationId, answer: "yes", answerTraceEventId: answer.eventId, workflowRevision: 3 });
    await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "s1", cwd: projectDir, tool_name: "Write", tool_use_id: "write-1",
      tool_input: { file_path: path.join(projectDir, "src", "health.ts") }, tool_response: { ok: true },
    }));
    first.close();

    const reopened = openRuntime(environment);
    try {
      const resolved = await reopened.projects.resolve(projectDir, "inspect");
      const snapshot = reopened.queries.getRuntimeSnapshot(resolved.projectId);
      const summary = reopened.queries.getTaskTreeSummary(resolved.projectId, root.treeId);
      expect(snapshot).toMatchObject({ workflow: { stage: "skeleton_pass", revision: 4 }, pendingConfirmation: null });
      expect(summary.traceCount).toBe(2);
      expect(summary.artifacts.some((artifact) => artifact.status === "modified")).toBe(true);
      expect(reopened.queries.getTaskNodeDetail(resolved.projectId, "health-leaf", { limit: 10 }).node.title).toBe("Implement route");
    } finally {
      reopened.close();
    }
  });
});
