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

  server.registerTool("harness_get_artifact_graph", {
    description: "Get the current project-scoped Artifact Graph with task links, relations, contracts, and pagination.",
    inputSchema: {
      cwd: cwdSchema, treeId: z.string().optional(), limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional(),
    },
  }, ({ cwd, treeId, limit, cursor }) => guarded(async () => runtime.queries.getArtifactGraphSummary(
    (await existingProject(cwd)).projectId,
    { ...(treeId ? { treeId } : {}), ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) },
  )));

  server.registerTool("harness_get_artifact_detail", {
    description: "Get one Artifact's current state, provenance, Task links, relations, contracts, Trace IDs, and Drift records.",
    inputSchema: { cwd: cwdSchema, artifactId: z.string().min(1) },
  }, ({ cwd, artifactId }) => guarded(async () => runtime.queries.getArtifactDetail(
    (await existingProject(cwd)).projectId, artifactId,
  )));

  server.registerTool("harness_get_plan_drift_summary", {
    description: "Get project-scoped Plan Drift records with optional scope, severity, resolution, and pagination filters.",
    inputSchema: {
      cwd: cwdSchema,
      treeId: z.string().optional(),
      nodeId: z.string().optional(),
      severity: z.enum(["info", "warning", "blocking"]).optional(),
      resolutionStatus: z.enum(["pending_user_confirmation", "accepted", "rejected", "branch_cancelled", "recorded"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
    },
  }, ({ cwd, treeId, nodeId, severity, resolutionStatus, limit, cursor }) => guarded(async () => runtime.queries.getPlanDriftSummary(
    (await existingProject(cwd)).projectId,
    {
      ...(treeId ? { treeId } : {}), ...(nodeId ? { nodeId } : {}), ...(severity ? { severity } : {}),
      ...(resolutionStatus ? { resolutionStatus } : {}), ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}),
    },
  )));

  server.registerTool("harness_record_plan_drift", {
    description: "Record an explicit semantic Plan Drift fact; blocking Drift pauses the affected Task Node pending user confirmation.",
    inputSchema: {
      cwd: cwdSchema,
      treeId: z.string().min(1),
      nodeId: z.string().optional(),
      plannedArtifactId: z.string().optional(),
      actualArtifactId: z.string().optional(),
      driftType: z.enum(["missing_planned_artifact", "unexpected_artifact", "artifact_replaced", "responsibility_changed", "relation_changed"]),
      severity: z.enum(["info", "warning", "blocking"]),
      description: z.string().min(1),
      explanation: z.string().min(1),
      recommendation: z.string().optional(),
      sourceTraceEventId: z.string().optional(),
    },
  }, ({ cwd, treeId, nodeId, plannedArtifactId, actualArtifactId, driftType, severity, description, explanation, recommendation, sourceTraceEventId }) => guarded(async () => runtime.drifts.recordDrift({
    projectId: (await existingProject(cwd)).projectId, treeId, driftType, severity, description, explanation,
    ...(nodeId ? { nodeId } : {}), ...(plannedArtifactId ? { plannedArtifactId } : {}),
    ...(actualArtifactId ? { actualArtifactId } : {}), ...(recommendation ? { recommendation } : {}),
    ...(sourceTraceEventId ? { sourceTraceEventId } : {}),
  })));

  server.registerTool("harness_get_waiting_items", {
    description: "Get paginated pending Runtime Confirmation Prompts for the current project.",
    inputSchema: {
      cwd: cwdSchema,
      promptType: z.enum(["branch_confirmation", "drift_resolution", "change_confirmation", "high_risk_action"]).optional(),
      limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional(),
    },
  }, ({ cwd, promptType, limit, cursor }) => guarded(async () => runtime.queries.getWaitingItems(
    (await existingProject(cwd)).projectId,
    { ...(promptType ? { promptType } : {}), ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) },
  )));

  server.registerTool("harness_get_user_change_requests", {
    description: "Get paginated User Change Requests for the current project with optional scope and lifecycle filters.",
    inputSchema: {
      cwd: cwdSchema, treeId: z.string().optional(), nodeId: z.string().optional(),
      changeType: z.enum(["minor_change", "scope_change", "priority_change"]).optional(),
      status: z.enum(["proposed", "pending_confirmation", "paused", "applied", "rejected", "revision_conflict"]).optional(),
      limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional(),
    },
  }, ({ cwd, treeId, nodeId, changeType, status, limit, cursor }) => guarded(async () => runtime.queries.getUserChangeRequests(
    (await existingProject(cwd)).projectId,
    {
      ...(treeId ? { treeId } : {}), ...(nodeId ? { nodeId } : {}),
      ...(changeType ? { changeType } : {}), ...(status ? { status } : {}),
      ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}),
    },
  )));

  server.registerTool("harness_get_runtime_action_detail", {
    description: "Get one project-scoped Runtime Action with its confirmation and related Drift or User Change.",
    inputSchema: { cwd: cwdSchema, actionId: z.string().min(1) },
  }, ({ cwd, actionId }) => guarded(async () => runtime.queries.getRuntimeActionDetail(
    (await existingProject(cwd)).projectId, actionId,
  )));

  server.registerTool("harness_propose_plan_drift_resolution", {
    description: "Propose a typed blocking Plan Drift decision and create the required confirmation prompt.",
    inputSchema: {
      cwd: cwdSchema, driftId: z.string().min(1), expectedTreeRevisionId: z.string().min(1),
      decision: z.enum(["accepted", "rejected", "branch_cancelled"]),
      reason: z.string().min(1), sourceMessageTraceEventId: z.string().min(1),
    },
  }, ({ cwd, driftId, expectedTreeRevisionId, decision, reason, sourceMessageTraceEventId }) => guarded(async () => runtime.actions.proposePlanDriftResolution({
    projectId: (await existingProject(cwd)).projectId, driftId, expectedTreeRevisionId,
    decision, reason, sourceMessageTraceEventId,
  })));

  server.registerTool("harness_propose_user_change", {
    description: "Record a structured minor, scope, or priority User Change; scope changes create a confirmation prompt.",
    inputSchema: {
      cwd: cwdSchema, treeId: z.string().min(1), nodeId: z.string().optional(), expectedTreeRevisionId: z.string().min(1),
      changeType: z.enum(["minor_change", "scope_change", "priority_change"]), summary: z.string().min(1),
      changeImpact: z.record(z.string(), z.unknown()), sourceMessageTraceEventId: z.string().min(1),
      proposedDocument: z.unknown().optional(), priorityTargetNodeId: z.string().optional(),
    },
  }, ({ cwd, treeId, nodeId, expectedTreeRevisionId, changeType, summary, changeImpact, sourceMessageTraceEventId, proposedDocument, priorityTargetNodeId }) => guarded(async () => runtime.actions.proposeUserChange({
    projectId: (await existingProject(cwd)).projectId, treeId, expectedTreeRevisionId, changeType,
    summary, changeImpact, sourceMessageTraceEventId,
    ...(nodeId ? { nodeId } : {}), ...(proposedDocument ? { proposedDocument: proposedDocument as TaskTreeDocument } : {}),
    ...(priorityTargetNodeId ? { priorityTargetNodeId } : {}),
  })));

  server.registerTool("harness_resolve_runtime_confirmation", {
    description: "Commit, reject, or pause a Drift/User Change Runtime Action using an explicit prompt ID and recorded user-answer Trace.",
    inputSchema: {
      cwd: cwdSchema, confirmationId: z.string().min(1), answer: z.enum(["yes", "no", "pause"]),
      answerTraceEventId: z.string().min(1),
    },
  }, ({ cwd, confirmationId, answer, answerTraceEventId }) => guarded(async () => runtime.actions.resolveConfirmation({
    projectId: (await existingProject(cwd)).projectId, confirmationId, answer, answerTraceEventId,
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
