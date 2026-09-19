import { HarnessError } from "../domain/errors.js";
import { deriveConfirmationStates, resolveConfirmationScope, type ConfirmationState } from "../domain/confirmation.js";
import { normalizeArtifactInput } from "../domain/artifact-graph.js";
import { newId, nowIso } from "../domain/ids.js";
import { canonicalJson } from "../domain/trace.js";
import { validateTaskTree, type TaskTreeDocument } from "../domain/task-tree.js";
import type { RuntimeDatabase } from "../storage/database.js";

interface TreeRow {
  id: string;
  title: string;
  status: string;
  current_revision_id: string;
  updated_at: string;
}

interface RevisionRow {
  id: string;
  revision: number;
  document_json: string;
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

  listTaskTreeCandidates(input: { projectId: string; query?: string }) {
    const trees = this.database.all<TreeRow>(
      "SELECT id, title, status, current_revision_id, updated_at FROM task_trees WHERE project_id = ? ORDER BY updated_at DESC",
      input.projectId,
    );
    const query = input.query?.trim().toLowerCase();
    return trees.flatMap((tree) => {
      const matchedBy: string[] = [];
      if (!query) matchedBy.push("recent");
      if (query && tree.id.toLowerCase() === query) matchedBy.push("tree_id");
      if (query && tree.title.toLowerCase().includes(query)) matchedBy.push("title");
      const artifactMatch = query
        ? this.database.get("SELECT id FROM artifacts WHERE tree_id = ? AND lower(locator) LIKE ? LIMIT 1", tree.id, `%${query}%`)
        : undefined;
      if (artifactMatch) matchedBy.push("artifact");
      return matchedBy.length ? [{ treeId: tree.id, title: tree.title, status: tree.status, matchedBy, updatedAt: tree.updated_at }] : [];
    });
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
      this.database.run("INSERT INTO runtime_states (project_id, selected_tree_id, selected_node_id, state_json, updated_at) VALUES (?, ?, ?, '{}', ?)", input.projectId, treeId, nodeId, timestamp);
    });
    return { treeId, revisionId, revision: 1, title: input.title.trim(), status: "draft", document };
  }

  saveDraftRevision(input: { projectId: string; treeId: string; baseRevisionId: string; document: TaskTreeDocument }): TaskTreeRevisionView {
    const tree = this.requireTree(input.projectId, input.treeId);
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
    const tree = this.requireTree(input.projectId, input.treeId);
    if (tree.current_revision_id !== input.baseRevisionId) throw new HarnessError("revision_conflict", "the Draft Change Set has a stale base revision");
    if (input.operations.length !== 1 || input.operations[0]?.op !== "replace_document" || !input.decisionSummary.trim()) {
      throw new HarnessError("invalid_input", "a documented replace_document operation is required");
    }
    const document = input.operations[0].document;
    this.assertValidDocument(document);
    const changeSetId = newId();
    return this.database.transaction(() => {
      this.database.run(
        "INSERT INTO draft_change_sets (id, tree_id, base_revision_id, operations_json, affected_references_json, decision_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        changeSetId, input.treeId, input.baseRevisionId, canonicalJson(input.operations), canonicalJson(input.affectedReferences), input.decisionSummary, nowIso(),
      );
      return this.persistRevision(tree, input.projectId, document, false);
    });
  }

  scanPlanReadiness(input: { projectId: string; treeId: string; scopeRootNodeId?: string }) {
    const tree = this.requireTree(input.projectId, input.treeId);
    const revision = this.requireRevision(tree.current_revision_id);
    const document = JSON.parse(revision.document_json) as TaskTreeDocument;
    const coveredNodeIds = resolveConfirmationScope(document, input.scopeRootNodeId);
    if (!coveredNodeIds) throw new HarnessError("not_found", "confirmation scope root was not found in the current Task Tree revision");
    const validation = validateTaskTree(document);
    const scopeKind = input.scopeRootNodeId ? "branch" as const : "tree" as const;
    const result = {
      resultId: newId(), treeId: tree.id, revisionId: revision.id, ready: validation.ok, blockers: validation.errors,
      scopeKind, scopeRootNodeId: input.scopeRootNodeId ?? null, coveredNodeIds,
    };
    this.database.transaction(() => {
      const timestamp = nowIso();
      this.database.run(
        "INSERT INTO plan_readiness_results (id, tree_id, revision_id, ready, blockers_json, created_at, scope_kind, scope_root_node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        result.resultId, tree.id, revision.id, result.ready ? 1 : 0, canonicalJson(result.blockers), timestamp, scopeKind, input.scopeRootNodeId ?? null,
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

  private persistRevision(tree: TreeRow, projectId: string, document: TaskTreeDocument, wrap = true): TaskTreeRevisionView {
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
    const tree = this.database.get<TreeRow>("SELECT id, title, status, current_revision_id, updated_at FROM task_trees WHERE id = ? AND project_id = ?", treeId, projectId);
    if (!tree) throw new HarnessError("not_found", "Task Tree was not found in the current project");
    return tree;
  }

  private requireRevision(revisionId: string): RevisionRow {
    const revision = this.database.get<RevisionRow>("SELECT id, revision, document_json FROM task_tree_revisions WHERE id = ?", revisionId);
    if (!revision) throw new HarnessError("not_found", "Task Tree revision was not found");
    return revision;
  }
}
