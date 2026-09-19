import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/bindings/claude/mcp-server.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Harness MCP binding", () => {
  it("advertises the approved surface and performs a create/query round trip", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-mcp-")); dirs.push(directory);
    const project = path.join(directory, "project");
    await import("node:fs/promises").then((fs) => fs.mkdir(project));
    const harness = createMcpServer({ ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([harness.server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "harness_apply_draft_change_set", "harness_confirm_scope", "harness_create_confirmation_prompt",
      "harness_create_task_root", "harness_get_runtime_snapshot", "harness_get_task_node_detail",
      "harness_get_task_tree_summary", "harness_get_trace_events", "harness_list_task_tree_candidates",
      "harness_save_draft_revision", "harness_scan_plan_readiness", "harness_start_node_attempt",
      "harness_begin_node_verification", "harness_attach_attempt_evidence", "harness_evaluate_node_attempt",
    ].sort());
    expect(tools.find((tool) => tool.name === "harness_scan_plan_readiness")?.inputSchema).toMatchObject({
      properties: { scopeRootNodeId: { type: "string" } },
    });
    expect(tools.find((tool) => tool.name === "harness_create_confirmation_prompt")?.inputSchema).toMatchObject({
      properties: { scopeRootNodeId: { type: "string" }, readinessResultId: { type: "string" } },
    });
    const created = await client.callTool({ name: "harness_create_task_root", arguments: { cwd: project, title: "Runtime" } });
    expect(created.isError).not.toBe(true);
    const snapshot = await client.callTool({ name: "harness_get_runtime_snapshot", arguments: { cwd: project } });
    const content = (snapshot as { content: Array<{ type: string; text?: string }> }).content;
    const parsed = JSON.parse(content[0]?.type === "text" ? content[0].text ?? "null" : "null") as { workflow: { stage: string } };
    expect(parsed.workflow.stage).toBe("draft_task_tree");
    await client.close();
    await harness.close();
  });
});
