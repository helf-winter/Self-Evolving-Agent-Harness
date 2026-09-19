import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openRuntime } from "../../application/runtime.js";
import { HarnessError } from "../../domain/errors.js";
import type { TaskTreeDocument } from "../../domain/task-tree.js";

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function failure(error: unknown) {
  const normalized = error instanceof HarnessError ? error : new HarnessError("storage_failure", error instanceof Error ? error.message : String(error));
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: { code: normalized.code, message: normalized.message, details: normalized.details ?? null } }) }] };
}

const cwdSchema = z.string().min(1).optional().describe("Project directory; defaults to the MCP process cwd");

export function createMcpServer(environment: NodeJS.ProcessEnv = process.env) {
  const runtime = openRuntime(environment);
  const server = new McpServer({ name: "agent-harness", version: "0.1.0" });
  const useCwd = (cwd?: string) => cwd ?? process.cwd();
  const persistedProject = async (cwd?: string) => {
    const project = await runtime.projects.resolve(useCwd(cwd), "persist");
    if (project.status === "identity_conflict") throw new HarnessError("project_identity_conflict", "project marker conflicts with this directory");
    return project;
  };
  const existingProject = async (cwd?: string) => {
    const project = await runtime.projects.resolve(useCwd(cwd), "inspect");
    if (project.status === "new_project") throw new HarnessError("project_not_registered", "current directory has no Harness project");
    if (project.status === "identity_conflict") throw new HarnessError("project_identity_conflict", "project marker conflicts with this directory");
    return project;
  };
  const guarded = <T>(handler: () => Promise<T> | T) => Promise.resolve().then(handler).then(result, failure);

  server.registerTool("harness_get_runtime_snapshot", {
    description: "Get compact Harness runtime state for the current project.", inputSchema: { cwd: cwdSchema },
  }, ({ cwd }) => guarded(async () => runtime.queries.getRuntimeSnapshot((await existingProject(cwd)).projectId)));

  server.registerTool("harness_list_task_tree_candidates", {
    description: "List deterministic Task Tree candidates scoped to the current project.",
    inputSchema: { cwd: cwdSchema, query: z.string().optional() },
  }, ({ cwd, query }) => guarded(async () => runtime.taskTrees.listTaskTreeCandidates({ projectId: (await existingProject(cwd)).projectId, ...(query ? { query } : {}) })));

  server.registerTool("harness_create_task_root", {
    description: "Create an explicit Task Tree root for the current project.",
    inputSchema: { cwd: cwdSchema, title: z.string().min(1) },
  }, ({ cwd, title }) => guarded(async () => runtime.taskTrees.createTaskRoot({ projectId: (await persistedProject(cwd)).projectId, title })));

  server.registerTool("harness_save_draft_revision", {
    description: "Save a complete validated Task Tree as a new immutable draft revision.",
    inputSchema: { cwd: cwdSchema, treeId: z.string(), baseRevisionId: z.string(), document: z.unknown() },
  }, ({ cwd, treeId, baseRevisionId, document }) => guarded(async () => runtime.taskTrees.saveDraftRevision({ projectId: (await existingProject(cwd)).projectId, treeId, baseRevisionId, document: document as TaskTreeDocument })));

  server.registerTool("harness_apply_draft_change_set", {
    description: "Apply a documented local refinement as a new immutable Task Tree revision.",
    inputSchema: {
      cwd: cwdSchema, treeId: z.string(), baseRevisionId: z.string(), document: z.unknown(),
      affectedReferences: z.array(z.string()), decisionSummary: z.string().min(1),
    },
  }, ({ cwd, treeId, baseRevisionId, document, affectedReferences, decisionSummary }) => guarded(async () => runtime.taskTrees.applyDraftChangeSet({
    projectId: (await existingProject(cwd)).projectId, treeId, baseRevisionId,
    operations: [{ op: "replace_document", document: document as TaskTreeDocument }], affectedReferences, decisionSummary,
  })));

  server.registerTool("harness_scan_plan_readiness", {
    description: "Run deterministic structure and Leaf Task Contract checks for a Task Tree or branch scope.",
    inputSchema: { cwd: cwdSchema, treeId: z.string(), scopeRootNodeId: z.string().optional() },
  }, ({ cwd, treeId, scopeRootNodeId }) => guarded(async () => runtime.taskTrees.scanPlanReadiness({
    projectId: (await existingProject(cwd)).projectId, treeId,
    ...(scopeRootNodeId ? { scopeRootNodeId } : {}),
  })));

  server.registerTool("harness_create_confirmation_prompt", {
    description: "Persist a runtime confirmation prompt for an executable Task Tree scope.",
    inputSchema: {
      cwd: cwdSchema, treeId: z.string(), scopeId: z.string(), scopeRootNodeId: z.string().optional(),
      readinessResultId: z.string().optional(), prompt: z.string().min(1), workflowRevision: z.number().int(),
    },
  }, ({ cwd, treeId, scopeId, scopeRootNodeId, readinessResultId, prompt, workflowRevision }) => guarded(async () => runtime.workflows.createConfirmationPrompt({
    projectId: (await existingProject(cwd)).projectId, treeId, scopeId, prompt, workflowRevision,
    ...(scopeRootNodeId ? { scopeRootNodeId } : {}), ...(readinessResultId ? { readinessResultId } : {}),
  })));

  server.registerTool("harness_confirm_scope", {
    description: "Commit a user's recorded yes/no answer to a pending scope confirmation.",
    inputSchema: { cwd: cwdSchema, confirmationId: z.string(), answer: z.enum(["yes", "no"]), answerTraceEventId: z.string(), workflowRevision: z.number().int() },
  }, ({ cwd, confirmationId, answer, answerTraceEventId, workflowRevision }) => guarded(async () => runtime.workflows.confirmScope({
    projectId: (await existingProject(cwd)).projectId, confirmationId, answer, answerTraceEventId, workflowRevision,
  })));

  server.registerTool("harness_get_task_tree_summary", {
    description: "Get the current Task Tree revision, one-hop relations, Artifacts, and Trace count.",
    inputSchema: { cwd: cwdSchema, treeId: z.string() },
  }, ({ cwd, treeId }) => guarded(async () => runtime.queries.getTaskTreeSummary((await existingProject(cwd)).projectId, treeId)));

  server.registerTool("harness_get_task_node_detail", {
    description: "Get one Task Node and paginated evidence from the current project.",
    inputSchema: {
      cwd: cwdSchema, nodeId: z.string(), limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional(),
      attemptLimit: z.number().int().min(1).max(200).optional(), attemptCursor: z.string().optional(),
      evaluationLimit: z.number().int().min(1).max(200).optional(), evaluationCursor: z.string().optional(),
    },
  }, ({ cwd, nodeId, limit, cursor, attemptLimit, attemptCursor, evaluationLimit, evaluationCursor }) => guarded(async () => runtime.queries.getTaskNodeDetail((await existingProject(cwd)).projectId, nodeId, {
    ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}),
    ...(attemptLimit ? { attemptLimit } : {}), ...(attemptCursor ? { attemptCursor } : {}),
    ...(evaluationLimit ? { evaluationLimit } : {}), ...(evaluationCursor ? { evaluationCursor } : {}),
  })));

  server.registerTool("harness_get_trace_events", {
    description: "Get paginated redacted Trace facts for the current project.",
    inputSchema: { cwd: cwdSchema, treeId: z.string().optional(), nodeId: z.string().optional(), limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional() },
  }, ({ cwd, treeId, nodeId, limit, cursor }) => guarded(async () => runtime.queries.getTraceEvents((await existingProject(cwd)).projectId, {
    ...(treeId ? { treeId } : {}), ...(nodeId ? { nodeId } : {}), ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}),
  })));

  server.registerTool("harness_start_node_attempt", {
    description: "Start an evidence-backed Execution Attempt for the current Task Node revision.",
    inputSchema: { cwd: cwdSchema, nodeId: z.string().min(1), expectedTreeRevisionId: z.string().min(1) },
  }, ({ cwd, nodeId, expectedTreeRevisionId }) => guarded(async () => runtime.executions.startAttempt({
    projectId: (await existingProject(cwd)).projectId, nodeId, expectedTreeRevisionId,
  })));

  server.registerTool("harness_begin_node_verification", {
    description: "Move a running Execution Attempt into verification.",
    inputSchema: { cwd: cwdSchema, attemptId: z.string().min(1) },
  }, ({ cwd, attemptId }) => guarded(async () => runtime.executions.beginVerification({
    projectId: (await existingProject(cwd)).projectId, attemptId, expectedStatus: "running",
  })));

  server.registerTool("harness_attach_attempt_evidence", {
    description: "Link a declared evidence key to a same-scope Trace Event produced during an attempt.",
    inputSchema: { cwd: cwdSchema, attemptId: z.string().min(1), requiredEvidenceKey: z.string().min(1), traceEventId: z.string().min(1) },
  }, ({ cwd, attemptId, requiredEvidenceKey, traceEventId }) => guarded(async () => runtime.executions.attachEvidence({
    projectId: (await existingProject(cwd)).projectId, attemptId, requiredEvidenceKey, traceEventId,
  })));

  server.registerTool("harness_evaluate_node_attempt", {
    description: "Persist an immutable Evaluation and apply deterministic Task Node lifecycle policy.",
    inputSchema: { cwd: cwdSchema, attemptId: z.string().min(1), proposedVerdict: z.enum(["succeeded", "failed", "blocked", "uncertain"]), riskSummary: z.string().nullable().optional() },
  }, ({ cwd, attemptId, proposedVerdict, riskSummary }) => guarded(async () => runtime.evaluations.evaluateAttempt({
    projectId: (await existingProject(cwd)).projectId, attemptId, proposedVerdict, riskSummary: riskSummary ?? null,
  })));

  return { server, close: async () => { await server.close(); runtime.close(); } };
}

export async function startMcpServer(): Promise<void> {
  const harness = createMcpServer();
  await harness.server.connect(new StdioServerTransport());
}

if (process.argv[1]?.endsWith("mcp.mjs") || process.argv[1]?.endsWith("mcp-server.ts")) await startMcpServer();
