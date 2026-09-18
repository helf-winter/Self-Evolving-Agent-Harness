import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HookIngestionService } from "../../src/application/hook-ingestion-service.js";
import { ProjectIdentityService } from "../../src/application/project-identity-service.js";
import { TaskTreeService } from "../../src/application/task-tree-service.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-hook-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "data", "runtime.db"));
  const service = new HookIngestionService(database, new ProjectIdentityService(database));
  return { directory, database, service };
}
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Claude hook ingestion", () => {
  it("rejects malformed hook input at the binding boundary", () => {
    expect(() => mapClaudeHook({ hook_event_name: "PostToolUse" })).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("does not create project state for ordinary conversation without an active workflow", async () => {
    const { directory, database, service } = await fixture();
    const result = await service.ingest(mapClaudeHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: directory, prompt: "explain this" }));
    expect(result).toEqual({ recorded: false, reason: "inactive" });
    expect(database.all("SELECT id FROM projects")).toEqual([]);
    await expect(readFile(path.join(directory, ".agent-harness-project.json"))).rejects.toThrow();
    database.close();
  });

  it("records an early mutation violation but never blocks the tool", async () => {
    const { directory, database, service } = await fixture();
    const event = mapClaudeHook({ hook_event_name: "PreToolUse", session_id: "s1", cwd: directory, tool_name: "Write", tool_use_id: "u1", tool_input: { file_path: path.join(directory, "a.ts"), apiKey: "secret" } });
    expect(await service.ingest(event)).toMatchObject({ recorded: true, violation: true, blocked: false });
    const trace = database.get<{ event_name: string; payload_json: string }>("SELECT event_name, payload_json FROM trace_events");
    expect(trace?.event_name).toBe("workflow_violation");
    expect(trace?.payload_json).not.toContain("secret");
    expect(trace?.payload_json).toContain("[REDACTED]");
    const bashMutation = mapClaudeHook({
      hook_event_name: "PreToolUse", session_id: "s1", cwd: directory, tool_name: "Bash", tool_use_id: "u2",
      tool_input: { command: "printf 'x' > src/a.ts" },
    });
    expect(await service.ingest(bashMutation)).toMatchObject({ recorded: true, violation: true, blocked: false });
    database.close();
  });

  it("deduplicates deliveries and projects successful and failed tool outcomes", async () => {
    const { directory, database, service } = await fixture();
    const identity = new ProjectIdentityService(database);
    const project = await identity.resolve(directory, "persist");
    await new TaskTreeService(database).createTaskRoot({ projectId: project.projectId, title: "Runtime" });
    const success = mapClaudeHook({ hook_event_name: "PostToolUse", session_id: "s1", cwd: directory, tool_name: "Write", tool_use_id: "u1", tool_input: { file_path: path.join(directory, "a.ts") }, tool_response: { ok: true } });
    await service.ingest(success);
    expect(await service.ingest(success)).toEqual({ recorded: false, reason: "duplicate" });
    await service.ingest(mapClaudeHook({ hook_event_name: "PostToolUseFailure", session_id: "s1", cwd: directory, tool_name: "Bash", tool_use_id: "u2", tool_input: { command: "npm test" }, tool_response: { exitCode: 1 } }));
    expect(database.all("SELECT id FROM trace_events")).toHaveLength(2);
    expect(database.get<{ status: string }>("SELECT status FROM artifacts WHERE kind = 'file'")?.status).toBe("observed");
    expect(database.get<{ status: string }>("SELECT status FROM artifacts WHERE kind = 'command'")?.status).toBe("failed");
    database.close();
  });
});
