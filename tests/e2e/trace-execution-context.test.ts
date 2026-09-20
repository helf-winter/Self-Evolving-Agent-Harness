import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Trace Execution Context vertical slice", () => {
  it("restores model continuity after restart and queries one Project run", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-context-e2e-"));
    dirs.push(directory);
    const projectDir = path.join(directory, "project");
    await mkdir(projectDir);
    const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") };

    const first = openRuntime(environment);
    const project = await first.projects.resolve(projectDir, "persist");
    await first.taskTrees.createTaskRoot({ projectId: project.projectId, title: "Persist execution context" });
    await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "SessionStart", session_id: "run-resume", cwd: projectDir,
      model: "glm-5.3", source: "resume",
    }));
    first.close();

    const reopened = openRuntime(environment);
    try {
      await reopened.hooks.ingest(mapClaudeHook({
        hook_event_name: "UserPromptSubmit", session_id: "run-resume", cwd: projectDir,
        prompt_id: "prompt-after-restart", prompt: "continue",
      }));
      await reopened.hooks.ingest(mapClaudeHook({
        hook_event_name: "UserPromptSubmit", session_id: "different-run", cwd: projectDir,
        prompt: "separate",
      }));

      const events = reopened.queries.getTraceEvents(project.projectId, { runId: "run-resume", limit: 10 }).items;
      expect(events).toHaveLength(2);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventName: "SessionStart", executionContext: expect.objectContaining({ modelInfo: { id: "glm-5.3" }, launchMethod: "resume" }) }),
        expect.objectContaining({ eventName: "UserPromptSubmit", executionContext: expect.objectContaining({ modelInfo: { id: "glm-5.3" }, launchMethod: "resume" }) }),
      ]));
      expect(events.every((event) => event.sessionId === "run-resume")).toBe(true);
    } finally {
      reopened.close();
    }
  });
});
