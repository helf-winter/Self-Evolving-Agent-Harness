import { HarnessError } from "../domain/errors.js";
import { deriveConfirmationStates, resolveConfirmationScope, type ConfirmationState } from "../domain/confirmation.js";
import { normalizeArtifactInput } from "../domain/artifact-graph.js";
import { newId, nowIso } from "../domain/ids.js";
import { canonicalJson } from "../domain/trace.js";
import { normalizeTaskTreeDocument, validateTaskTree, type TaskTreeDocument } from "../domain/task-tree.js";
import { analyzeDraftImpact, analyzePlanReadiness, validateDraftStructure } from "../domain/task-refinement.js";
import { restoredTaskTreeStatus, type TaskTreeCollectionAction } from "../domain/task-collection.js";
import type { RuntimeDatabase } from "../storage/database.js";

interface TreeRow {
  id: string;
  title: string;
  status: string;
  current_revision_id: string;
  updated_at: string;
  archived_at: string | null;
  archived_from_status: string | null;
}

interface RevisionRow {
  id: string;
  revision: number;
  document_json: string;
  created_at: string;
}

export interface RefinementDecisionInput {
  discussionTopic: string;
  currentUnderstanding: string;
  consideredOptions: string[];
  agentRecommendation: string;
  userDecision: string;
}

interface RefinementChangeSetInput {
  projectId: string;
  treeId: string;
  baseRevisionId: string;
  operations: Array<{ op: "replace_document"; document: TaskTreeDocument }>;
  sourceUserMessageTraceEventId: string;
  previewId?: string;
  decision: RefinementDecisionInput;
}

export interface TaskTreeRevisionView {
  treeId: string;
  revisionId: string;
  revision: number;
  title: string;
  status: string;
  document: TaskTreeDocument;
}

export class TaskTreeService {
  constructor(private readonly database: RuntimeDatabase) {}

  listTaskTreeCandidates(input: { projectId: string; query?: string; includeArchived?: boolean }) {
    const trees = this.database.all<TreeRow>(
      `SELECT id, title, status, current_revision_id, updated_at, archived_at, archived_from_status
       FROM task_trees
       WHERE project_id = ? AND (? = 1 OR status <> 'archived')
       ORDER BY updated_at DESC, id DESC`,
      input.projectId, input.includeArchived ? 1 : 0,
    );
    const selectedTreeId = this.selectedTreeId(input.projectId);
    const query = input.query?.trim().toLowerCase();
    const candidates = trees.flatMap((tree) => {
      const matchedBy: string[] = [];
      if (!query) matchedBy.push("recent");
      if (query && tree.id.toLowerCase() === query) matchedBy.push("tree_id");
      if (query && tree.title.toLowerCase().includes(query)) matchedBy.push("title");
      const artifactMatch = query
        ? this.database.get("SELECT id FROM artifacts WHERE tree_id = ? AND lower(locator) LIKE ? LIMIT 1", tree.id, `%${query}%`)
        : undefined;
      if (artifactMatch) matchedBy.push("artifact");
      return matchedBy.length ? [{
        treeId: tree.id, title: tree.title, status: tree.status, matchedBy, updatedAt: tree.updated_at,
        archivedAt: tree.archived_at, selected: selectedTreeId === tree.id,
      }] : [];
    });
    return candidates.slice(0, query || candidates.length > 5 ? 3 : candidates.length);
  }

  async createTaskRoot(input: { projectId: string; title: string }): Promise<TaskTreeRevisionView> {
    if (!input.title.trim()) throw new HarnessError("invalid_input", "task root title is required");
    this.requireProject(input.projectId);
    const treeId = newId();
    const revisionId = newId();
    const nodeId = newId();
    const timestamp = nowIso();
    const document: TaskTreeDocument = {
      nodes: [{ id: nodeId, parentId: null, title: input.title.trim(), children: [] }],
      relations: [], artifacts: [],
    };
    this.database.transaction(() => {
      const previousSelectedTreeId = this.selectedTreeId(input.projectId);
      if (previousSelectedTreeId) this.assertNoActiveAttempt(input.projectId, previousSelectedTreeId);
      this.database.run(
        "UPDATE workflow_states SET active = 0, updated_at = ? WHERE project_id = ? AND active = 1",
        timestamp, input.projectId,
      );
      this.database.run(
        "INSERT INTO task_trees (id, project_id, title, status, current_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        treeId, input.projectId, input.title.trim(), "draft", revisionId, timestamp, timestamp,
      );
      this.database.run(
        "INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES (?, ?, ?, ?, ?)",
        revisionId, treeId, 1, canonicalJson(document), timestamp,
      );
      this.database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES (?, ?, NULL, ?, ?)", nodeId, treeId, input.title.trim(), "draft");
      this.database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES (?, ?, ?, ?, ?)", newId(), nodeId, revisionId, canonicalJson(document.nodes[0]), timestamp);
      this.database.run(
        "INSERT INTO task_node_confirmation_states (project_id, tree_id, tree_revision_id, task_node_id, state, updated_at) VALUES (?, ?, ?, ?, 'draft', ?)",
        input.projectId, treeId, revisionId, nodeId, timestamp,
      );
      this.database.run("INSERT INTO workflow_states (id, project_id, tree_id, stage, revision, active, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)", newId(), input.projectId, treeId, "draft_task_tree", 1, timestamp);
      this.upsertRuntimeSelection(input.projectId, treeId, nodeId, timestamp);
      this.appendCollectionTransition({
        projectId: input.projectId, treeId, action: "selected", fromStatus: "draft", toStatus: "draft",
        previousSelectedTreeId, selectedTreeId: treeId, timestamp,
      });
    });
    return { treeId, revisionId, revision: 1, title: input.title.trim(), status: "draft", document };
  }

  saveDraftRevision(input: { projectId: string; treeId: string; baseRevisionId: string; document: TaskTreeDocument }): TaskTreeRevisionView {
    const tree = this.requireTree(input.projectId, input.treeId);
    this.assertTreeMutable(tree);
    if (tree.current_revision_id !== input.baseRevisionId) throw new HarnessError("revision_conflict", "the Task Tree changed after this draft was based on it");
    this.assertValidDocument(input.document);
    return this.persistRevision(tree, input.projectId, input.document);
  }

  applyDraftChangeSet(input: {
    projectId: string;
    treeId: string;
    baseRevisionId: string;
    operations: Array<{ op: "replace_document"; document: TaskTreeDocument }>;
    affectedReferences: string[];
    decisionSummary: string;
  }): TaskTreeRevisionView {
    return this.database.transaction(() => this.applyDraftChangeSetWithinTransaction(input));
  }

  applyDraftChangeSetWithinTransaction(input: {
    projectId: string;
    treeId: string;
    baseRevisionId: string;
    operations: Array<{ op: "replace_document"; document: TaskTreeDocument }>;
    affectedReferences: string[];
    decisionSummary: string;
  }): TaskTreeRevisionView {
    const tree = this.requireTree(input.projectId, input.treeId);
    this.assertTreeMutable(tree);
    if (tree.current_revision_id !== input.baseRevisionId) throw new HarnessError("revision_conflict", "the Draft Change Set has a stale base revision");
    if (input.operations.length !== 1 || input.operations[0]?.op !== "replace_document" || !input.decisionSummary.trim()) {
      throw new HarnessError("invalid_input", "a documented replace_document operation is required");
    }
    const document = input.operations[0].document;
    this.assertValidDocument(document);
    const changeSetId = newId();
    this.database.run(
      "INSERT INTO draft_change_sets (id, tree_id, base_revision_id, operations_json, affected_references_json, decision_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      changeSetId, input.treeId, input.baseRevisionId, canonicalJson(input.operations), canonicalJson(input.affectedReferences), input.decisionSummary, nowIso(),
    );
    return this.persistRevision(tree, input.projectId, document, false);
  }

  previewDraftChangeSet(input: {
    projectId: string;
    treeId: string;
    baseRevisionId: string;
    proposedDocument: TaskTreeDocument;
  }) {
    const tree = this.requireTree(input.projectId, input.treeId);
    this.assertTreeMutable(tree);
    if (tree.current_revision_id !== input.baseRevisionId) {
      throw new HarnessError("revision_conflict", "the refinement preview has a stale base revision");
    }
    this.assertValidDocument(input.proposedDocument);
    const base = this.requireRevision(input.baseRevisionId);
    const impact = analyzeDraftImpact(JSON.parse(base.document_json) as TaskTreeDocument, input.proposedDocument);
    if (!impact.hasStructuralChange) {
      throw new HarnessError("invalid_input", "the proposed Task Tree does not contain a structural change");
    }
    const previewId = newId();
    const timestamp = nowIso();
    this.database.transaction(() => {
      this.database.run(
        "UPDATE draft_change_set_previews SET status = 'stale' WHERE project_id = ? AND tree_id = ? AND base_revision_id = ? AND status = 'active'",
        input.projectId, input.treeId, input.baseRevisionId,
      );
      this.database.run(`
        INSERT INTO draft_change_set_previews (
          id, project_id, tree_id, base_revision_id, proposed_document_hash, proposed_document_json,
          impact_json, apply_mode, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
      `, previewId, input.projectId, input.treeId, input.baseRevisionId, impact.proposedDocumentHash,
      canonicalJson(input.proposedDocument), canonicalJson(impact),
      impact.applyMode === "preview_required" ? "preview_required" : "direct", timestamp);
    });
    return { previewId, baseRevisionId: input.baseRevisionId, ...impact };
  }

  applyRefinementChangeSet(input: RefinementChangeSetInput): TaskTreeRevisionView {
    return this.database.transaction(() => {
      const tree = this.requireTree(input.projectId, input.treeId);
      this.assertTreeMutable(tree);
      if (tree.current_revision_id !== input.baseRevisionId) {
        throw new HarnessError("revision_conflict", "the refinement Change Set has a stale base revision");
      }
      if (input.operations.length !== 1 || input.operations[0]?.op !== "replace_document") {
        throw new HarnessError("invalid_input", "one replace_document operation is required");
      }
      const decision = input.decision;
      if (!decision.discussionTopic.trim() || !decision.currentUnderstanding.trim()
        || !decision.consideredOptions.length || decision.consideredOptions.some((option) => !option.trim())
        || !decision.agentRecommendation.trim() || !decision.userDecision.trim()) {
        throw new HarnessError("invalid_input", "a complete refinement Decision Record is required");
      }
      const document = input.operations[0].document;
      this.assertValidDocument(document);
      const base = this.requireRevision(input.baseRevisionId);
      const impact = analyzeDraftImpact(JSON.parse(base.document_json) as TaskTreeDocument, document);
      if (!impact.hasStructuralChange) {
        throw new HarnessError("invalid_input", "the refinement Change Set does not contain a structural change");
      }
      const sourceTrace = this.database.get<{ id: string; occurred_at: string }>(`
        SELECT id, occurred_at FROM trace_events
        WHERE id = ? AND project_id = ? AND tree_id = ? AND event_name = 'UserPromptSubmit'
      `, input.sourceUserMessageTraceEventId, input.projectId, input.treeId);
      if (!sourceTrace || sourceTrace.occurred_at < base.created_at) {
        throw new HarnessError("evidence_scope_mismatch", "the source user message must belong to this tree and follow the base revision");
      }

      let previewId: string | null = null;
      if (impact.applyMode === "preview_required" || input.previewId) {
        const preview = input.previewId ? this.database.get<{
          id: string; proposed_document_hash: string; status: string; apply_mode: string;
        }>(`
          SELECT id, proposed_document_hash, status, apply_mode FROM draft_change_set_previews
          WHERE id = ? AND project_id = ? AND tree_id = ? AND base_revision_id = ?
        `, input.previewId, input.projectId, input.treeId, input.baseRevisionId) : undefined;
        if (!preview || preview.status !== "active" || preview.proposed_document_hash !== impact.proposedDocumentHash
          || (impact.applyMode === "preview_required" && preview.apply_mode !== "preview_required")) {
          throw new HarnessError("confirmation_required", "a current matching impact preview is required before this cross-branch refinement can be applied", impact);
        }
        previewId = preview.id;
      }

      const timestamp = nowIso();
      const changeSetId = newId();
      const decisionId = newId();
      const planningTraceId = newId();
      const affectedRefs = {
        nodeIds: impact.affectedNodeIds,
        branchIds: impact.affectedBranchIds,
        artifactIds: impact.affectedArtifactIds,
        relationRefs: impact.affectedRelationRefs,
        contractIds: impact.affectedContractIds,
      };
      this.database.run(`
        INSERT INTO trace_events (
          id, project_id, tree_id, session_id, event_name, payload_json, occurred_at, idempotency_key
        ) VALUES (?, ?, ?, 'runtime:planning', 'PlanningDecisionApplied', ?, ?, ?)
      `, planningTraceId, input.projectId, input.treeId, canonicalJson({
        changeSetId, baseRevisionId: input.baseRevisionId, sourceUserMessageTraceEventId: input.sourceUserMessageTraceEventId,
        discussionTopic: decision.discussionTopic, userDecision: decision.userDecision, impact: affectedRefs,
      }), timestamp, `planning-change-set:${changeSetId}`);
      this.database.run(`
        INSERT INTO draft_change_sets (
          id, tree_id, base_revision_id, operations_json, affected_references_json, decision_summary, created_at,
          project_id, source_message_trace_event_id, affected_node_ids_json, affected_branch_ids_json,
          affected_artifact_ids_json, affected_relation_refs_json, affected_contract_ids_json,
          apply_mode, preview_id, planning_trace_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, changeSetId, input.treeId, input.baseRevisionId, canonicalJson(input.operations), canonicalJson(affectedRefs),
      decision.userDecision, timestamp, input.projectId, input.sourceUserMessageTraceEventId,
      canonicalJson(impact.affectedNodeIds), canonicalJson(impact.affectedBranchIds), canonicalJson(impact.affectedArtifactIds),
      canonicalJson(impact.affectedRelationRefs), canonicalJson(impact.affectedContractIds),
      impact.applyMode === "preview_required" ? "preview_required" : "direct", previewId, planningTraceId);

      const result = this.persistRevision(tree, input.projectId, document, false);
      this.database.run(`
        INSERT INTO planning_decisions (
          id, tree_id, kind, decision_json, trace_event_id, created_at, base_revision_id, result_revision_id,
          change_set_id, discussion_topic, current_understanding, considered_options_json,
          agent_recommendation, user_decision, affected_refs_json, source_message_trace_event_id
        ) VALUES (?, ?, 'task_tree_refinement', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, decisionId, input.treeId, canonicalJson(decision), planningTraceId, timestamp,
      input.baseRevisionId, result.revisionId, changeSetId, decision.discussionTopic, decision.currentUnderstanding,
      canonicalJson(decision.consideredOptions), decision.agentRecommendation, decision.userDecision,
      canonicalJson(affectedRefs), input.sourceUserMessageTraceEventId);
      this.database.run(
        "UPDATE draft_change_sets SET result_revision_id = ?, planning_decision_id = ? WHERE id = ?",
        result.revisionId, decisionId, changeSetId,
      );
      if (previewId) this.database.run(
        "UPDATE draft_change_set_previews SET status = 'applied', applied_at = ? WHERE id = ?",
        timestamp, previewId,
      );
      return result;
    });
  }

  scanPlanReadiness(input: { projectId: string; treeId: string; scopeRootNodeId?: string }) {
    const tree = this.requireTree(input.projectId, input.treeId);
    this.assertTreeMutable(tree);
    const revision = this.requireRevision(tree.current_revision_id);
    const document = JSON.parse(revision.document_json) as TaskTreeDocument;
    const coveredNodeIds = resolveConfirmationScope(document, input.scopeRootNodeId);
    if (!coveredNodeIds) throw new HarnessError("not_found", "confirmation scope root was not found in the current Task Tree revision");
    const readiness = analyzePlanReadiness(document, input.scopeRootNodeId);
    const scopeKind = input.scopeRootNodeId ? "branch" as const : "tree" as const;
    const result = {
      resultId: newId(), treeId: tree.id, revisionId: revision.id, ready: readiness.ready,
      blockers: readiness.blockingIssues, blockingIssues: readiness.blockingIssues,
      warnings: readiness.warnings, recommendedNextIssue: readiness.recommendedNextIssue,
      scopeKind, scopeRootNodeId: input.scopeRootNodeId ?? null, coveredNodeIds,
    };
    this.database.transaction(() => {
      const timestamp = nowIso();
      this.database.run(
        `INSERT INTO plan_readiness_results (
          id, tree_id, revision_id, ready, blockers_json, created_at, scope_kind, scope_root_node_id,
          issues_json, warnings_json, recommended_issue_json, priority_policy_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'refinement-priority-v1')`,
        result.resultId, tree.id, revision.id, result.ready ? 1 : 0, canonicalJson(result.blockers), timestamp,
        scopeKind, input.scopeRootNodeId ?? null, canonicalJson(result.blockingIssues), canonicalJson(result.warnings),
        result.recommendedNextIssue ? canonicalJson(result.recommendedNextIssue) : null,
      );
      if (result.ready) {
        this.database.run(
          "UPDATE workflow_states SET stage = 'branch_confirmation', revision = revision + 1, updated_at = ? WHERE project_id = ? AND tree_id = ? AND active = 1 AND stage = 'task_tree_refinement'",
          timestamp, input.projectId, input.treeId,
        );
      }
    });
    return result;
  }

  getRevision(projectId: string, treeId: string): TaskTreeRevisionView {
    const tree = this.requireTree(projectId, treeId);
    const revision = this.requireRevision(tree.current_revision_id);
    return { treeId, revisionId: revision.id, revision: revision.revision, title: tree.title, status: tree.status, document: JSON.parse(revision.document_json) as TaskTreeDocument };
  }

  selectTaskTree(input: { projectId: string; treeId: string }) {
    return this.database.transaction(() => {
      const tree = this.requireTree(input.projectId, input.treeId);
      if (tree.status === "archived") {
        throw new HarnessError("task_tree_transition_rejected", "an archived Task Tree must be restored before it can be selected");
      }
      const previousSelectedTreeId = this.selectedTreeId(input.projectId);
      if (previousSelectedTreeId === tree.id) {
        return {
          treeId: tree.id, title: tree.title, status: tree.status, selected: true,
          previousSelectedTreeId, selectedTreeId: tree.id, transitionId: null,
        };
      }
      if (previousSelectedTreeId) this.assertNoActiveAttempt(input.projectId, previousSelectedTreeId);
      const timestamp = nowIso();
      const rootNodeId = this.database.get<{ id: string }>(
        "SELECT id FROM task_nodes WHERE tree_id = ? AND parent_id IS NULL ORDER BY id LIMIT 1", tree.id,
      )?.id ?? null;
      this.database.run(
        "UPDATE workflow_states SET active = 0, updated_at = ? WHERE project_id = ? AND active = 1",
        timestamp, input.projectId,
      );
      const workflow = this.database.get<{ id: string }>(
        "SELECT id FROM workflow_states WHERE project_id = ? AND tree_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1",
        input.projectId, tree.id,
      );
      if (!workflow) throw new HarnessError("task_tree_transition_rejected", "Task Tree has no resumable workflow state");
      this.database.run("UPDATE workflow_states SET active = 1, updated_at = ? WHERE id = ?", timestamp, workflow.id);
      this.upsertRuntimeSelection(input.projectId, tree.id, rootNodeId, timestamp);
      this.database.run("UPDATE task_trees SET updated_at = ? WHERE id = ?", timestamp, tree.id);
      const transitionId = this.appendCollectionTransition({
        projectId: input.projectId, treeId: tree.id, action: "selected", fromStatus: tree.status,
        toStatus: tree.status, previousSelectedTreeId, selectedTreeId: tree.id, timestamp,
      });
      return {
        treeId: tree.id, title: tree.title, status: tree.status, selected: true,
        previousSelectedTreeId, selectedTreeId: tree.id, transitionId,
      };
    });
  }

  archiveTaskTree(input: { projectId: string; treeId: string }) {
    return this.database.transaction(() => {
      const tree = this.requireTree(input.projectId, input.treeId);
      if (tree.status === "archived") {
        throw new HarnessError("task_tree_transition_rejected", "Task Tree is already archived");
      }
      this.assertNoActiveAttempt(input.projectId, tree.id);
      const previousSelectedTreeId = this.selectedTreeId(input.projectId);
      const selectedTreeId = previousSelectedTreeId === tree.id ? null : previousSelectedTreeId;
      const timestamp = nowIso();
      this.database.run(
        "UPDATE task_trees SET status = 'archived', archived_at = ?, archived_from_status = ?, updated_at = ? WHERE id = ?",
        timestamp, tree.status, timestamp, tree.id,
      );
      this.database.run(
        "UPDATE workflow_states SET active = 0, updated_at = ? WHERE project_id = ? AND tree_id = ?",
        timestamp, input.projectId, tree.id,
      );
      if (previousSelectedTreeId === tree.id) this.upsertRuntimeSelection(input.projectId, null, null, timestamp);
      const transitionId = this.appendCollectionTransition({
        projectId: input.projectId, treeId: tree.id, action: "archived", fromStatus: tree.status,
        toStatus: "archived", previousSelectedTreeId, selectedTreeId, timestamp,
      });
      return {
        treeId: tree.id, title: tree.title, status: "archived", selected: false,
        previousSelectedTreeId, selectedTreeId, archivedAt: timestamp, transitionId,
      };
    });
  }

  restoreTaskTree(input: { projectId: string; treeId: string }) {
    return this.database.transaction(() => {
      const tree = this.requireTree(input.projectId, input.treeId);
      if (tree.status !== "archived") {
        throw new HarnessError("task_tree_transition_rejected", "only an archived Task Tree can be restored");
      }
      const restoredStatus = restoredTaskTreeStatus(tree.archived_from_status);
      const selectedTreeId = this.selectedTreeId(input.projectId);
      const timestamp = nowIso();
      this.database.run(
        "UPDATE task_trees SET status = ?, archived_at = NULL, archived_from_status = NULL, updated_at = ? WHERE id = ?",
        restoredStatus, timestamp, tree.id,
      );
      this.database.run(
        "UPDATE workflow_states SET active = 0, updated_at = ? WHERE project_id = ? AND tree_id = ?",
        timestamp, input.projectId, tree.id,
      );
      const transitionId = this.appendCollectionTransition({
        projectId: input.projectId, treeId: tree.id, action: "restored", fromStatus: "archived",
        toStatus: restoredStatus, previousSelectedTreeId: selectedTreeId, selectedTreeId, timestamp,
      });
      return {
        treeId: tree.id, title: tree.title, status: restoredStatus, selected: selectedTreeId === tree.id,
        previousSelectedTreeId: selectedTreeId, selectedTreeId, archivedAt: null, transitionId,
      };
    });
  }

  private persistRevision(tree: TreeRow, projectId: string, document: TaskTreeDocument, wrap = true): TaskTreeRevisionView {
    document = normalizeTaskTreeDocument(document);
    const current = this.requireRevision(tree.current_revision_id);
    const revisionId = newId();
    const revision = current.revision + 1;
    const timestamp = nowIso();
    const work = () => {
      const previousStates = new Map(this.database.all<{
        task_node_id: string; state: ConfirmationState; source_confirmation_id: string | null;
      }>(
        "SELECT task_node_id, state, source_confirmation_id FROM task_node_confirmation_states WHERE tree_revision_id = ?",
        current.id,
      ).map((row) => [row.task_node_id, row]));
      const previousBodies = new Map(this.database.all<{ node_id: string; body_json: string }>(
        "SELECT node_id, body_json FROM task_node_revisions WHERE tree_revision_id = ?",
        current.id,
      ).map((row) => [row.node_id, row.body_json]));
      const changedNodeIds = new Set(document.nodes.flatMap((node) =>
        previousBodies.get(node.id) !== canonicalJson(node) ? [node.id] : []));
      const byId = new Map(document.nodes.map((node) => [node.id, node]));
      const invalidatedConfirmedAncestors = new Set<string>();
      for (const changedNodeId of changedNodeIds) {
        let parentId = byId.get(changedNodeId)?.parentId ?? null;
        while (parentId) {
          if (previousStates.get(parentId)?.state === "confirmed") invalidatedConfirmedAncestors.add(parentId);
          parentId = byId.get(parentId)?.parentId ?? null;
        }
      }
      const confirmedNodeIds = new Set<string>();
      const pendingNodeIds = new Set<string>();
      for (const node of document.nodes) {
        const previousState = previousStates.get(node.id)?.state;
        const changed = changedNodeIds.has(node.id) || invalidatedConfirmedAncestors.has(node.id);
        if (changed && previousState && previousState !== "draft") pendingNodeIds.add(node.id);
        else if (previousState === "confirmed") confirmedNodeIds.add(node.id);
        else if (previousState === "pending_user_confirmation") pendingNodeIds.add(node.id);
      }
      const confirmationStates = deriveConfirmationStates(document, confirmedNodeIds, pendingNodeIds);
      const nodeRevisionIds = new Map<string, string>();
      this.database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES (?, ?, ?, ?, ?)", revisionId, tree.id, revision, canonicalJson(document), timestamp);
      for (const node of document.nodes) {
        const bodyJson = canonicalJson(node);
        const previous = this.database.get<{ status: string; body_json: string }>(`
          SELECT n.status, nr.body_json
          FROM task_nodes n
          JOIN task_node_revisions nr ON nr.node_id = n.id AND nr.tree_revision_id = ?
          WHERE n.id = ? AND n.tree_id = ?
        `, current.id, node.id, tree.id);
        const nextStatus = !previous || previous.status === "draft"
          ? "draft"
          : previous.body_json === bodyJson
            ? previous.status
            : previous.status === "succeeded" ? "needs_revalidation" : "pending_user_confirmation";
        this.database.run(
          "INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, title = excluded.title, status = excluded.status",
          node.id, tree.id, node.parentId, node.title, nextStatus,
        );
        const nodeRevisionId = newId();
        nodeRevisionIds.set(node.id, nodeRevisionId);
        this.database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES (?, ?, ?, ?, ?)", nodeRevisionId, node.id, revisionId, bodyJson, timestamp);
        if (node.children.length === 0) this.database.run("INSERT INTO leaf_task_contracts (node_revision_id, contract_json) VALUES (?, ?)", nodeRevisionId, bodyJson);
        this.database.run(
          "INSERT INTO task_node_confirmation_states (project_id, tree_id, tree_revision_id, task_node_id, state, source_confirmation_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          projectId, tree.id, revisionId, node.id, confirmationStates[node.id] ?? "draft",
          confirmedNodeIds.has(node.id) ? previousStates.get(node.id)?.source_confirmation_id ?? null : null,
          timestamp,
        );
      }
      const artifactIds = new Map<string, string>();
      for (const inputArtifact of document.artifacts) {
        const artifact = normalizeArtifactInput(inputArtifact);
        this.database.run(
          `INSERT INTO artifacts (
            id, project_id, tree_id, kind, locator, status, metadata_json, created_at, updated_at,
            granularity, artifact_type, path_or_name, parent_artifact_id, identity_strategy, confidence,
            current_hash_or_version, source_planning_revision_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
          ON CONFLICT(project_id, kind, locator) DO UPDATE SET
            tree_id = excluded.tree_id, status = excluded.status, metadata_json = excluded.metadata_json,
            granularity = excluded.granularity, artifact_type = excluded.artifact_type,
            path_or_name = excluded.path_or_name, identity_strategy = excluded.identity_strategy,
            confidence = excluded.confidence, current_hash_or_version = excluded.current_hash_or_version,
            source_planning_revision_id = excluded.source_planning_revision_id, updated_at = excluded.updated_at`,
          artifact.id, projectId, tree.id, artifact.kind, artifact.locator, artifact.status,
          canonicalJson(artifact.metadata), timestamp, timestamp, artifact.granularity, artifact.artifactType,
          artifact.pathOrName, artifact.identityStrategy, artifact.confidence,
          artifact.currentHashOrVersion ?? null, revisionId,
        );
        const persisted = this.database.get<{ id: string }>(
          "SELECT id FROM artifacts WHERE project_id = ? AND kind = ? AND locator = ?",
          projectId, artifact.kind, artifact.locator,
        );
        if (persisted) artifactIds.set(artifact.id, persisted.id);
      }
      for (const inputArtifact of document.artifacts) {
        const artifact = normalizeArtifactInput(inputArtifact);
        if (artifact.parentArtifactId) {
          this.database.run(
            "UPDATE artifacts SET parent_artifact_id = ? WHERE id = ?",
            artifactIds.get(artifact.parentArtifactId) ?? artifact.parentArtifactId,
            artifactIds.get(artifact.id) ?? artifact.id,
          );
        }
      }
      for (const link of document.artifactLinks ?? []) {
        this.database.run(`
          INSERT INTO task_node_artifact_links (
            id, project_id, tree_id, tree_revision_id, task_node_id, task_node_revision_id,
            artifact_id, relation_type, source_planning_revision_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, newId(), projectId, tree.id, revisionId, link.taskNodeId, nodeRevisionIds.get(link.taskNodeId)!,
        artifactIds.get(link.artifactId) ?? link.artifactId, link.relationType, revisionId, timestamp);
      }
      for (const relation of document.artifactRelations ?? []) {
        this.database.run(`
          INSERT INTO artifact_graph_relations (
            id, project_id, tree_id, tree_revision_id, from_artifact_id, to_artifact_id,
            kind, source_planning_revision_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, newId(), projectId, tree.id, revisionId,
        artifactIds.get(relation.fromArtifactId) ?? relation.fromArtifactId,
        artifactIds.get(relation.toArtifactId) ?? relation.toArtifactId,
        relation.kind, revisionId, timestamp);
      }
      for (const contract of document.artifactContracts ?? []) {
        this.database.run(`
          INSERT INTO artifact_contracts (
            id, contract_id, project_id, tree_id, tree_revision_id, artifact_id, contract_name,
            contract_version, compatibility_policy, schema_or_signature, provider_revision_ids_json,
            consumer_revision_ids_json, validation_refs_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, newId(), contract.id, projectId, tree.id, revisionId,
        artifactIds.get(contract.artifactId) ?? contract.artifactId, contract.name, contract.version,
        contract.compatibilityPolicy, contract.schemaOrSignature,
        canonicalJson(contract.providerNodeIds.map((nodeId) => nodeRevisionIds.get(nodeId))),
        canonicalJson(contract.consumerNodeIds.map((nodeId) => nodeRevisionIds.get(nodeId))),
        canonicalJson(contract.validationRefs), timestamp);
      }
      document.relations.forEach((relation) => this.database.run(
        "INSERT INTO task_relation_edges (id, tree_revision_id, from_node_id, to_node_id, kind, artifact_id) VALUES (?, ?, ?, ?, ?, ?)",
        newId(), revisionId, relation.fromNodeId, relation.toNodeId, relation.kind, relation.artifactId ?? null,
      ));
      for (const criterion of document.skeletonCriteria ?? []) {
        this.database.run(`
          INSERT INTO skeleton_acceptance_criteria (
            id, tree_revision_id, criterion, satisfied, evidence_trace_id,
            branch_task_node_id, criteria_json, source_planning_revision_id
          ) VALUES (?, ?, ?, 0, NULL, ?, ?, ?)
        `, newId(), revisionId, criterion.readinessConditions.join("; "), criterion.branchNodeId,
        canonicalJson(criterion), revisionId);
      }
      this.database.run("UPDATE task_trees SET current_revision_id = ?, updated_at = ? WHERE id = ?", revisionId, timestamp, tree.id);
      this.database.run(
        "UPDATE workflow_states SET stage = 'task_tree_refinement', revision = revision + 1, updated_at = ? WHERE project_id = ? AND tree_id = ? AND active = 1 AND stage IN ('draft_task_tree', 'branch_confirmation')",
        timestamp, projectId, tree.id,
      );
    };
    if (wrap) this.database.transaction(work); else work();
    return { treeId: tree.id, revisionId, revision, title: tree.title, status: tree.status, document };
  }

  private assertValidDocument(document: TaskTreeDocument): void {
    if (document.planningVersion === 1) {
      const errors = validateDraftStructure(document);
      if (!errors.length) return;
      throw new HarnessError("invalid_tree_structure", "Task Tree draft failed deterministic structural validation", errors);
    }
    const validation = validateTaskTree(document);
    if (validation.ok) return;
    const code = validation.errors.some((error) => error.code === "relation_artifact_required")
      ? "relation_artifact_required"
      : validation.errors.some((error) => error.code === "leaf_contract_invalid") ? "leaf_contract_invalid" : "invalid_tree_structure";
    throw new HarnessError(code, "Task Tree document failed deterministic validation", validation.errors);
  }

  private requireProject(projectId: string): void {
    if (!this.database.get("SELECT id FROM projects WHERE id = ?", projectId)) throw new HarnessError("project_not_registered", "project is not registered");
  }

  private requireTree(projectId: string, treeId: string): TreeRow {
    const tree = this.database.get<TreeRow>(
      "SELECT id, title, status, current_revision_id, updated_at, archived_at, archived_from_status FROM task_trees WHERE id = ? AND project_id = ?",
      treeId, projectId,
    );
    if (!tree) throw new HarnessError("not_found", "Task Tree was not found in the current project");
    return tree;
  }

  private requireRevision(revisionId: string): RevisionRow {
    const revision = this.database.get<RevisionRow>("SELECT id, revision, document_json, created_at FROM task_tree_revisions WHERE id = ?", revisionId);
    if (!revision) throw new HarnessError("not_found", "Task Tree revision was not found");
    return revision;
  }

  private assertTreeMutable(tree: TreeRow): void {
    if (tree.status === "archived") {
      throw new HarnessError("task_tree_transition_rejected", "archived Task Trees are read-only until restored");
    }
  }

  private assertNoActiveAttempt(projectId: string, treeId: string): void {
    const attempt = this.database.get<{ id: string }>(`
      SELECT id FROM execution_attempts
      WHERE project_id = ? AND tree_id = ? AND status IN ('running', 'verifying')
      ORDER BY started_at DESC, id DESC LIMIT 1
    `, projectId, treeId);
    if (attempt) {
      throw new HarnessError(
        "task_tree_transition_rejected",
        "complete or abort the active execution Attempt before switching or archiving this Task Tree",
        { attemptId: attempt.id, treeId },
      );
    }
  }

  private selectedTreeId(projectId: string): string | null {
    return this.database.get<{ selected_tree_id: string | null }>(
      "SELECT selected_tree_id FROM runtime_states WHERE project_id = ?", projectId,
    )?.selected_tree_id ?? null;
  }

  private upsertRuntimeSelection(projectId: string, treeId: string | null, nodeId: string | null, timestamp: string): void {
    this.database.run(`
      INSERT INTO runtime_states (project_id, selected_tree_id, selected_node_id, state_json, updated_at)
      VALUES (?, ?, ?, '{}', ?)
      ON CONFLICT(project_id) DO UPDATE SET
        selected_tree_id = excluded.selected_tree_id,
        selected_node_id = excluded.selected_node_id,
        updated_at = excluded.updated_at
    `, projectId, treeId, nodeId, timestamp);
  }

  private appendCollectionTransition(input: {
    projectId: string;
    treeId: string;
    action: TaskTreeCollectionAction;
    fromStatus: string | null;
    toStatus: string;
    previousSelectedTreeId: string | null;
    selectedTreeId: string | null;
    timestamp: string;
  }): string {
    const transitionId = newId();
    this.database.run(`
      INSERT INTO task_tree_collection_transitions (
        id, project_id, tree_id, action, from_status, to_status,
        previous_selected_tree_id, selected_tree_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, transitionId, input.projectId, input.treeId, input.action, input.fromStatus, input.toStatus,
    input.previousSelectedTreeId, input.selectedTreeId, input.timestamp);
    return transitionId;
  }
}
