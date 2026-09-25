import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openRuntime } from "../../application/runtime.js";
import { HarnessError } from "../../domain/errors.js";
import type { TaskNodeInput, TaskTreeDocument } from "../../domain/task-tree.js";
import type { FailureReproductionContract, ReproductionValidationObservation } from "../../domain/failure-case.js";
import type { PluginRevisionManifest } from "../../domain/plugin-composition.js";

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function failure(error: unknown) {
  const normalized = error instanceof HarnessError ? error : new HarnessError("storage_failure", error instanceof Error ? error.message : String(error));
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: { code: normalized.code, message: normalized.message, details: normalized.details ?? null } }) }] };
}

const cwdSchema = z.string().min(1).optional().describe("Project directory; defaults to the MCP process cwd");
const failureContractSchema = z.object({
  mode: z.enum(["manual", "assisted", "automated"]),
  preconditions: z.array(z.string().min(1)).min(1),
  environmentManifest: z.record(z.string(), z.string()),
  sourceRevisionRef: z.string().min(1),
  fixtureRefs: z.array(z.string().min(1)).min(1),
  setupSteps: z.array(z.string().min(1)).min(1),
  reproductionSteps: z.array(z.string().min(1)).min(1),
  cleanupSteps: z.array(z.string().min(1)).min(1),
  entryCommand: z.string().min(1).nullable(),
  timeoutMs: z.number().int().positive().nullable(),
  isolationStrategy: z.enum(["fixture", "worktree", "temporary_directory", "project_native", "container", "virtual_environment"]),
  expectedResult: z.string().min(1),
  actualFailure: z.string().min(1),
  failureOracle: z.object({
    kind: z.enum(["exit_code", "assertion", "failure_signature", "artifact_state", "schema"]),
    expression: z.string().min(1),
  }),
  expectedFailureSignature: z.string().min(1).nullable(),
  preFixBaselineRef: z.string().min(1).nullable(),
  postFixBaselineRef: z.string().min(1).nullable(),
  repeatPolicy: z.object({ runs: z.number().int().positive(), allowedFailures: z.number().int().min(0) }),
  automationCoverage: z.number().min(0).max(1),
  evidenceRefs: z.array(z.string().min(1)).min(1),
});
const reproductionObservationSchema = z.object({
  preFixVerdict: z.enum(["red", "not_red", "not_run"]),
  postFixVerdict: z.enum(["green", "not_green", "not_run"]),
  oracleDiscriminationVerdict: z.enum(["pass", "fail", "not_run"]),
  repeatStabilityVerdict: z.enum(["pass", "fail", "not_run"]),
  isolationVerdict: z.enum(["pass", "fail", "not_run"]),
  evidenceRefs: z.array(z.string().min(1)).min(1),
});
const pluginContractSchema = z.object({ contractId: z.string().min(1), version: z.string().min(1) });
const pluginManifestSchema = z.object({
  revision: z.string().min(1),
  provides: z.array(pluginContractSchema), requires: z.array(pluginContractSchema),
  registrations: z.array(z.object({
    key: z.string().min(1), kind: z.enum(["skill", "workflow", "hook", "binding", "runtime_extension"]),
    targetRef: z.string().min(1), disposerKind: z.enum(["unregister_callback", "restart_required", "manual"]),
    disposerRef: z.string().min(1),
  })),
  effects: z.array(z.object({
    key: z.string().min(1), effectType: z.enum(["reversible", "version_reversible", "compensatable", "irreversible"]),
    targetRef: z.string().min(1), operation: z.string().min(1), baselineRef: z.string().nullable(),
    inverseOperation: z.string().nullable(), compensationOperation: z.string().nullable(),
    evidenceRefs: z.array(z.string().min(1)).min(1),
  })),
  metadata: z.record(z.string(), z.unknown()),
});
const pluginRegistrationDispositionSchema = z.object({
  registrationId: z.string().min(1), action: z.enum(["disposed", "retain"]),
  evidenceRefs: z.array(z.string().min(1)).min(1), residualImpact: z.string(),
});
const pluginEffectDispositionSchema = z.object({
  effectId: z.string().min(1), action: z.enum(["inverse_applied", "compensation_applied", "retain"]),
  observedBaselineRef: z.string().nullable(), evidenceRefs: z.array(z.string().min(1)).min(1), residualImpact: z.string(),
});
const refinementDecisionSchema = z.object({
  discussionTopic: z.string().min(1),
  currentUnderstanding: z.string().min(1),
  consideredOptions: z.array(z.string().min(1)).min(1),
  agentRecommendation: z.string().min(1),
  userDecision: z.string().min(1),
});

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
    let project = await runtime.projects.resolve(useCwd(cwd), "inspect");
    if (project.status === "new_project") throw new HarnessError("project_not_registered", "current directory has no Harness project");
    if (project.status === "identity_conflict") throw new HarnessError("project_identity_conflict", "project marker conflicts with this directory");
    if (project.status === "copy_detected" || project.status === "moved_or_renamed") {
      project = await runtime.projects.resolve(useCwd(cwd), "persist");
    }
    return project;
  };
  const guarded = <T>(handler: () => Promise<T> | T) => Promise.resolve().then(handler).then(result, failure);

  server.registerTool("harness_get_project_identity", {
    description: "Inspect the current directory's deterministic Project identity resolution without exposing its identity token.",
    inputSchema: { cwd: cwdSchema },
  }, ({ cwd }) => guarded(async () => runtime.projects.resolve(useCwd(cwd), "inspect")));

  server.registerTool("harness_get_project_clones", {
    description: "List incoming or outgoing Project Clone provenance visible from the current Project.",
    inputSchema: {
      cwd: cwdSchema, direction: z.enum(["incoming", "outgoing", "all"]).optional(),
      status: z.enum(["pending", "cloning", "completed", "incomplete", "failed", "recovered"]).optional(),
      limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional(),
    },
  }, ({ cwd, direction, status, limit, cursor }) => guarded(async () => runtime.queries.getProjectClones(
    (await existingProject(cwd)).projectId,
    { ...(direction ? { direction } : {}), ...(status ? { status } : {}), ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) },
  )));

  server.registerTool("harness_get_project_clone_detail", {
    description: "Get one Project Clone's provenance, rewritten entity maps, and inherited evidence with independent pagination.",
    inputSchema: {
      cwd: cwdSchema, cloneId: z.string().min(1),
      mapLimit: z.number().int().min(1).max(200).optional(), mapCursor: z.string().optional(),
      evidenceLimit: z.number().int().min(1).max(200).optional(), evidenceCursor: z.string().optional(),
    },
  }, ({ cwd, cloneId, mapLimit, mapCursor, evidenceLimit, evidenceCursor }) => guarded(async () => runtime.queries.getProjectCloneDetail(
    (await existingProject(cwd)).projectId, cloneId,
    {
      ...(mapLimit ? { mapLimit } : {}), ...(mapCursor ? { mapCursor } : {}),
      ...(evidenceLimit ? { evidenceLimit } : {}), ...(evidenceCursor ? { evidenceCursor } : {}),
    },
  )));

  server.registerTool("harness_register_plugin_revision", {
    description: "Register one immutable, framework-neutral Runtime Plugin revision and deterministically reconcile its dependencies; no code is loaded or executed.",
    inputSchema: { pluginId: z.string().min(1), manifest: pluginManifestSchema },
  }, ({ pluginId, manifest }) => guarded(() => runtime.plugins.registerRevision({
    pluginId, manifest: manifest as PluginRevisionManifest,
  })));

  server.registerTool("harness_reconcile_plugins", {
    description: "Recompute exact Plugin provides/requires bindings to a fixed point and persist lifecycle transitions.",
    inputSchema: {},
  }, () => guarded(() => runtime.plugins.reconcile()));

  server.registerTool("harness_get_plugins", {
    description: "List installation-scoped Runtime Plugins and their composition state.",
    inputSchema: {
      state: z.enum(["pending_dependency", "active", "suspending", "replacing", "needs_recovery", "disposed"]).optional(),
      limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional(),
    },
  }, ({ state, limit, cursor }) => guarded(() => runtime.plugins.listPlugins({
    ...(state ? { state } : {}), ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}),
  })));

  server.registerTool("harness_get_plugin_detail", {
    description: "Get immutable Plugin revisions, registrations, Effects, dependency edges, and composition transitions.",
    inputSchema: { pluginId: z.string().min(1) },
  }, ({ pluginId }) => guarded(() => runtime.plugins.getPluginDetail(pluginId)));

  server.registerTool("harness_preview_plugin_replacement", {
    description: "Persist a candidate Plugin revision and preview contract diff, dependency impact, suspension order, and Effect risk without activation.",
    inputSchema: { pluginId: z.string().min(1), manifest: pluginManifestSchema },
  }, ({ pluginId, manifest }) => guarded(() => runtime.plugins.previewReplacement({
    pluginId, manifest: manifest as PluginRevisionManifest,
  })));

  server.registerTool("harness_execute_plugin_replacement", {
    description: "Validate evidence-backed registration/Effect dispositions and atomically activate a Plugin candidate or preserve recoverable failure state.",
    inputSchema: {
      replacementId: z.string().min(1), registrationDispositions: z.array(pluginRegistrationDispositionSchema),
      effectDispositions: z.array(pluginEffectDispositionSchema), activationVerdict: z.enum(["succeeded", "failed"]),
      activationEvidenceRefs: z.array(z.string().min(1)).min(1),
    },
  }, ({ replacementId, registrationDispositions, effectDispositions, activationVerdict, activationEvidenceRefs }) => guarded(() => runtime.plugins.executeReplacement({
    replacementId, registrationDispositions, effectDispositions, activationVerdict, activationEvidenceRefs,
  })));

  server.registerTool("harness_recover_plugin_replacement", {
    description: "Record evidence-backed restoration of an old Plugin revision after failed candidate activation.",
    inputSchema: {
      replacementId: z.string().min(1), recoveryVerdict: z.enum(["restored", "failed"]),
      evidenceRefs: z.array(z.string().min(1)).min(1),
    },
  }, ({ replacementId, recoveryVerdict, evidenceRefs }) => guarded(() => runtime.plugins.recoverReplacement({
    replacementId, recoveryVerdict, evidenceRefs,
  })));

  server.registerTool("harness_get_plugin_replacement_detail", {
    description: "Get one Plugin replacement with contract impact and every registration/Effect disposal attempt.",
    inputSchema: { replacementId: z.string().min(1) },
  }, ({ replacementId }) => guarded(() => runtime.plugins.getReplacementDetail(replacementId)));

  server.registerTool("harness_dispose_plugin", {
    description: "Dispose one active Runtime Plugin revision after evidence-backed registration and Effect disposition; stored operations are never executed.",
    inputSchema: {
      pluginId: z.string().min(1), registrationDispositions: z.array(pluginRegistrationDispositionSchema),
      effectDispositions: z.array(pluginEffectDispositionSchema),
    },
  }, ({ pluginId, registrationDispositions, effectDispositions }) => guarded(() => runtime.plugins.disposePlugin({
    pluginId, registrationDispositions, effectDispositions,
  })));

  server.registerTool("harness_reactivate_plugin", {
    description: "Reactivate a disposed Plugin revision after the Binding supplies reload evidence, then reconcile dependents.",
    inputSchema: { pluginId: z.string().min(1), evidenceRefs: z.array(z.string().min(1)).min(1) },
  }, ({ pluginId, evidenceRefs }) => guarded(() => runtime.plugins.reactivatePlugin({ pluginId, evidenceRefs })));

  server.registerTool("harness_get_runtime_snapshot", {
    description: "Get compact Harness runtime state for the current project.", inputSchema: { cwd: cwdSchema },
  }, ({ cwd }) => guarded(async () => runtime.queries.getRuntimeSnapshot((await existingProject(cwd)).projectId)));

  server.registerTool("harness_list_task_tree_candidates", {
    description: "List deterministic Task Tree candidates scoped to the current project.",
    inputSchema: { cwd: cwdSchema, query: z.string().optional(), includeArchived: z.boolean().optional() },
  }, ({ cwd, query, includeArchived }) => guarded(async () => runtime.taskTrees.listTaskTreeCandidates({
    projectId: (await existingProject(cwd)).projectId,
    ...(query ? { query } : {}), ...(includeArchived ? { includeArchived: true } : {}),
  })));

  server.registerTool("harness_select_task_tree", {
    description: "Select and resume one non-archived Task Tree in the current Project; active Attempts prevent switching.",
    inputSchema: { cwd: cwdSchema, treeId: z.string().min(1) },
  }, ({ cwd, treeId }) => guarded(async () => runtime.taskTrees.selectTaskTree({
    projectId: (await existingProject(cwd)).projectId, treeId,
  })));

  server.registerTool("harness_archive_task_tree", {
    description: "Reversibly archive one Task Tree without deleting revisions or Trace evidence.",
    inputSchema: { cwd: cwdSchema, treeId: z.string().min(1) },
  }, ({ cwd, treeId }) => guarded(async () => runtime.taskTrees.archiveTaskTree({
    projectId: (await existingProject(cwd)).projectId, treeId,
  })));

  server.registerTool("harness_restore_task_tree", {
    description: "Restore an archived Task Tree to its prior status without selecting or executing it.",
    inputSchema: { cwd: cwdSchema, treeId: z.string().min(1) },
  }, ({ cwd, treeId }) => guarded(async () => runtime.taskTrees.restoreTaskTree({
    projectId: (await existingProject(cwd)).projectId, treeId,
  })));

  server.registerTool("harness_create_task_root", {
    description: "Create an explicit Task Tree root for the current project.",
    inputSchema: { cwd: cwdSchema, title: z.string().min(1) },
  }, ({ cwd, title }) => guarded(async () => runtime.taskTrees.createTaskRoot({ projectId: (await persistedProject(cwd)).projectId, title })));

  server.registerTool("harness_save_draft_revision", {
    description: "Save a structurally valid Task Tree draft as a new immutable revision; planning drafts may remain incomplete until readiness succeeds.",
    inputSchema: { cwd: cwdSchema, treeId: z.string(), baseRevisionId: z.string(), document: z.unknown() },
  }, ({ cwd, treeId, baseRevisionId, document }) => guarded(async () => runtime.taskTrees.saveDraftRevision({ projectId: (await existingProject(cwd)).projectId, treeId, baseRevisionId, document: document as TaskTreeDocument })));

  server.registerTool("harness_preview_draft_change_set", {
    description: "Persist a revision-bound impact preview for a proposed Task Tree refinement; cross-branch changes require this preview before apply.",
    inputSchema: { cwd: cwdSchema, treeId: z.string().min(1), baseRevisionId: z.string().min(1), document: z.unknown() },
  }, ({ cwd, treeId, baseRevisionId, document }) => guarded(async () => runtime.taskTrees.previewDraftChangeSet({
    projectId: (await existingProject(cwd)).projectId, treeId, baseRevisionId,
    proposedDocument: document as TaskTreeDocument,
  })));

  server.registerTool("harness_apply_draft_change_set", {
    description: "Atomically apply an evidence-linked Task Tree refinement with a user-visible Decision Record and planning Trace.",
    inputSchema: {
      cwd: cwdSchema, treeId: z.string(), baseRevisionId: z.string(), document: z.unknown(),
      sourceUserMessageTraceEventId: z.string().min(1), previewId: z.string().min(1).optional(),
      decision: refinementDecisionSchema,
    },
  }, ({ cwd, treeId, baseRevisionId, document, sourceUserMessageTraceEventId, previewId, decision }) => guarded(async () => runtime.taskTrees.applyRefinementChangeSet({
    projectId: (await existingProject(cwd)).projectId, treeId, baseRevisionId,
    operations: [{ op: "replace_document", document: document as TaskTreeDocument }],
    sourceUserMessageTraceEventId, ...(previewId ? { previewId } : {}), decision,
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

  server.registerTool("harness_get_task_refinement_history", {
    description: "Get bounded, revision-linked Task Tree refinement Decision Records for the current project.",
    inputSchema: {
      cwd: cwdSchema, treeId: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional(),
    },
  }, ({ cwd, treeId, limit, cursor }) => guarded(async () => runtime.queries.getTaskRefinementHistory(
    (await existingProject(cwd)).projectId, treeId,
    { ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) },
  )));

  server.registerTool("harness_get_planning_decision_detail", {
    description: "Get one Task Tree refinement Decision Record with Change Set, impact, preview, and Trace references.",
    inputSchema: { cwd: cwdSchema, decisionId: z.string().min(1) },
  }, ({ cwd, decisionId }) => guarded(async () => runtime.queries.getPlanningDecisionDetail(
    (await existingProject(cwd)).projectId, decisionId,
  )));

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
    description: "Get paginated redacted Trace facts and Execution Context snapshots for the current project.",
    inputSchema: { cwd: cwdSchema, treeId: z.string().optional(), nodeId: z.string().optional(), runId: z.string().optional(), limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional() },
  }, ({ cwd, treeId, nodeId, runId, limit, cursor }) => guarded(async () => runtime.queries.getTraceEvents((await existingProject(cwd)).projectId, {
    ...(treeId ? { treeId } : {}), ...(nodeId ? { nodeId } : {}), ...(runId ? { runId } : {}), ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}),
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

  server.registerTool("harness_get_failure_cases", {
    description: "Get paginated Failure Cases for the current project, filtered by Task scope, maturity, or availability.",
    inputSchema: {
      cwd: cwdSchema, treeId: z.string().optional(), nodeId: z.string().optional(),
      maturityLevel: z.enum(["L0_observed", "L1_manual", "L2_assisted", "L3_automated", "L4_regression"]).optional(),
      availabilityStatus: z.enum(["active", "flaky", "environment_blocked", "quarantined", "obsolete"]).optional(),
      limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional(),
    },
  }, ({ cwd, treeId, nodeId, maturityLevel, availabilityStatus, limit, cursor }) => guarded(async () => runtime.queries.getFailureCases(
    (await existingProject(cwd)).projectId,
    {
      ...(treeId ? { treeId } : {}), ...(nodeId ? { nodeId } : {}),
      ...(maturityLevel ? { maturityLevel } : {}), ...(availabilityStatus ? { availabilityStatus } : {}),
      ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}),
    },
  )));

  server.registerTool("harness_get_failure_case_detail", {
    description: "Get one Failure Case with source Attempt/Evaluation, occurrences, reproduction revisions, validations, and Artifacts.",
    inputSchema: { cwd: cwdSchema, failureCaseId: z.string().min(1) },
  }, ({ cwd, failureCaseId }) => guarded(async () => runtime.queries.getFailureCaseDetail(
    (await existingProject(cwd)).projectId, failureCaseId,
  )));

  server.registerTool("harness_add_failure_reproduction", {
    description: "Append a structured Failure Reproduction Revision. The declared entry command is stored but never executed by this tool.",
    inputSchema: { cwd: cwdSchema, failureCaseId: z.string().min(1), contract: failureContractSchema },
  }, ({ cwd, failureCaseId, contract }) => guarded(async () => runtime.failures.addReproductionRevision({
    projectId: (await existingProject(cwd)).projectId,
    failureCaseId,
    contract: contract as FailureReproductionContract,
  })));

  server.registerTool("harness_validate_failure_reproduction", {
    description: "Record independent evidence-backed reproduction observations and deterministically compute permitted maturity.",
    inputSchema: {
      cwd: cwdSchema, failureCaseId: z.string().min(1), reproductionRevisionId: z.string().min(1),
      observation: reproductionObservationSchema, idempotencyKey: z.string().min(1),
    },
  }, ({ cwd, failureCaseId, reproductionRevisionId, observation, idempotencyKey }) => guarded(async () => runtime.failures.validateReproduction({
    projectId: (await existingProject(cwd)).projectId,
    failureCaseId,
    reproductionRevisionId,
    observation: observation as ReproductionValidationObservation,
    idempotencyKey,
  })));

  server.registerTool("harness_get_skill_evolution_candidates", {
    description: "List eligible Experience records and candidate counts in the current Project and optional Task scope.",
    inputSchema: {
      cwd: cwdSchema, treeId: z.string().optional(), nodeId: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional(),
    },
  }, ({ cwd, treeId, nodeId, limit, cursor }) => guarded(async () => runtime.queries.getSkillEvolutionCandidates(
    (await existingProject(cwd)).projectId,
    { ...(treeId ? { treeId } : {}), ...(nodeId ? { nodeId } : {}), ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) },
  )));

  server.registerTool("harness_get_skill_candidate_detail", {
    description: "Get one Project-scoped frozen Skill candidate with source Experience, tests, quality results, runs, and reports.",
    inputSchema: { cwd: cwdSchema, candidateRevisionId: z.string().min(1) },
  }, ({ cwd, candidateRevisionId }) => guarded(async () => runtime.queries.getSkillCandidateDetail(
    (await existingProject(cwd)).projectId, candidateRevisionId,
  )));

  server.registerTool("harness_freeze_skill_candidate", {
    description: "Freeze an immutable Skill candidate revision from an eligible Project Experience.",
    inputSchema: {
      cwd: cwdSchema, experienceId: z.string().min(1), stableKey: z.string().min(1), name: z.string().min(1),
      triggerContext: z.record(z.string(), z.unknown()), instructionSnapshot: z.string().min(1),
    },
  }, ({ cwd, experienceId, stableKey, name, triggerContext, instructionSnapshot }) => guarded(async () => runtime.evolution.freezeSkillCandidate({
    projectId: (await existingProject(cwd)).projectId, experienceId, stableKey, name, triggerContext, instructionSnapshot,
  })));

  server.registerTool("harness_propose_skill_test_case", {
    description: "Store a draft Skill test definition; quality approval is a separate evidence-backed operation.",
    inputSchema: {
      cwd: cwdSchema, candidateRevisionId: z.string().min(1),
      testType: z.enum(["real_failure_replay", "variation", "holdout", "negative_applicability"]),
      sourceRefs: z.array(z.string().min(1)).min(1), targetBehavior: z.string().min(1),
      applicableContext: z.record(z.string(), z.unknown()), fixtureSetup: z.unknown(), input: z.unknown(),
      expectedResult: z.unknown(), oracle: z.record(z.string(), z.unknown()),
      reproductionCommand: z.string().min(1), timeoutMs: z.number().int().positive(),
      generatedBy: z.string().min(1), leakagePolicy: z.string().min(1),
    },
  }, ({ cwd, candidateRevisionId, testType, sourceRefs, targetBehavior, applicableContext, fixtureSetup, input, expectedResult, oracle, reproductionCommand, timeoutMs, generatedBy, leakagePolicy }) => guarded(async () => runtime.evolution.proposeSkillTestCase({
    projectId: (await existingProject(cwd)).projectId, candidateRevisionId, testType, sourceRefs,
    targetBehavior, applicableContext, fixtureSetup, input, expectedResult, oracle,
    reproductionCommand, timeoutMs, generatedBy, leakagePolicy,
  })));

  server.registerTool("harness_validate_skill_test_quality", {
    description: "Validate a draft Skill test against schema, isolation, reproduction, Oracle, discrimination, stability, split, and Trace gates.",
    inputSchema: {
      cwd: cwdSchema, skillTestCaseId: z.string().min(1), idempotencyKey: z.string().min(1),
      schemaValid: z.boolean(), fixtureIsolated: z.boolean(), failureReproduced: z.boolean(),
      oracleValid: z.boolean(), discriminative: z.boolean(), stable: z.boolean(), splitValid: z.boolean(),
      evidenceRefs: z.array(z.string().min(1)).min(1),
    },
  }, ({ cwd, skillTestCaseId, idempotencyKey, schemaValid, fixtureIsolated, failureReproduced, oracleValid, discriminative, stable, splitValid, evidenceRefs }) => guarded(async () => runtime.evolution.validateSkillTestQuality({
    projectId: (await existingProject(cwd)).projectId, skillTestCaseId, idempotencyKey,
    schemaValid, fixtureIsolated, failureReproduced, oracleValid, discriminative, stable, splitValid, evidenceRefs,
  })));

  server.registerTool("harness_record_skill_validation_run", {
    description: "Record one immutable baseline or Skill-enabled validation repetition with Trace, resource, and side-effect evidence.",
    inputSchema: {
      cwd: cwdSchema, candidateRevisionId: z.string().min(1), skillTestCaseId: z.string().min(1),
      runMode: z.enum(["no_skill_baseline", "skill_enabled"]), repetitionIndex: z.number().int().positive(),
      verdict: z.enum(["passed", "failed", "blocked", "invalid"]),
      tokenUsage: z.number().int().min(0).nullable().optional(), toolCallCount: z.number().int().min(0).nullable().optional(),
      sideEffectRisk: z.enum(["none", "low", "medium", "high", "irreversible"]),
      sideEffectSummary: z.string().min(1), evidenceRefs: z.array(z.string().min(1)).min(1),
    },
  }, ({ cwd, candidateRevisionId, skillTestCaseId, runMode, repetitionIndex, verdict, tokenUsage, toolCallCount, sideEffectRisk, sideEffectSummary, evidenceRefs }) => guarded(async () => runtime.evolution.recordSkillValidationRun({
    projectId: (await existingProject(cwd)).projectId, candidateRevisionId, skillTestCaseId,
    runMode, repetitionIndex, verdict, sideEffectRisk, sideEffectSummary, evidenceRefs,
    ...(tokenUsage !== undefined ? { tokenUsage } : {}), ...(toolCallCount !== undefined ? { toolCallCount } : {}),
  })));

  server.registerTool("harness_generate_skill_validation_report", {
    description: "Aggregate deterministic comparison gates and automatically promote a Skill candidate only when every hard gate passes.",
    inputSchema: { cwd: cwdSchema, candidateRevisionId: z.string().min(1), idempotencyKey: z.string().min(1) },
  }, ({ cwd, candidateRevisionId, idempotencyKey }) => guarded(async () => runtime.evolution.generateSkillValidationReport({
    projectId: (await existingProject(cwd)).projectId, candidateRevisionId, idempotencyKey,
  })));

  server.registerTool("harness_register_task_node_effect", {
    description: "Register an immutable Effect owned by the current active Task Node revision; this records metadata and never executes inverse operations.",
    inputSchema: {
      cwd: cwdSchema, ownerRevisionId: z.string().min(1),
      effectType: z.enum(["reversible", "version_reversible", "compensatable", "irreversible"]),
      targetRef: z.string().min(1), operation: z.string().min(1), baselineRef: z.string().nullable().optional(),
      inverseOperation: z.string().nullable().optional(), compensationOperation: z.string().nullable().optional(),
      evidenceRefs: z.array(z.string().min(1)).min(1),
    },
  }, ({ cwd, ownerRevisionId, effectType, targetRef, operation, baselineRef, inverseOperation, compensationOperation, evidenceRefs }) => guarded(async () => runtime.replacements.registerTaskNodeEffect({
    projectId: (await existingProject(cwd)).projectId, ownerRevisionId, effectType, targetRef, operation,
    baselineRef: baselineRef ?? null, inverseOperation: inverseOperation ?? null,
    compensationOperation: compensationOperation ?? null, evidenceRefs,
  })));

  server.registerTool("harness_get_task_node_effects", {
    description: "List Project-scoped revision-owned Effects and their disposal capabilities/status.",
    inputSchema: {
      cwd: cwdSchema, treeId: z.string().optional(), nodeId: z.string().optional(),
      effectType: z.enum(["reversible", "version_reversible", "compensatable", "irreversible"]).optional(),
      disposalStatus: z.enum(["active", "disposed", "compensated", "conflict", "manual_resolution", "not_disposable"]).optional(),
      limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional(),
    },
  }, ({ cwd, treeId, nodeId, effectType, disposalStatus, limit, cursor }) => guarded(async () => runtime.queries.getTaskNodeEffects(
    (await existingProject(cwd)).projectId,
    {
      ...(treeId ? { treeId } : {}), ...(nodeId ? { nodeId } : {}),
      ...(effectType ? { effectType } : {}), ...(disposalStatus ? { disposalStatus } : {}),
      ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}),
    },
  )));

  server.registerTool("harness_preview_task_node_replacement", {
    description: "Create an immutable candidate and revision-bound high-risk preview without changing the active Task Tree.",
    inputSchema: {
      cwd: cwdSchema, treeId: z.string().min(1), nodeId: z.string().min(1), expectedTreeRevisionId: z.string().min(1),
      candidateBody: z.unknown(), providesContractIds: z.array(z.string().min(1)), requiresContractIds: z.array(z.string().min(1)),
      reason: z.string().min(1), sourceMessageTraceEventId: z.string().min(1),
    },
  }, ({ cwd, treeId, nodeId, expectedTreeRevisionId, candidateBody, providesContractIds, requiresContractIds, reason, sourceMessageTraceEventId }) => guarded(async () => runtime.replacements.previewTaskNodeReplacement({
    projectId: (await existingProject(cwd)).projectId, treeId, nodeId, expectedTreeRevisionId,
    candidateBody: candidateBody as TaskNodeInput, providesContractIds, requiresContractIds, reason, sourceMessageTraceEventId,
  })));

  server.registerTool("harness_confirm_task_node_replacement", {
    description: "Apply the explicit user answer to one Replacement confirmation; only yes suspends the impact closure.",
    inputSchema: {
      cwd: cwdSchema, replacementId: z.string().min(1), answer: z.enum(["yes", "no", "pause"]),
      answerTraceEventId: z.string().min(1),
    },
  }, ({ cwd, replacementId, answer, answerTraceEventId }) => guarded(async () => runtime.replacements.confirmTaskNodeReplacement({
    projectId: (await existingProject(cwd)).projectId, replacementId, answer, answerTraceEventId,
  })));

  const effectDispositionSchema = z.object({
    effectId: z.string().min(1), action: z.enum(["inverse_applied", "compensation_applied", "retain"]),
    observedBaselineRef: z.string().nullable(), evidenceRefs: z.array(z.string().min(1)).min(1),
    residualImpact: z.string(),
  });
  server.registerTool("harness_execute_task_node_replacement", {
    description: "Validate post-confirmation Effect disposition and activation evidence, then atomically activate the candidate or preserve a blocked/failed state.",
    inputSchema: {
      cwd: cwdSchema, replacementId: z.string().min(1), dispositions: z.array(effectDispositionSchema),
      activationVerdict: z.enum(["succeeded", "failed"]), activationEvidenceRefs: z.array(z.string().min(1)).min(1),
    },
  }, ({ cwd, replacementId, dispositions, activationVerdict, activationEvidenceRefs }) => guarded(async () => runtime.replacements.executeTaskNodeReplacement({
    projectId: (await existingProject(cwd)).projectId, replacementId, dispositions,
    activationVerdict, activationEvidenceRefs,
  })));

  server.registerTool("harness_recover_task_node_replacement", {
    description: "Record evidence-backed recovery of a failed activation; compensation or irreversible Effects cannot be described as rollback.",
    inputSchema: {
      cwd: cwdSchema, replacementId: z.string().min(1), recoveryVerdict: z.enum(["restored", "failed"]),
      evidenceRefs: z.array(z.string().min(1)).min(1),
    },
  }, ({ cwd, replacementId, recoveryVerdict, evidenceRefs }) => guarded(async () => runtime.replacements.recoverTaskNodeReplacement({
    projectId: (await existingProject(cwd)).projectId, replacementId, recoveryVerdict, evidenceRefs,
  })));

  server.registerTool("harness_get_task_node_replacements", {
    description: "List Project-scoped Task Node Replacements with optional Tree, Node, status, and pagination filters.",
    inputSchema: {
      cwd: cwdSchema, treeId: z.string().optional(), nodeId: z.string().optional(),
      status: z.enum(["pending_confirmation", "suspending", "disposing", "activating", "completed", "rolled_back", "replacement_failed"]).optional(),
      limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional(),
    },
  }, ({ cwd, treeId, nodeId, status, limit, cursor }) => guarded(async () => runtime.queries.getTaskNodeReplacements(
    (await existingProject(cwd)).projectId,
    { ...(treeId ? { treeId } : {}), ...(nodeId ? { nodeId } : {}), ...(status ? { status } : {}), ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) },
  )));

  server.registerTool("harness_get_task_node_replacement_detail", {
    description: "Get one Replacement with candidate, confirmation, Effects, every disposal attempt, composition transitions, and recovery evidence.",
    inputSchema: { cwd: cwdSchema, replacementId: z.string().min(1) },
  }, ({ cwd, replacementId }) => guarded(async () => runtime.queries.getTaskNodeReplacementDetail(
    (await existingProject(cwd)).projectId, replacementId,
  )));

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
