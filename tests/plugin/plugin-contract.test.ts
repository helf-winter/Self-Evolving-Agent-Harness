import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve("plugin");

describe("Claude plugin contract", () => {
  it("has valid metadata and self-contained MCP and hook commands", async () => {
    const manifest = JSON.parse(await readFile(path.join(root, ".claude-plugin", "plugin.json"), "utf8")) as { name: string };
    expect(manifest.name).toBe("agent-harness");
    const mcp = JSON.parse(await readFile(path.join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(mcp.mcpServers["agent-harness"]?.args.join(" ")).toContain("${CLAUDE_PLUGIN_ROOT}/runtime/mcp.mjs");
    const hooksText = await readFile(path.join(root, "hooks", "hooks.json"), "utf8");
    const hooks = JSON.parse(hooksText) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(Object.keys(hooks.hooks).sort()).toEqual(["PostToolUse", "PostToolUseFailure", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "StopFailure", "UserPromptExpansion", "UserPromptSubmit"].sort());
    for (const registrations of Object.values(hooks.hooks)) {
      for (const registration of registrations) for (const hook of registration.hooks) {
        expect(hook.command).toContain("${CLAUDE_PLUGIN_ROOT}/runtime/hook.mjs");
        expect(hook.command).not.toContain("../");
      }
    }
  });

  it("ships five discoverable, narrowly triggered Skills", async () => {
    const expected = ["branch-execution", "drift-handling", "task-tree-planning", "taskroot", "verification-reporting"];
    expect((await readdir(path.join(root, "skills"))).sort()).toEqual(expected);
    for (const name of expected) {
      const source = await readFile(path.join(root, "skills", name, "SKILL.md"), "utf8");
      const match = source.match(/^---\r?\nname: ([^\r\n]+)\r?\ndescription: ([^\r\n]+)\r?\n---/);
      expect(match?.[1]).toBe(name);
      expect(match?.[2]).toMatch(/^Use when /);
    }
  });

  it("runs the compiled CLI from a non-ASCII plugin path", () => {
    const result = spawnSync(process.execPath, [path.join(root, "runtime", "cli.mjs"), "doctor", "--json"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ sqlite: { ok: true } });
  });

  it("runs a compiled inactive hook silently and without creating project state", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "harness compiled hook "));
    try {
      const input = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd, prompt: "explain" });
      const result = spawnSync(process.execPath, [path.join(root, "runtime", "hook.mjs")], {
        input, encoding: "utf8", env: { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(cwd, "data") },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      await expect(readFile(path.join(cwd, ".agent-harness-project.json"))).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
