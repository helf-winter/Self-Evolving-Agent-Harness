import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Task Tree refinement vertical slice", () => {
  it("preserves a previewed cross-branch decision, planning Trace, and readiness result across restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-refinement-e2e-"));
    dirs.push(directory);
    const projectDirectory = path.join(directory, "project");
    await mkdir(projectDirectory);
    const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") };

    const first = openRuntime(environment);
    const project = await first.projects.resolve(projectDirectory, "persist");
    const root = await first.taskTrees.createTaskRoot({ projectId: project.projectId, title: "Runtime" });
    const document: TaskTreeDocument = {
      planningVersion: 1,
      planningContext: {
        goal: "Build the runtime", scopeBoundaries: ["Planning"], exclusions: ["No UI"],
        unresolvedQuestions: [], unresolvedDecisions: [], plannedEffects: [],
      },
      nodes: [
        { id: "root", parentId: null, title: "Runtime", children: ["branch-a", "branch-b"] },
        {
          id: "branch-a", parentId: "root", title: "Branch A", children: [], objectives: ["Implement A"],
          expectedOutputs: ["a.ts"], acceptanceCriteria: ["A passes"], unresolvedQuestions: [], unresolvedDecisions: [],
          dependencies: [], requiredEvidence: [{ key: "a-test", description: "A test" }],
          executionPhase: "implementation", stopDecompositionReason: "one verifiable result",
        },
        {
          id: "branch-b", parentId: "root", title: "Branch B", children: [], objectives: ["Implement B"],
          expectedOutputs: ["b.ts"], acceptanceCriteria: ["B passes"], unresolvedQuestions: [], unresolvedDecisions: [],
          dependencies: [], requiredEvidence: [{ key: "b-test", description: "B test" }],
          executionPhase: "implementation", stopDecompositionReason: "one verifiable result",
        },
      ],
      relations: [], artifacts: [],
      skeletonCriteria: [
        { id: "s-a", branchNodeId: "branch-a", expectedArtifacts: ["a.ts"], requiredContracts: ["a"], verificationCommands: ["npm test -- a"], readinessConditions: ["A compiles"] },
        { id: "s-b", branchNodeId: "branch-b", expectedArtifacts: ["b.ts"], requiredContracts: ["b"], verificationCommands: ["npm test -- b"], readinessConditions: ["B compiles"] },
      ],
    };
    const draft = first.taskTrees.saveDraftRevision({
      projectId: project.projectId, treeId: root.treeId, baseRevisionId: root.revisionId, document,
    });
    const prompt = await first.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "planning-session", cwd: projectDirectory,
      prompt: "Include publishing in the root plan", timestamp: "2030-01-01T00:00:00.000Z",
    }));
    expect(prompt.recorded).toBe(true);
    if (!prompt.recorded) throw new Error("expected the planning prompt to be recorded");
    const proposed: TaskTreeDocument = {
      ...document,
      planningContext: { ...document.planningContext!, goal: "Build and publish the runtime" },
    };
    const preview = first.taskTrees.previewDraftChangeSet({
      projectId: project.projectId, treeId: root.treeId, baseRevisionId: draft.revisionId, proposedDocument: proposed,
    });
    const applied = first.taskTrees.applyRefinementChangeSet({
      projectId: project.projectId, treeId: root.treeId, baseRevisionId: draft.revisionId,
      operations: [{ op: "replace_document", document: proposed }], previewId: preview.previewId,
      sourceUserMessageTraceEventId: prompt.eventId,
      decision: {
        discussionTopic: "Root delivery scope", currentUnderstanding: "Publishing affects both branches",
        consideredOptions: ["Build only", "Build and publish"], agentRecommendation: "Build and publish",
        userDecision: "Build and publish",
      },
    });
    const readiness = first.taskTrees.scanPlanReadiness({ projectId: project.projectId, treeId: root.treeId });
    expect(readiness).toMatchObject({ ready: true, revisionId: applied.revisionId });
    const decisionId = first.queries.getTaskRefinementHistory(project.projectId, root.treeId, {}).items[0]!.decisionId;
    first.close();

    const reopened = openRuntime(environment);
    try {
      expect(reopened.taskTrees.getRevision(project.projectId, root.treeId)).toMatchObject({
        revisionId: applied.revisionId,
        document: { planningContext: { goal: "Build and publish the runtime" } },
      });
      expect(reopened.queries.getTaskRefinementHistory(project.projectId, root.treeId, {}).items).toEqual([
        expect.objectContaining({ decisionId, applyMode: "preview_required", previewId: preview.previewId }),
      ]);
      expect(reopened.queries.getPlanningDecisionDetail(project.projectId, decisionId)).toMatchObject({
        decision: { sourceUserMessageTraceEventId: prompt.eventId, userDecision: "Build and publish" },
        changeSet: { resultRevisionId: applied.revisionId, affectedBranchIds: ["branch-a", "branch-b"] },
        preview: { status: "applied" },
      });
      expect(reopened.queries.getTraceEvents(project.projectId, { treeId: root.treeId }).items)
        .toEqual(expect.arrayContaining([expect.objectContaining({ eventName: "PlanningDecisionApplied" })]));
    } finally {
      reopened.close();
    }
  });
});
