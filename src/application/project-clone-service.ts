import { randomBytes } from "node:crypto";
import { HarnessError } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
import { mapClonedTaskNodeStatus, rebaseCloneLocator, rewriteTaskTreeDocumentForClone } from "../domain/project-clone.js";
import type { TaskTreeDocument } from "../domain/task-tree.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";

interface CloneCounts {
  taskTrees: number;
  taskTreeRevisions: number;
  taskNodes: number;
  taskNodeRevisions: number;
  artifacts: number;
  inheritedEvidence: number;
}

interface ProjectCloneView {
  cloneId: string;
  sourceProjectId: string;
  targetProjectId: string;
  identityToken: string;
  status: string;
  entityCounts: CloneCounts;
  created: boolean;
}

interface CloneMaps {
  trees: Map<string, string>;
  revisions: Map<string, string>;
  nodes: Map<string, string>;
  nodeRevisions: Map<string, string>;
  artifacts: Map<string, string>;
}

export class ProjectCloneService {
  constructor(private readonly database: RuntimeDatabase) {}

  cloneProject(input: {
    sourceProjectId: string;
    targetCanonicalPath: string;
    targetDisplayPath: string;
    platform: string;
  }): ProjectCloneView {
    const source = this.database.get<{ id: string; canonical_path: string }>(
      "SELECT id, canonical_path FROM projects WHERE id = ?", input.sourceProjectId,
    );
    if (!source) throw new HarnessError("not_found", "source Project was not found");
    const existing = this.database.get<{
      id: string; identity_token: string | null; cloned_from_project_id: string | null;
      clone_id: string | null; clone_status: string | null; cloned_entity_counts_json: string | null;
    }>(`SELECT p.id, p.identity_token, p.cloned_from_project_id, c.id AS clone_id,
               c.status AS clone_status, c.cloned_entity_counts_json
        FROM projects p LEFT JOIN project_clone_records c ON c.target_project_id = p.id
        WHERE p.canonical_path = ?`, input.targetCanonicalPath);
    if (existing) {
      if (existing.cloned_from_project_id !== source.id || !existing.clone_id || !existing.identity_token) {
        throw new HarnessError("project_identity_conflict", "target path already belongs to another Project");
      }
      return {
        cloneId: existing.clone_id, sourceProjectId: source.id, targetProjectId: existing.id,
        identityToken: existing.identity_token, status: existing.clone_status ?? "incomplete",
        entityCounts: JSON.parse(existing.cloned_entity_counts_json ?? "{}") as CloneCounts, created: false,
      };
    }

    const trees = this.database.all<{
      id: string; title: string; status: string; current_revision_id: string | null;
    }>("SELECT id, title, status, current_revision_id FROM task_trees WHERE project_id = ? ORDER BY created_at, id", source.id);
    const revisions = this.database.all<{
      id: string; tree_id: string; revision: number; document_json: string;
    }>(`SELECT r.id, r.tree_id, r.revision, r.document_json
        FROM task_tree_revisions r JOIN task_trees t ON t.id = r.tree_id
        WHERE t.project_id = ? ORDER BY r.tree_id, r.revision`, source.id);
    const documents = new Map(revisions.map((row) => [row.id, JSON.parse(row.document_json) as TaskTreeDocument]));
    const nodes = this.database.all<{
      id: string; tree_id: string; parent_id: string | null; title: string; status: string;
    }>(`SELECT n.id, n.tree_id, n.parent_id, n.title, n.status FROM task_nodes n
        JOIN task_trees t ON t.id = n.tree_id WHERE t.project_id = ? ORDER BY n.tree_id, n.id`, source.id);
    const nodeRevisions = this.database.all<{
      id: string; node_id: string; tree_revision_id: string;
    }>(`SELECT nr.id, nr.node_id, nr.tree_revision_id FROM task_node_revisions nr
        JOIN task_nodes n ON n.id = nr.node_id JOIN task_trees t ON t.id = n.tree_id
        WHERE t.project_id = ? ORDER BY nr.tree_revision_id, nr.node_id`, source.id);
    const artifacts = this.database.all<Record<string, unknown> & {
      id: string; tree_id: string | null; kind: string; locator: string; status: string; metadata_json: string;
      granularity: string; artifact_type: string; path_or_name: string | null; parent_artifact_id: string | null;
      identity_strategy: string; planned_by_task_node_id: string | null; plan_baseline_at: string | null;
      current_hash_or_version: string | null; source_planning_revision_id: string | null;
    }>("SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at, id", source.id);
    const evaluations = this.database.all<{
      id: string; task_node_id: string; task_node_revision_id: string; execution_attempt_id: string;
      verdict: string; evidence_refs_json: string; created_at: string;
    }>("SELECT id, task_node_id, task_node_revision_id, execution_attempt_id, verdict, evidence_refs_json, created_at FROM evaluations WHERE project_id = ? ORDER BY created_at, id", source.id);

    const cloneId = newId();
    const targetProjectId = newId();
    const identityToken = randomBytes(32).toString("hex");
    const createdAt = nowIso();
    const maps: CloneMaps = {
      trees: new Map(trees.map((row) => [row.id, newId()])),
      revisions: new Map(revisions.map((row) => [row.id, newId()])),
      nodes: new Map(nodes.map((row) => [row.id, newId()])),
      nodeRevisions: new Map(nodeRevisions.map((row) => [row.id, newId()])),
      artifacts: new Map(artifacts.map((row) => [row.id, newId()])),
    };
    const rewrittenDocuments = new Map(revisions.map((row) => [row.id, rewriteTaskTreeDocumentForClone({
      document: documents.get(row.id)!, nodeIds: maps.nodes, artifactIds: maps.artifacts,
      sourceRoot: source.canonical_path, targetRoot: input.targetCanonicalPath,
    })]));
    const counts: CloneCounts = {
      taskTrees: trees.length, taskTreeRevisions: revisions.length, taskNodes: nodes.length,
      taskNodeRevisions: nodeRevisions.length, artifacts: artifacts.length, inheritedEvidence: evaluations.length,
    };

    this.database.transaction(() => {
      this.insertTargetProject({ ...input, sourceProjectId: source.id, targetProjectId, identityToken, createdAt });
      this.database.run(`INSERT INTO project_clone_records (
        id, source_project_id, target_project_id, source_path, target_path,
        cloned_entity_counts_json, provenance_policy_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'cloning', ?)`, cloneId, source.id, targetProjectId,
      source.canonical_path, input.targetCanonicalPath, canonicalJson(counts), canonicalJson({
        traceEvents: "source_provenance_only", evaluations: "inherited_from_clone",
        executionContext: "fresh_paused_runtime", artifacts: "planned_projection",
      }), createdAt);

      this.copyTaskStructure({ cloneId, sourceProjectId: source.id, targetProjectId, sourcePath: source.canonical_path,
        targetPath: input.targetCanonicalPath, createdAt, trees, revisions, nodes, nodeRevisions,
        rewrittenDocuments, maps });
      this.copyArtifacts({ sourceProjectId: source.id, targetProjectId, sourcePath: source.canonical_path,
        targetPath: input.targetCanonicalPath, cloneId, createdAt, artifacts, maps });
      this.copyArtifactGraph(source.id, targetProjectId, maps, createdAt);
      this.copyConfirmationAndEvidence({ sourceProjectId: source.id, targetProjectId, cloneId, createdAt, evaluations, maps });
      this.createFreshRuntime({ sourceProjectId: source.id, targetProjectId, cloneId, createdAt, maps });
      this.database.run(`UPDATE project_clone_records SET status = 'incomplete',
        error_summary = 'marker_write_pending', completed_at = ? WHERE id = ?`, createdAt, cloneId);
    });

    return { cloneId, sourceProjectId: source.id, targetProjectId, identityToken,
      status: "incomplete", entityCounts: counts, created: true };
  }

  markMarkerWritten(input: { cloneId: string; targetProjectId: string }): void {
    const clone = this.database.get<{ status: string }>(
      "SELECT status FROM project_clone_records WHERE id = ? AND target_project_id = ?", input.cloneId, input.targetProjectId,
    );
    if (!clone) throw new HarnessError("not_found", "Project Clone Record was not found");
    if (clone.status === "completed" || clone.status === "recovered") return;
    this.database.run("UPDATE project_clone_records SET status = 'completed', error_summary = NULL, completed_at = ? WHERE id = ?",
      nowIso(), input.cloneId);
  }

  private insertTargetProject(input: {
    sourceProjectId: string; targetProjectId: string; identityToken: string;
    targetCanonicalPath: string; targetDisplayPath: string; platform: string; createdAt: string;
  }): void {
    this.database.run(`INSERT INTO projects (
      id, canonical_path, marker_id, identity_token, display_path, display_name, platform,
      cloned_from_project_id, cloned_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, input.targetProjectId, input.targetCanonicalPath,
    input.targetProjectId, input.identityToken, input.targetDisplayPath,
    input.targetDisplayPath.split(/[\\/]/).filter(Boolean).at(-1) ?? input.targetDisplayPath,
    input.platform, input.sourceProjectId, input.createdAt, input.createdAt, input.createdAt);
    this.database.run(`INSERT INTO project_path_aliases (
      project_id, normalized_path, observed_path, platform, is_primary, created_at
    ) VALUES (?, ?, ?, ?, 1, ?)`, input.targetProjectId, input.targetCanonicalPath,
    input.targetDisplayPath, input.platform, input.createdAt);
  }

  private copyTaskStructure(input: {
    cloneId: string; sourceProjectId: string; targetProjectId: string; sourcePath: string; targetPath: string; createdAt: string;
    trees: Array<{ id: string; title: string; status: string; current_revision_id: string | null }>;
    revisions: Array<{ id: string; tree_id: string; revision: number; document_json: string }>;
    nodes: Array<{ id: string; tree_id: string; parent_id: string | null; title: string; status: string }>;
    nodeRevisions: Array<{ id: string; node_id: string; tree_revision_id: string }>;
    rewrittenDocuments: Map<string, TaskTreeDocument>; maps: CloneMaps;
  }): void {
    const { maps } = input;
    for (const tree of input.trees) {
      this.database.run(`INSERT INTO task_trees (
        id, project_id, title, status, current_revision_id, created_at, updated_at, cloned_from_task_tree_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, maps.trees.get(tree.id)!, input.targetProjectId, tree.title, tree.status,
      tree.current_revision_id ? maps.revisions.get(tree.current_revision_id)! : null, input.createdAt, input.createdAt, tree.id);
      this.map(input.cloneId, "task_tree", tree.id, maps.trees.get(tree.id)!, input.createdAt);
    }
    for (const revision of input.revisions) {
      this.database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES (?, ?, ?, ?, ?)",
        maps.revisions.get(revision.id)!, maps.trees.get(revision.tree_id)!, revision.revision,
        canonicalJson(input.rewrittenDocuments.get(revision.id)!), input.createdAt);
      this.map(input.cloneId, "task_tree_revision", revision.id, maps.revisions.get(revision.id)!, input.createdAt);
    }
    for (const node of input.nodes) {
      this.database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES (?, ?, ?, ?, ?)",
        maps.nodes.get(node.id)!, maps.trees.get(node.tree_id)!, node.parent_id ? maps.nodes.get(node.parent_id)! : null,
        node.title, mapClonedTaskNodeStatus(node.status, false));
      this.map(input.cloneId, "task_node", node.id, maps.nodes.get(node.id)!, input.createdAt);
    }
    for (const revision of input.nodeRevisions) {
      const mappedNodeId = maps.nodes.get(revision.node_id)!;
      const body = input.rewrittenDocuments.get(revision.tree_revision_id)!.nodes.find((node) => node.id === mappedNodeId);
      if (!body) throw new HarnessError("project_clone_invalid", "Task Node revision body was not found in rewritten document");
      this.database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES (?, ?, ?, ?, ?)",
        maps.nodeRevisions.get(revision.id)!, mappedNodeId, maps.revisions.get(revision.tree_revision_id)!, canonicalJson(body), input.createdAt);
      this.map(input.cloneId, "task_node_revision", revision.id, maps.nodeRevisions.get(revision.id)!, input.createdAt);
    }
    for (const row of this.database.all<{ node_revision_id: string }>(`
      SELECT l.node_revision_id FROM leaf_task_contracts l JOIN task_node_revisions nr ON nr.id = l.node_revision_id
      JOIN task_nodes n ON n.id = nr.node_id JOIN task_trees t ON t.id = n.tree_id WHERE t.project_id = ?`, input.sourceProjectId)) {
      const targetRevisionId = maps.nodeRevisions.get(row.node_revision_id)!;
      const body = this.database.get<{ body_json: string }>("SELECT body_json FROM task_node_revisions WHERE id = ?", targetRevisionId)!;
      this.database.run("INSERT INTO leaf_task_contracts (node_revision_id, contract_json) VALUES (?, ?)", targetRevisionId, body.body_json);
    }
    for (const row of this.database.all<{ id: string; tree_revision_id: string; criterion: string; criteria_json: string | null }>(`
      SELECT s.id, s.tree_revision_id, s.criterion, s.criteria_json FROM skeleton_acceptance_criteria s
      JOIN task_tree_revisions r ON r.id = s.tree_revision_id JOIN task_trees t ON t.id = r.tree_id
      WHERE t.project_id = ?`, input.sourceProjectId)) {
      const rewrittenCriterion = row.criteria_json
        ? input.rewrittenDocuments.get(row.tree_revision_id)?.skeletonCriteria?.find((criterion) =>
          criterion.id === (JSON.parse(row.criteria_json!) as { id: string }).id)
        : undefined;
      const targetRevisionId = maps.revisions.get(row.tree_revision_id)!;
      this.database.run(`
        INSERT INTO skeleton_acceptance_criteria (
          id, tree_revision_id, criterion, satisfied, evidence_trace_id,
          branch_task_node_id, criteria_json, source_planning_revision_id
        ) VALUES (?, ?, ?, 0, NULL, ?, ?, ?)
      `, newId(), targetRevisionId, row.criterion, rewrittenCriterion?.branchNodeId ?? null,
      rewrittenCriterion ? canonicalJson(rewrittenCriterion) : null, targetRevisionId);
    }
    for (const row of this.database.all<{ tree_revision_id: string; from_node_id: string; to_node_id: string; kind: string; artifact_id: string | null }>(`
      SELECT e.tree_revision_id, e.from_node_id, e.to_node_id, e.kind, e.artifact_id
      FROM task_relation_edges e JOIN task_tree_revisions r ON r.id = e.tree_revision_id
      JOIN task_trees t ON t.id = r.tree_id WHERE t.project_id = ?`, input.sourceProjectId)) {
      this.database.run("INSERT INTO task_relation_edges (id, tree_revision_id, from_node_id, to_node_id, kind, artifact_id) VALUES (?, ?, ?, ?, ?, ?)",
        newId(), maps.revisions.get(row.tree_revision_id)!, maps.nodes.get(row.from_node_id)!, maps.nodes.get(row.to_node_id)!, row.kind,
        row.artifact_id ? maps.artifacts.get(row.artifact_id)! : null);
    }
  }

  private copyArtifacts(input: {
    sourceProjectId: string; targetProjectId: string; sourcePath: string; targetPath: string;
    cloneId: string; createdAt: string; maps: CloneMaps;
    artifacts: Array<Record<string, unknown> & {
      id: string; tree_id: string | null; kind: string; locator: string; status: string; metadata_json: string;
      granularity: string; artifact_type: string; path_or_name: string | null; parent_artifact_id: string | null;
      identity_strategy: string; planned_by_task_node_id: string | null; plan_baseline_at: string | null;
      current_hash_or_version: string | null; source_planning_revision_id: string | null;
    }>;
  }): void {
    for (const artifact of input.artifacts) {
      const locator = rebaseCloneLocator(artifact.locator, input.sourcePath, input.targetPath);
      const pathOrName = artifact.path_or_name
        ? rebaseCloneLocator(artifact.path_or_name, input.sourcePath, input.targetPath) : null;
      const metadata = {
        ...(JSON.parse(artifact.metadata_json) as Record<string, unknown>), clonedFromArtifactId: artifact.id,
        ...(locator.externalReference ? { externalReference: true } : {}),
      };
      this.database.run(`INSERT INTO artifacts (
        id, project_id, tree_id, kind, locator, status, metadata_json, created_at, updated_at,
        granularity, artifact_type, path_or_name, parent_artifact_id, identity_strategy, confidence,
        planned_by_task_node_id, plan_baseline_at, current_hash_or_version, source_trace_event_id,
        source_planning_revision_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'planned', ?, ?, ?, NULL, ?)`,
      input.maps.artifacts.get(artifact.id)!, input.targetProjectId,
      artifact.tree_id ? input.maps.trees.get(artifact.tree_id)! : null,
      artifact.kind, locator.locator, artifact.status === "draft" ? "draft" : "planned", canonicalJson(metadata),
      input.createdAt, input.createdAt, artifact.granularity, artifact.artifact_type,
      pathOrName?.locator ?? artifact.path_or_name, artifact.identity_strategy,
      artifact.planned_by_task_node_id ? input.maps.nodes.get(artifact.planned_by_task_node_id)! : null,
      artifact.plan_baseline_at, artifact.current_hash_or_version,
      artifact.source_planning_revision_id ? input.maps.revisions.get(artifact.source_planning_revision_id) ?? null : null);
      this.map(input.cloneId, "artifact", artifact.id, input.maps.artifacts.get(artifact.id)!, input.createdAt);
    }
    for (const artifact of input.artifacts) if (artifact.parent_artifact_id) {
      this.database.run("UPDATE artifacts SET parent_artifact_id = ? WHERE id = ?",
        input.maps.artifacts.get(artifact.parent_artifact_id)!, input.maps.artifacts.get(artifact.id)!);
    }
  }

  private copyArtifactGraph(sourceProjectId: string, targetProjectId: string, maps: CloneMaps, createdAt: string): void {
    for (const row of this.database.all<{ from_artifact_id: string; to_artifact_id: string; kind: string }>(
      "SELECT from_artifact_id, to_artifact_id, kind FROM artifact_relations WHERE project_id = ?", sourceProjectId,
    )) this.database.run("INSERT INTO artifact_relations (id, project_id, from_artifact_id, to_artifact_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      newId(), targetProjectId, maps.artifacts.get(row.from_artifact_id)!, maps.artifacts.get(row.to_artifact_id)!, row.kind, createdAt);

    for (const row of this.database.all<{
      tree_id: string; tree_revision_id: string; task_node_id: string; task_node_revision_id: string;
      artifact_id: string; relation_type: string; source_planning_revision_id: string;
    }>("SELECT tree_id, tree_revision_id, task_node_id, task_node_revision_id, artifact_id, relation_type, source_planning_revision_id FROM task_node_artifact_links WHERE project_id = ?", sourceProjectId)) {
      this.database.run(`INSERT INTO task_node_artifact_links (
        id, project_id, tree_id, tree_revision_id, task_node_id, task_node_revision_id,
        artifact_id, relation_type, source_planning_revision_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, newId(), targetProjectId, maps.trees.get(row.tree_id)!,
      maps.revisions.get(row.tree_revision_id)!, maps.nodes.get(row.task_node_id)!, maps.nodeRevisions.get(row.task_node_revision_id)!,
      maps.artifacts.get(row.artifact_id)!, row.relation_type, maps.revisions.get(row.source_planning_revision_id)!, createdAt);
    }
    for (const row of this.database.all<{
      tree_id: string | null; tree_revision_id: string | null; from_artifact_id: string; to_artifact_id: string;
      kind: string; source_planning_revision_id: string | null;
    }>("SELECT tree_id, tree_revision_id, from_artifact_id, to_artifact_id, kind, source_planning_revision_id FROM artifact_graph_relations WHERE project_id = ?", sourceProjectId)) {
      this.database.run(`INSERT INTO artifact_graph_relations (
        id, project_id, tree_id, tree_revision_id, from_artifact_id, to_artifact_id, kind,
        source_trace_event_id, source_planning_revision_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`, newId(), targetProjectId,
      row.tree_id ? maps.trees.get(row.tree_id)! : null,
      row.tree_revision_id ? maps.revisions.get(row.tree_revision_id)! : null,
      maps.artifacts.get(row.from_artifact_id)!, maps.artifacts.get(row.to_artifact_id)!, row.kind,
      row.source_planning_revision_id ? maps.revisions.get(row.source_planning_revision_id) ?? null : null, createdAt);
    }
    for (const row of this.database.all<{
      contract_id: string; tree_id: string; tree_revision_id: string; artifact_id: string;
      contract_name: string; contract_version: string; compatibility_policy: string; schema_or_signature: string;
      provider_revision_ids_json: string; consumer_revision_ids_json: string; validation_refs_json: string;
    }>("SELECT contract_id, tree_id, tree_revision_id, artifact_id, contract_name, contract_version, compatibility_policy, schema_or_signature, provider_revision_ids_json, consumer_revision_ids_json, validation_refs_json FROM artifact_contracts WHERE project_id = ?", sourceProjectId)) {
      const mapRevisions = (json: string) => canonicalJson((JSON.parse(json) as string[]).map((id) => maps.nodeRevisions.get(id)!));
      this.database.run(`INSERT INTO artifact_contracts (
        id, contract_id, project_id, tree_id, tree_revision_id, artifact_id, contract_name,
        contract_version, compatibility_policy, schema_or_signature, provider_revision_ids_json,
        consumer_revision_ids_json, validation_refs_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, newId(), row.contract_id, targetProjectId,
      maps.trees.get(row.tree_id)!, maps.revisions.get(row.tree_revision_id)!, maps.artifacts.get(row.artifact_id)!,
      row.contract_name, row.contract_version, row.compatibility_policy, row.schema_or_signature,
      mapRevisions(row.provider_revision_ids_json), mapRevisions(row.consumer_revision_ids_json),
      row.validation_refs_json, createdAt);
    }
  }

  private copyConfirmationAndEvidence(input: {
    sourceProjectId: string; targetProjectId: string; cloneId: string; createdAt: string; maps: CloneMaps;
    evaluations: Array<{
      id: string; task_node_id: string; task_node_revision_id: string; execution_attempt_id: string;
      verdict: string; evidence_refs_json: string; created_at: string;
    }>;
  }): void {
    for (const state of this.database.all<{
      tree_id: string; tree_revision_id: string; task_node_id: string; state: string;
    }>("SELECT tree_id, tree_revision_id, task_node_id, state FROM task_node_confirmation_states WHERE project_id = ?", input.sourceProjectId)) {
      this.database.run(`INSERT INTO task_node_confirmation_states (
        project_id, tree_id, tree_revision_id, task_node_id, state, source_confirmation_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?)`, input.targetProjectId, input.maps.trees.get(state.tree_id)!,
      input.maps.revisions.get(state.tree_revision_id)!, input.maps.nodes.get(state.task_node_id)!, state.state, input.createdAt);
    }
    for (const evaluation of input.evaluations) {
      this.database.run(`INSERT INTO project_clone_inherited_evidence (
        id, clone_id, source_project_id, target_project_id, evidence_kind, source_entity_id,
        target_entity_id, inheritance_status, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, 'evaluation', ?, ?, 'needs_revalidation', ?, ?)`, newId(), input.cloneId,
      input.sourceProjectId, input.targetProjectId, evaluation.id,
      input.maps.nodeRevisions.get(evaluation.task_node_revision_id) ?? input.maps.nodes.get(evaluation.task_node_id) ?? null,
      canonicalJson({
        sourceAttemptId: evaluation.execution_attempt_id, verdict: evaluation.verdict,
        sourceEvidenceRefs: JSON.parse(evaluation.evidence_refs_json) as string[], sourceCreatedAt: evaluation.created_at,
      }), input.createdAt);
    }
  }

  private createFreshRuntime(input: {
    sourceProjectId: string; targetProjectId: string; cloneId: string; createdAt: string; maps: CloneMaps;
  }): void {
    const sourceRuntime = this.database.get<{ selected_tree_id: string | null; selected_node_id: string | null }>(
      "SELECT selected_tree_id, selected_node_id FROM runtime_states WHERE project_id = ?", input.sourceProjectId,
    );
    const firstTree = input.maps.trees.values().next().value as string | undefined;
    const selectedTreeId = sourceRuntime?.selected_tree_id
      ? input.maps.trees.get(sourceRuntime.selected_tree_id) ?? null : firstTree ?? null;
    const selectedNodeId = sourceRuntime?.selected_node_id
      ? input.maps.nodes.get(sourceRuntime.selected_node_id) ?? null : null;
    if (selectedTreeId) {
      this.database.run("INSERT INTO workflow_states (id, project_id, tree_id, stage, revision, active, updated_at) VALUES (?, ?, ?, 'task_tree_refinement', 1, 1, ?)",
        newId(), input.targetProjectId, selectedTreeId, input.createdAt);
    }
    this.database.run("INSERT INTO runtime_states (project_id, selected_tree_id, selected_node_id, state_json, updated_at) VALUES (?, ?, ?, ?, ?)",
      input.targetProjectId, selectedTreeId, selectedNodeId, canonicalJson({
        state: "paused_after_clone", cloneId: input.cloneId,
        sourceProjectId: input.sourceProjectId, requiresRevalidation: true,
      }), input.createdAt);
  }

  private map(cloneId: string, entityType: string, sourceId: string, targetId: string, createdAt: string): void {
    this.database.run(`INSERT INTO project_clone_entity_maps (
      clone_id, entity_type, source_entity_id, target_entity_id, created_at
    ) VALUES (?, ?, ?, ?, ?)`, cloneId, entityType, sourceId, targetId, createdAt);
  }
}
