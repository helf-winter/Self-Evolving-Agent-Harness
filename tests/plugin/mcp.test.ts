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
      "harness_select_task_tree", "harness_archive_task_tree", "harness_restore_task_tree",
      "harness_save_draft_revision", "harness_scan_plan_readiness", "harness_start_node_attempt",
      "harness_begin_node_verification", "harness_attach_attempt_evidence", "harness_evaluate_node_attempt",
      "harness_get_artifact_graph", "harness_get_artifact_detail", "harness_get_plan_drift_summary",
      "harness_record_plan_drift",
      "harness_get_waiting_items", "harness_get_user_change_requests", "harness_get_runtime_action_detail",
      "harness_propose_plan_drift_resolution", "harness_propose_user_change", "harness_resolve_runtime_confirmation",
      "harness_get_failure_cases", "harness_get_failure_case_detail",
      "harness_add_failure_reproduction", "harness_validate_failure_reproduction",
      "harness_get_skill_evolution_candidates", "harness_get_skill_candidate_detail",
      "harness_freeze_skill_candidate", "harness_propose_skill_test_case",
      "harness_validate_skill_test_quality", "harness_record_skill_validation_run",
      "harness_generate_skill_validation_report",
      "harness_register_task_node_effect", "harness_get_task_node_effects",
      "harness_preview_task_node_replacement", "harness_confirm_task_node_replacement",
      "harness_execute_task_node_replacement", "harness_recover_task_node_replacement",
      "harness_get_task_node_replacements", "harness_get_task_node_replacement_detail",
      "harness_get_project_identity", "harness_get_project_clones", "harness_get_project_clone_detail",
      "harness_register_plugin_revision", "harness_reconcile_plugins", "harness_get_plugins", "harness_get_plugin_detail",
      "harness_preview_plugin_replacement", "harness_execute_plugin_replacement", "harness_recover_plugin_replacement",
      "harness_get_plugin_replacement_detail", "harness_dispose_plugin", "harness_reactivate_plugin",
      "harness_preview_draft_change_set", "harness_get_task_refinement_history", "harness_get_planning_decision_detail",
    ].sort());
    expect(tools.find((tool) => tool.name === "harness_scan_plan_readiness")?.inputSchema).toMatchObject({
      properties: { scopeRootNodeId: { type: "string" } },
    });
    expect(tools.find((tool) => tool.name === "harness_list_task_tree_candidates")?.inputSchema).toMatchObject({
      properties: { includeArchived: { type: "boolean" } },
    });
    expect(tools.find((tool) => tool.name === "harness_apply_draft_change_set")?.inputSchema).toMatchObject({
      required: expect.arrayContaining(["sourceUserMessageTraceEventId", "decision"]),
      properties: { previewId: { type: "string" }, decision: { type: "object" } },
    });
    expect(tools.find((tool) => tool.name === "harness_get_task_refinement_history")?.inputSchema).toMatchObject({
      properties: { treeId: { type: "string" }, limit: { type: "integer" } },
    });
    expect(tools.find((tool) => tool.name === "harness_get_trace_events")?.inputSchema).toMatchObject({
      properties: { runId: { type: "string" } },
    });
    expect(tools.find((tool) => tool.name === "harness_create_confirmation_prompt")?.inputSchema).toMatchObject({
      properties: { scopeRootNodeId: { type: "string" }, readinessResultId: { type: "string" } },
    });
    expect(tools.find((tool) => tool.name === "harness_get_plan_drift_summary")?.inputSchema).toMatchObject({
      properties: { severity: { enum: ["info", "warning", "blocking"] }, resolutionStatus: { enum: expect.any(Array) } },
    });
    expect(tools.find((tool) => tool.name === "harness_propose_user_change")?.inputSchema).toMatchObject({
      properties: { changeType: { enum: ["minor_change", "scope_change", "priority_change"] } },
    });
    expect(tools.find((tool) => tool.name === "harness_resolve_runtime_confirmation")?.inputSchema).toMatchObject({
      properties: { answer: { enum: ["yes", "no", "pause"] } },
    });
    expect(tools.find((tool) => tool.name === "harness_add_failure_reproduction")?.inputSchema).toMatchObject({
      properties: { contract: { properties: { mode: { enum: ["manual", "assisted", "automated"] } } } },
    });
    expect(tools.find((tool) => tool.name === "harness_validate_failure_reproduction")?.inputSchema).toMatchObject({
      properties: { observation: { properties: { preFixVerdict: { enum: ["red", "not_red", "not_run"] } } } },
    });
    expect(tools.find((tool) => tool.name === "harness_propose_skill_test_case")?.inputSchema).toMatchObject({
      properties: { testType: { enum: ["real_failure_replay", "variation", "holdout", "negative_applicability"] } },
    });
    expect(tools.find((tool) => tool.name === "harness_record_skill_validation_run")?.inputSchema).toMatchObject({
      properties: { runMode: { enum: ["no_skill_baseline", "skill_enabled"] }, sideEffectRisk: { enum: expect.any(Array) } },
    });
    expect(tools.find((tool) => tool.name === "harness_register_task_node_effect")?.inputSchema).toMatchObject({
      properties: { effectType: { enum: ["reversible", "version_reversible", "compensatable", "irreversible"] } },
    });
    expect(tools.find((tool) => tool.name === "harness_confirm_task_node_replacement")?.inputSchema).toMatchObject({
      properties: { answer: { enum: ["yes", "no", "pause"] } },
    });
    const created = await client.callTool({ name: "harness_create_task_root", arguments: { cwd: project, title: "Runtime" } });
    expect(created.isError).not.toBe(true);
    const createdContent = (created as { content: Array<{ type: string; text?: string }> }).content;
    const createdValue = JSON.parse(createdContent[0]?.type === "text" ? createdContent[0].text ?? "null" : "null") as { treeId: string };
    const second = await client.callTool({ name: "harness_create_task_root", arguments: { cwd: project, title: "Second tree" } });
    const secondContent = (second as { content: Array<{ type: string; text?: string }> }).content;
    const secondValue = JSON.parse(secondContent[0]?.type === "text" ? secondContent[0].text ?? "null" : "null") as { treeId: string };
    expect((await client.callTool({ name: "harness_select_task_tree", arguments: { cwd: project, treeId: createdValue.treeId } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "harness_archive_task_tree", arguments: { cwd: project, treeId: secondValue.treeId } })).isError).not.toBe(true);
    const archivedSelection = await client.callTool({ name: "harness_select_task_tree", arguments: { cwd: project, treeId: secondValue.treeId } });
    expect(archivedSelection.isError).toBe(true);
    const archivedErrorContent = (archivedSelection as { content: Array<{ type: string; text?: string }> }).content;
    expect(JSON.parse(archivedErrorContent[0]?.type === "text" ? archivedErrorContent[0].text ?? "null" : "null"))
      .toMatchObject({ error: { code: "task_tree_transition_rejected" } });
    const archivedCandidates = await client.callTool({
      name: "harness_list_task_tree_candidates", arguments: { cwd: project, includeArchived: true },
    });
    const archivedCandidateContent = (archivedCandidates as { content: Array<{ type: string; text?: string }> }).content;
    expect(JSON.parse(archivedCandidateContent[0]?.type === "text" ? archivedCandidateContent[0].text ?? "null" : "null"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ treeId: secondValue.treeId, status: "archived" })]));
    expect((await client.callTool({ name: "harness_restore_task_tree", arguments: { cwd: project, treeId: secondValue.treeId } })).isError).not.toBe(true);
    const recorded = await client.callTool({
      name: "harness_record_plan_drift",
      arguments: {
        cwd: project, treeId: createdValue.treeId, driftType: "relation_changed", severity: "warning",
        description: "Observed relation changed", explanation: "The implementation differs from the draft",
      },
    });
    expect(recorded.isError).not.toBe(true);
    const drifts = await client.callTool({ name: "harness_get_plan_drift_summary", arguments: { cwd: project, treeId: createdValue.treeId, severity: "warning" } });
    const driftContent = (drifts as { content: Array<{ type: string; text?: string }> }).content;
    const driftValue = JSON.parse(driftContent[0]?.type === "text" ? driftContent[0].text ?? "null" : "null") as { items: unknown[] };
    expect(driftValue.items).toHaveLength(1);
    const graph = await client.callTool({ name: "harness_get_artifact_graph", arguments: { cwd: project, treeId: createdValue.treeId } });
    expect(graph.isError).not.toBe(true);
    expect((await client.callTool({ name: "harness_get_waiting_items", arguments: { cwd: project } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "harness_get_user_change_requests", arguments: { cwd: project } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "harness_get_failure_cases", arguments: { cwd: project } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "harness_get_skill_evolution_candidates", arguments: { cwd: project } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "harness_get_task_node_effects", arguments: { cwd: project } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "harness_get_task_node_replacements", arguments: { cwd: project } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "harness_get_project_identity", arguments: { cwd: project } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "harness_get_project_clones", arguments: { cwd: project } })).isError).not.toBe(true);
    expect((await client.callTool({
      name: "harness_register_plugin_revision",
      arguments: {
        pluginId: "test-runtime-plugin",
        manifest: {
          revision: "1.0.0", provides: [{ contractId: "test-runtime", version: "1" }], requires: [],
          registrations: [], effects: [], metadata: { binding: "test" },
        },
      },
    })).isError).not.toBe(true);
    expect((await client.callTool({ name: "harness_get_plugins", arguments: { state: "active" } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "harness_get_plugin_detail", arguments: { pluginId: "test-runtime-plugin" } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "harness_reconcile_plugins", arguments: {} })).isError).not.toBe(true);
    expect((await client.callTool({
      name: "harness_propose_user_change",
      arguments: {
        cwd: project, treeId: createdValue.treeId, expectedTreeRevisionId: "missing", changeType: "minor_change",
        summary: "Record copy preference", changeImpact: {}, sourceMessageTraceEventId: "missing",
      },
    })).isError).toBe(true);
    const snapshot = await client.callTool({ name: "harness_get_runtime_snapshot", arguments: { cwd: project } });
    const content = (snapshot as { content: Array<{ type: string; text?: string }> }).content;
    const parsed = JSON.parse(content[0]?.type === "text" ? content[0].text ?? "null" : "null") as { workflow: { stage: string } };
    expect(parsed.workflow.stage).toBe("draft_task_tree");
    await client.close();
    await harness.close();
  });
});
