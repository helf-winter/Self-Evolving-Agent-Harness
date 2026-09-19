export interface Migration {
  version: number;
  sql: string;
}

export const migrations: Migration[] = [{
  version: 1,
  sql: `
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, marker_id TEXT UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE project_path_aliases (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      normalized_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, normalized_path)
    );
    CREATE TABLE task_trees (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, status TEXT NOT NULL, current_revision_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX task_trees_project_idx ON task_trees(project_id, updated_at DESC);
    CREATE TABLE task_tree_revisions (
      id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, document_json TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(tree_id, revision)
    );
    CREATE TABLE draft_change_sets (
      id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      base_revision_id TEXT NOT NULL REFERENCES task_tree_revisions(id), operations_json TEXT NOT NULL,
      affected_references_json TEXT NOT NULL, decision_summary TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE planning_decisions (
      id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, decision_json TEXT NOT NULL, trace_event_id TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE plan_readiness_results (
      id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      revision_id TEXT NOT NULL REFERENCES task_tree_revisions(id), ready INTEGER NOT NULL,
      blockers_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE task_nodes (
      id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      parent_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE task_node_revisions (
      id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES task_nodes(id) ON DELETE CASCADE,
      tree_revision_id TEXT NOT NULL REFERENCES task_tree_revisions(id) ON DELETE CASCADE,
      body_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE leaf_task_contracts (
      node_revision_id TEXT PRIMARY KEY REFERENCES task_node_revisions(id) ON DELETE CASCADE,
      contract_json TEXT NOT NULL
    );
    CREATE TABLE skeleton_acceptance_criteria (
      id TEXT PRIMARY KEY, tree_revision_id TEXT NOT NULL REFERENCES task_tree_revisions(id) ON DELETE CASCADE,
      criterion TEXT NOT NULL, satisfied INTEGER NOT NULL DEFAULT 0, evidence_trace_id TEXT
    );
    CREATE TABLE task_relation_edges (
      id TEXT PRIMARY KEY, tree_revision_id TEXT NOT NULL REFERENCES task_tree_revisions(id) ON DELETE CASCADE,
      from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL, kind TEXT NOT NULL, artifact_id TEXT
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT REFERENCES task_trees(id) ON DELETE SET NULL, kind TEXT NOT NULL,
      locator TEXT NOT NULL, status TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(project_id, kind, locator)
    );
    CREATE TABLE artifact_relations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      from_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      to_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE workflow_states (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT REFERENCES task_trees(id) ON DELETE CASCADE, stage TEXT NOT NULL,
      revision INTEGER NOT NULL, active INTEGER NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX one_active_workflow_per_project ON workflow_states(project_id) WHERE active = 1;
    CREATE TABLE runtime_states (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      selected_tree_id TEXT, selected_node_id TEXT, state_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE runtime_actions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE runtime_confirmation_prompts (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT REFERENCES task_trees(id) ON DELETE CASCADE, scope_id TEXT NOT NULL,
      prompt TEXT NOT NULL, status TEXT NOT NULL, answer TEXT, answer_trace_event_id TEXT,
      created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE trace_events (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT REFERENCES task_trees(id) ON DELETE SET NULL, node_id TEXT,
      session_id TEXT NOT NULL, event_name TEXT NOT NULL, payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE
    );
    CREATE INDEX trace_project_time_idx ON trace_events(project_id, occurred_at DESC, id DESC);
    CREATE TABLE hook_receipts (
      idempotency_key TEXT PRIMARY KEY, event_name TEXT NOT NULL, received_at TEXT NOT NULL
    );
  `,
}, {
  version: 2,
  sql: `
    CREATE TABLE execution_attempts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      task_node_id TEXT NOT NULL REFERENCES task_nodes(id) ON DELETE CASCADE,
      task_node_revision_id TEXT NOT NULL REFERENCES task_node_revisions(id) ON DELETE RESTRICT,
      attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
      status TEXT NOT NULL CHECK(status IN ('running', 'verifying', 'succeeded', 'failed', 'blocked', 'aborted')),
      started_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(task_node_revision_id, attempt_number)
    );
    CREATE UNIQUE INDEX one_active_attempt_per_task_node
      ON execution_attempts(task_node_id)
      WHERE status IN ('running', 'verifying');
    CREATE INDEX execution_attempts_node_history_idx
      ON execution_attempts(task_node_id, attempt_number DESC);

    CREATE TABLE execution_attempt_evidence (
      attempt_id TEXT NOT NULL REFERENCES execution_attempts(id) ON DELETE CASCADE,
      required_evidence_key TEXT NOT NULL,
      trace_event_id TEXT NOT NULL REFERENCES trace_events(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(attempt_id, required_evidence_key, trace_event_id)
    );

    CREATE TABLE evaluations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      task_node_id TEXT NOT NULL REFERENCES task_nodes(id) ON DELETE CASCADE,
      task_node_revision_id TEXT NOT NULL REFERENCES task_node_revisions(id) ON DELETE RESTRICT,
      execution_attempt_id TEXT NOT NULL REFERENCES execution_attempts(id) ON DELETE RESTRICT,
      verdict TEXT NOT NULL CHECK(verdict IN ('succeeded', 'failed', 'blocked', 'uncertain')),
      evidence_refs_json TEXT NOT NULL,
      covered_required_evidence_json TEXT NOT NULL,
      missing_required_evidence_json TEXT NOT NULL,
      risk_summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX evaluations_node_history_idx
      ON evaluations(task_node_id, created_at DESC, id DESC);

    CREATE TABLE lifecycle_transition_records (
      id TEXT PRIMARY KEY,
      evaluation_id TEXT NOT NULL REFERENCES evaluations(id) ON DELETE RESTRICT,
      task_node_id TEXT NOT NULL REFERENCES task_nodes(id) ON DELETE CASCADE,
      policy_version TEXT NOT NULL,
      from_status TEXT NOT NULL,
      target_status TEXT NOT NULL,
      applied INTEGER NOT NULL CHECK(applied IN (0, 1)),
      rejection_code TEXT,
      created_at TEXT NOT NULL
    );
  `,
}, {
  version: 3,
  sql: `
    ALTER TABLE plan_readiness_results
      ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'tree' CHECK(scope_kind IN ('tree', 'branch'));
    ALTER TABLE plan_readiness_results ADD COLUMN scope_root_node_id TEXT;

    ALTER TABLE runtime_confirmation_prompts
      ADD COLUMN tree_revision_id TEXT REFERENCES task_tree_revisions(id) ON DELETE RESTRICT;
    ALTER TABLE runtime_confirmation_prompts
      ADD COLUMN readiness_result_id TEXT REFERENCES plan_readiness_results(id) ON DELETE RESTRICT;
    ALTER TABLE runtime_confirmation_prompts
      ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'tree' CHECK(scope_kind IN ('tree', 'branch'));
    ALTER TABLE runtime_confirmation_prompts ADD COLUMN scope_root_node_id TEXT;

    CREATE TABLE scope_confirmation_records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      tree_revision_id TEXT NOT NULL REFERENCES task_tree_revisions(id) ON DELETE RESTRICT,
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('tree', 'branch')),
      scope_root_node_id TEXT,
      covered_node_ids_json TEXT NOT NULL,
      confirmation_prompt_id TEXT NOT NULL UNIQUE REFERENCES runtime_confirmation_prompts(id) ON DELETE RESTRICT,
      answer_trace_event_id TEXT NOT NULL REFERENCES trace_events(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      CHECK((scope_kind = 'tree' AND scope_root_node_id IS NULL) OR (scope_kind = 'branch' AND scope_root_node_id IS NOT NULL))
    );
    CREATE INDEX scope_confirmation_tree_revision_idx
      ON scope_confirmation_records(tree_id, tree_revision_id, created_at DESC);

    CREATE TABLE task_node_confirmation_states (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      tree_revision_id TEXT NOT NULL REFERENCES task_tree_revisions(id) ON DELETE CASCADE,
      task_node_id TEXT NOT NULL REFERENCES task_nodes(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('draft', 'pending_user_confirmation', 'confirmed', 'partial_confirmed')),
      source_confirmation_id TEXT REFERENCES scope_confirmation_records(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(tree_revision_id, task_node_id)
    );
    CREATE INDEX task_node_confirmation_current_idx
      ON task_node_confirmation_states(project_id, tree_id, tree_revision_id, state);

    INSERT INTO task_node_confirmation_states (
      project_id, tree_id, tree_revision_id, task_node_id, state, source_confirmation_id, updated_at
    )
    SELECT t.project_id, t.id, t.current_revision_id, n.id,
           CASE WHEN t.status = 'confirmed' THEN 'confirmed' ELSE 'draft' END,
           NULL, t.updated_at
    FROM task_trees t
    JOIN task_nodes n ON n.tree_id = t.id
    WHERE t.current_revision_id IS NOT NULL;
  `,
}];
