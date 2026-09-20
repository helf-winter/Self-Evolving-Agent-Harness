import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Task Node Replacement vertical slice", () => {
  it("records, confirms, disposes, activates, and reloads a replacement across restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-replacement-e2e-"));
    dirs.push(directory);
    const projectDir = path.join(directory, "project");
    await mkdir(projectDir);
    const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") };

    const first = openRuntime(environment);
    const project = await first.projects.resolve(projectDir, "persist");
    const root = await first.taskTrees.createTaskRoot({ projectId: project.projectId, title: "Provide API" });
    const providerNodeId = root.document.nodes[0]!.id;
    const document: TaskTreeDocument = {
      nodes: [
        { id: providerNodeId, parentId: null, title: "Provide API", children: ["consumer"] },
        {
          id: "consumer", parentId: providerNodeId, title: "Consume API", children: [],
          objectives: ["Consume the API"], expectedOutputs: ["src/consumer.ts"],
          acceptanceCriteria: ["consumer contract test passes"], unresolvedQuestions: [], unresolvedDecisions: [],
          dependencies: [providerNodeId], requiredEvidence: [{ key: "test", description: "consumer contract test" }],
          executionPhase: "implementation", stopDecompositionReason: "one independently testable consumer",
        },
      ],
      relations: [{ fromNodeId: "consumer", toNodeId: providerNodeId, kind: "depends_on" }],
      artifacts: [
        { id: "api-file", kind: "file", locator: "src/api.ts", status: "modified", currentHashOrVersion: "hash:v1" },
        { id: "api-contract-artifact", kind: "contract", locator: "api.contract", status: "planned" },
      ],
      artifactLinks: [{ taskNodeId: providerNodeId, artifactId: "api-file", relationType: "modifies" }],
      artifactContracts: [{
        id: "api-contract", artifactId: "api-contract-artifact", name: "API", version: "1",
        compatibilityPolicy: "exact", schemaOrSignature: "GET /api", providerNodeIds: [providerNodeId],
        consumerNodeIds: ["consumer"], validationRefs: ["npm test"],
      }],
    };
    const revision = first.taskTrees.saveDraftRevision({
      projectId: project.projectId, treeId: root.treeId, baseRevisionId: root.revisionId, document,
    });
    const readiness = first.taskTrees.scanPlanReadiness({ projectId: project.projectId, treeId: root.treeId });
    const workflowRevision = first.database.get<{ revision: number }>(
      "SELECT revision FROM workflow_states WHERE project_id = ? AND tree_id = ? AND active = 1",
      project.projectId, root.treeId,
    )!.revision;
    const treePrompt = first.workflows.createConfirmationPrompt({
      projectId: project.projectId, treeId: root.treeId, scopeId: root.treeId,
      readinessResultId: readiness.resultId, prompt: "Execute this tree?", workflowRevision,
    });
    const treeAnswer = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "tree-confirmation", cwd: projectDir,
      prompt: "yes", timestamp: "2030-01-01T00:00:00.000Z",
    }));
    if (!treeAnswer.recorded) throw new Error("tree confirmation Trace was not recorded");
    first.workflows.confirmScope({
      projectId: project.projectId, confirmationId: treePrompt.confirmationId, answer: "yes",
      answerTraceEventId: treeAnswer.eventId, workflowRevision,
    });

    const ownerRevision = first.database.get<{ id: string }>(
      "SELECT id FROM task_node_revisions WHERE node_id = ? AND tree_revision_id = ?",
      providerNodeId, revision.revisionId,
    )!;
    const effectEvidence = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "effect", cwd: projectDir,
      tool_name: "Edit", tool_use_id: "effect-edit", tool_input: { file_path: path.join(projectDir, "src/api.ts") },
      tool_response: { ok: true }, timestamp: "2030-01-01T00:00:01.000Z",
    }));
    if (!effectEvidence.recorded) throw new Error("effect Trace was not recorded");
    const effect = first.replacements.registerTaskNodeEffect({
      projectId: project.projectId, ownerRevisionId: ownerRevision.id, effectType: "version_reversible",
      targetRef: "artifact:api-file", operation: "modify API implementation", baselineRef: "hash:v1",
      inverseOperation: "restore recorded API patch", compensationOperation: null,
      evidenceRefs: [effectEvidence.eventId],
    });

    const request = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "replacement-request", cwd: projectDir,
      prompt: "Replace the provider implementation while preserving its API contract",
      timestamp: "2030-01-01T00:00:02.000Z",
    }));
    if (!request.recorded) throw new Error("replacement request Trace was not recorded");
    const preview = first.replacements.previewTaskNodeReplacement({
      projectId: project.projectId, treeId: root.treeId, nodeId: providerNodeId,
      expectedTreeRevisionId: revision.revisionId,
      candidateBody: { id: providerNodeId, parentId: null, title: "Provide API v2", children: ["consumer"] },
      providesContractIds: ["api-contract"], requiresContractIds: [], reason: "Upgrade the provider implementation",
      sourceMessageTraceEventId: request.eventId,
    });
    expect(preview).toMatchObject({
      status: "pending_confirmation", affectedTaskNodeIds: expect.arrayContaining([providerNodeId, "consumer"]),
      contractDiff: { compatibility: "compatible" },
    });
    const replacementAnswer = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "replacement-answer", cwd: projectDir,
      prompt: "yes", timestamp: "2030-01-01T00:00:03.000Z",
    }));
    if (!replacementAnswer.recorded) throw new Error("replacement confirmation Trace was not recorded");
    expect(first.replacements.confirmTaskNodeReplacement({
      projectId: project.projectId, replacementId: preview.replacementId,
      answer: "yes", answerTraceEventId: replacementAnswer.eventId,
    })).toMatchObject({ status: "suspending" });

    const disposalEvidence = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "dispose", cwd: projectDir,
      tool_name: "Edit", tool_use_id: "inverse", tool_input: { operation: "restore recorded API patch" },
      tool_response: { ok: true }, timestamp: "2030-01-01T00:00:04.000Z",
    }));
    const activationEvidence = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "activate", cwd: projectDir,
      tool_name: "Bash", tool_use_id: "validate", tool_input: { command: "npm test" },
      tool_response: { exitCode: 0 }, timestamp: "2030-01-01T00:00:05.000Z",
    }));
    if (!disposalEvidence.recorded || !activationEvidence.recorded) throw new Error("replacement execution Trace was not recorded");
    const executed = first.replacements.executeTaskNodeReplacement({
      projectId: project.projectId, replacementId: preview.replacementId,
      dispositions: [{
        effectId: effect.effectId, action: "inverse_applied", observedBaselineRef: "hash:v1",
        evidenceRefs: [disposalEvidence.eventId], residualImpact: "",
      }],
      activationVerdict: "succeeded", activationEvidenceRefs: [activationEvidence.eventId],
    });
    expect(executed).toMatchObject({ status: "completed", activationVerdict: "succeeded", blockedEffectIds: [] });

    const failedRequest = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "failed-replacement-request", cwd: projectDir,
      prompt: "Try another provider implementation", timestamp: "2030-01-01T00:00:06.000Z",
    }));
    if (!failedRequest.recorded) throw new Error("failed replacement request Trace was not recorded");
    const failedPreview = first.replacements.previewTaskNodeReplacement({
      projectId: project.projectId, treeId: root.treeId, nodeId: providerNodeId,
      expectedTreeRevisionId: executed.activatedTreeRevisionId!,
      candidateBody: { id: providerNodeId, parentId: null, title: "Broken API candidate", children: ["consumer"] },
      providesContractIds: ["api-contract"], requiresContractIds: [], reason: "Exercise failed activation recovery",
      sourceMessageTraceEventId: failedRequest.eventId,
    });
    const failedAnswer = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "failed-replacement-answer", cwd: projectDir,
      prompt: "yes", timestamp: "2030-01-01T00:00:07.000Z",
    }));
    if (!failedAnswer.recorded) throw new Error("failed replacement confirmation Trace was not recorded");
    first.replacements.confirmTaskNodeReplacement({
      projectId: project.projectId, replacementId: failedPreview.replacementId,
      answer: "yes", answerTraceEventId: failedAnswer.eventId,
    });
    const failedActivationEvidence = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUseFailure", session_id: "failed-activate", cwd: projectDir,
      tool_name: "Bash", tool_use_id: "failed-validate", tool_input: { command: "npm test" },
      tool_response: { exitCode: 1 }, timestamp: "2030-01-01T00:00:08.000Z",
    }));
    if (!failedActivationEvidence.recorded) throw new Error("failed activation Trace was not recorded");
    expect(first.replacements.executeTaskNodeReplacement({
      projectId: project.projectId, replacementId: failedPreview.replacementId, dispositions: [],
      activationVerdict: "failed", activationEvidenceRefs: [failedActivationEvidence.eventId],
    })).toMatchObject({ status: "replacement_failed", activatedTreeRevisionId: null });
    const recoveryEvidence = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "recover", cwd: projectDir,
      tool_name: "Bash", tool_use_id: "restore-validation", tool_input: { command: "npm test" },
      tool_response: { exitCode: 0 }, timestamp: "2030-01-01T00:00:09.000Z",
    }));
    if (!recoveryEvidence.recorded) throw new Error("recovery Trace was not recorded");
    expect(first.replacements.recoverTaskNodeReplacement({
      projectId: project.projectId, replacementId: failedPreview.replacementId,
      recoveryVerdict: "restored", evidenceRefs: [recoveryEvidence.eventId],
    })).toMatchObject({ status: "rolled_back", restored: true });
    first.close();

    const reopened = openRuntime(environment);
    try {
      const detail = reopened.queries.getTaskNodeReplacementDetail(project.projectId, preview.replacementId);
      expect(detail).toMatchObject({
        replacement: {
          replacementId: preview.replacementId, status: "completed",
          affectedTaskNodeIds: expect.arrayContaining([providerNodeId, "consumer"]),
          activatedTreeRevisionId: executed.activatedTreeRevisionId,
        },
        candidate: { body: expect.objectContaining({ id: providerNodeId, title: "Provide API v2" }) },
        confirmation: { status: "accepted", answer: "yes" },
        effects: [expect.objectContaining({ effectId: effect.effectId, disposalStatus: "disposed" })],
        disposalResults: [expect.objectContaining({ effectId: effect.effectId, status: "disposed" })],
      });
      expect(detail.compositionTransitions.some((transition) => transition.toState === "suspending")).toBe(true);
      expect(detail.compositionTransitions.some((transition) => transition.toState === "active")).toBe(true);
      expect(reopened.queries.getTaskNodeEffects(project.projectId, {
        treeId: root.treeId, nodeId: providerNodeId, disposalStatus: "disposed",
      }).items).toHaveLength(1);
      expect(reopened.queries.getTaskNodeReplacements(project.projectId, {
        treeId: root.treeId, status: "completed",
      }).items).toEqual([expect.objectContaining({ replacementId: preview.replacementId })]);
      expect(reopened.queries.getTaskNodeReplacementDetail(project.projectId, failedPreview.replacementId)).toMatchObject({
        replacement: {
          replacementId: failedPreview.replacementId, status: "rolled_back",
          activatedTreeRevisionId: null, recoveryResult: { recoveryVerdict: "restored" },
        },
      });
      const current = reopened.taskTrees.getRevision(project.projectId, root.treeId);
      expect(current.revisionId).toBe(executed.activatedTreeRevisionId);
      expect(current.document.nodes.find((node) => node.id === providerNodeId)?.title).toBe("Provide API v2");
    } finally {
      reopened.close();
    }
  });
});
