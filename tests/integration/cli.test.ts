import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
const entry = path.resolve("src/cli/entry.ts");
const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [tsx, entry, ...args], {
    cwd, encoding: "utf8", env: { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(cwd, ".data") },
  });
}
function lastJson(output: string): unknown {
  return JSON.parse(output.trim().split(/\r?\n/).at(-1)!);
}
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("harness CLI", () => {
  it("reports runtime prerequisites without creating project identity", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "harness-cli-")); dirs.push(cwd);
    const result = run(cwd, ["doctor", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ node: { ok: true }, sqlite: { ok: true } });
    expect(run(cwd, ["project", "inspect", "--json"]).status).toBe(0);
    expect(JSON.parse(run(cwd, ["project", "inspect", "--json"]).stdout).status).toBe("new_project");
  });

  it("creates a task root for the invocation directory and queries its snapshot", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "harness-cli-")); dirs.push(cwd);
    const created = run(cwd, ["taskroot", "Repair auth", "--json"]);
    expect(created.status, created.stderr).toBe(0);
    const tree = JSON.parse(created.stdout) as { treeId: string; title: string };
    expect(tree.title).toBe("Repair auth");
    const snapshot = run(cwd, ["tree", "snapshot", "--json"]);
    expect(JSON.parse(snapshot.stdout)).toMatchObject({ selectedTreeId: tree.treeId, workflow: { stage: "draft_task_tree" } });
    const candidates = run(cwd, ["tree", "candidates", "auth", "--json"]);
    expect(JSON.parse(candidates.stdout)).toHaveLength(1);
  });

  it("uses a stable non-zero exit with structured errors", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "harness-cli-")); dirs.push(cwd);
    const result = run(cwd, ["tree", "summary", "missing", "--json"]);
    expect(result.status).toBe(1);
    expect(lastJson(result.stderr)).toMatchObject({ error: { code: "project_not_registered" } });
  });

  it("starts a node attempt for the project selected by --cwd", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "harness-cli-")); dirs.push(cwd);
    const created = run(cwd, ["taskroot", "Implement runtime", "--json"]);
    const tree = JSON.parse(created.stdout) as { treeId: string; revisionId: string; document: { nodes: Array<{ id: string }> } };
    const database = new RuntimeDatabase(path.join(cwd, ".data", "runtime.db"));
    const nodeId = tree.document.nodes[0]!.id;
    database.run("UPDATE task_nodes SET status = 'ready' WHERE id = ?", nodeId);
    database.run("UPDATE task_node_revisions SET body_json = ? WHERE node_id = ?", JSON.stringify({ id: nodeId, executionPhase: "implementation", dependencies: [], requiredEvidence: [{ key: "test", description: "tests pass" }] }), nodeId);
    database.run("UPDATE workflow_states SET stage = 'branch_implementation' WHERE tree_id = ?", tree.treeId);
    database.close();

    const result = run(cwd, ["node", "attempt-start", nodeId, tree.revisionId, "--cwd", cwd, "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ nodeId, attemptNumber: 1, status: "running" });
  });
});
