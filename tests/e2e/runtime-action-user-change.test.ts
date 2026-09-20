import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Runtime Action and User Change vertical slice", () => {
  it("persists confirmed Drift resolution and all User Change kinds across restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-runtime-action-e2e-"));
    dirs.push(directory);
    const projectDir = path.join(directory, "project");
    await mkdir(projectDir);
    const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") };

    const first = openRuntime(environment);
    const project = await first.projects.resolve(projectDir, "persist");
    const root = await first.taskTrees.createTaskRoot({ projectId: project.projectId, title: "Build endpoint" });
    const rootNodeId = root.document.nodes[0]!.id;
    const document: TaskTreeDocument = {
      nodes: [
        { id: rootNodeId, parentId: null, title: "Build endpoint", children: ["endpoint"] },
        {
          id: "endpoint", parentId: rootNodeId, title: "Implement endpoint", children: [],
          objectives: ["Implement endpoint"], expectedOutputs: ["src/endpoint.ts"],
          acceptanceCriteria: ["endpoint test passes"], unresolvedQuestions: [], unresolvedDecisions: [],
          dependencies: [], requiredEvidence: [{ key: "test", description: "endpoint test passes" }],
          executionPhase: "implementation", stopDecompositionReason: "one independently testable endpoint",
        },
      ],
      relations: [],
      artifacts: [{ id: "endpoint-file", kind: "file", locator: "src/endpoint.ts", status: "draft" }],
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
      hook_event_name: "UserPromptSubmit", session_id: "tree-confirmation", cwd: projectDir, prompt: "yes",
    }));
    if (!treeAnswer.recorded) throw new Error("tree confirmation Trace was not recorded");
    first.workflows.confirmScope({
      projectId: project.projectId, confirmationId: treePrompt.confirmationId, answer: "yes",
      answerTraceEventId: treeAnswer.eventId, workflowRevision,
    });

    const drift = first.drifts.recordDrift({
      projectId: project.projectId, treeId: root.treeId, nodeId: "endpoint",
      actualArtifactId: "endpoint-file", driftType: "responsibility_changed", severity: "blocking",
      description: "Endpoint now owns response normalization",
      explanation: "Observed implementation responsibility exceeds the confirmed plan",
      recommendation: "Accept the responsibility and revalidate the branch",
    });
    const driftSource = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "drift-source", cwd: projectDir,
      prompt: "接受该职责变化，但需要重新验证",
    }));
    if (!driftSource.recorded) throw new Error("drift source Trace was not recorded");
    const driftAction = first.actions.proposePlanDriftResolution({
      projectId: project.projectId, driftId: drift.driftId, expectedTreeRevisionId: revision.revisionId,
      decision: "accepted", reason: "The responsibility belongs in this branch", sourceMessageTraceEventId: driftSource.eventId,
    });
    const driftAnswer = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "drift-answer", cwd: projectDir, prompt: "yes",
    }));
    if (!driftAnswer.recorded) throw new Error("drift answer Trace was not recorded");
    first.actions.resolveConfirmation({
      projectId: project.projectId, confirmationId: driftAction.confirmationId,
      answer: "yes", answerTraceEventId: driftAnswer.eventId,
    });

    const minorSource = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "minor-source", cwd: projectDir,
      prompt: "把返回文案微调一下，不改变范围",
    }));
    if (!minorSource.recorded) throw new Error("minor-change source Trace was not recorded");
    first.actions.proposeUserChange({
      projectId: project.projectId, treeId: root.treeId, nodeId: "endpoint",
      expectedTreeRevisionId: revision.revisionId, changeType: "minor_change",
      summary: "Adjust response copy", changeImpact: { scopeChanged: false, artifacts: ["src/endpoint.ts"] },
      sourceMessageTraceEventId: minorSource.eventId,
    });

    const prioritySource = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "priority-source", cwd: projectDir,
      prompt: "接下来优先回到根任务检查整体集成",
    }));
    if (!prioritySource.recorded) throw new Error("priority-change source Trace was not recorded");
    first.actions.proposeUserChange({
      projectId: project.projectId, treeId: root.treeId, nodeId: "endpoint",
      expectedTreeRevisionId: revision.revisionId, changeType: "priority_change",
      summary: "Prioritize integration review", changeImpact: { executionOrderChanged: true },
      priorityTargetNodeId: rootNodeId, sourceMessageTraceEventId: prioritySource.eventId,
    });

    const changedDocument: TaskTreeDocument = {
      ...document,
      nodes: document.nodes.map((node) => node.id === "endpoint"
        ? { ...node, title: "Implement normalized endpoint", acceptanceCriteria: ["normalized endpoint test passes"] }
        : node),
    };
    const scopeSource = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "scope-source", cwd: projectDir,
      prompt: "把响应归一化正式纳入这个节点的范围",
    }));
    if (!scopeSource.recorded) throw new Error("scope-change source Trace was not recorded");
    const scopeAction = first.actions.proposeUserChange({
      projectId: project.projectId, treeId: root.treeId, nodeId: "endpoint",
      expectedTreeRevisionId: revision.revisionId, changeType: "scope_change",
      summary: "Add response normalization to confirmed scope",
      changeImpact: { scopeChanged: true, changedNodes: ["endpoint"] },
      proposedDocument: changedDocument, sourceMessageTraceEventId: scopeSource.eventId,
    });
    if (!scopeAction.confirmationId) throw new Error("scope-change confirmation was not created");
    const scopeAnswer = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "scope-answer", cwd: projectDir, prompt: "yes",
    }));
    if (!scopeAnswer.recorded) throw new Error("scope-change answer Trace was not recorded");
    first.actions.resolveConfirmation({
      projectId: project.projectId, confirmationId: scopeAction.confirmationId,
      answer: "yes", answerTraceEventId: scopeAnswer.eventId,
    });
    first.close();

    const reopened = openRuntime(environment);
    try {
      const snapshot = reopened.queries.getRuntimeSnapshot(project.projectId);
      const changes = reopened.queries.getUserChangeRequests(project.projectId, { treeId: root.treeId, limit: 10 });
      const currentRevision = reopened.database.get<{ current_revision_id: string }>(
        "SELECT current_revision_id FROM task_trees WHERE id = ? AND project_id = ?", root.treeId, project.projectId,
      )!.current_revision_id;
      expect(snapshot).toMatchObject({
        selectedTreeId: root.treeId, selectedNodeId: rootNodeId,
        workflow: { stage: "task_tree_refinement" }, pendingConfirmation: null, pendingConfirmationCount: 0,
      });
      expect(currentRevision).not.toBe(revision.revisionId);
      expect(reopened.queries.getWaitingItems(project.projectId, {})).toEqual({ items: [], nextCursor: null });
      expect(changes.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ changeType: "minor_change", status: "applied" }),
        expect.objectContaining({ changeType: "priority_change", status: "applied", priorityTargetNodeId: rootNodeId }),
        expect.objectContaining({ changeType: "scope_change", status: "applied" }),
      ]));
      expect(changes.items).toHaveLength(3);
      expect(reopened.queries.getRuntimeActionDetail(project.projectId, driftAction.actionId)).toMatchObject({
        action: { status: "committed" },
        confirmation: { status: "confirmed", answer: "yes" },
        planDrift: { resolutionStatus: "accepted", userDecision: "accepted" },
      });
      expect(reopened.queries.getRuntimeActionDetail(project.projectId, scopeAction.actionId)).toMatchObject({
        action: { status: "committed" },
        confirmation: { status: "confirmed", answer: "yes" },
        userChange: { changeType: "scope_change", status: "applied" },
      });
      expect(reopened.database.get<{ count: number }>(
        "SELECT count(*) AS count FROM runtime_actions WHERE project_id = ? AND status = 'committed'", project.projectId,
      )?.count).toBe(4);
    } finally {
      reopened.close();
    }
  });
});
