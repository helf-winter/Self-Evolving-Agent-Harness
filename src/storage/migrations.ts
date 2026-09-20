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
}, {
  version: 4,
  sql: `
    ALTER TABLE artifacts ADD COLUMN granularity TEXT NOT NULL DEFAULT 'structural'
      CHECK(granularity IN ('structural', 'contract', 'symbol'));
    ALTER TABLE artifacts ADD COLUMN artifact_type TEXT NOT NULL DEFAULT 'file';
    ALTER TABLE artifacts ADD COLUMN path_or_name TEXT;
    ALTER TABLE artifacts ADD COLUMN parent_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL;
    ALTER TABLE artifacts ADD COLUMN identity_strategy TEXT NOT NULL DEFAULT 'path';
    ALTER TABLE artifacts ADD COLUMN confidence TEXT NOT NULL DEFAULT 'observed'
      CHECK(confidence IN ('planned', 'observed', 'verified'));
    ALTER TABLE artifacts ADD COLUMN planned_by_task_node_id TEXT REFERENCES task_nodes(id) ON DELETE SET NULL;
    ALTER TABLE artifacts ADD COLUMN plan_baseline_at TEXT;
    ALTER TABLE artifacts ADD COLUMN current_hash_or_version TEXT;
    ALTER TABLE artifacts ADD COLUMN source_trace_event_id TEXT REFERENCES trace_events(id) ON DELETE SET NULL;
    ALTER TABLE artifacts ADD COLUMN source_planning_revision_id TEXT REFERENCES task_tree_revisions(id) ON DELETE SET NULL;

    UPDATE artifacts SET
      granularity = CASE kind WHEN 'contract' THEN 'contract' WHEN 'symbol' THEN 'symbol' ELSE 'structural' END,
      artifact_type = kind,
      path_or_name = locator,
      identity_strategy = CASE kind WHEN 'contract' THEN 'logical_contract_id' WHEN 'symbol' THEN 'qualified_symbol' WHEN 'command' THEN 'command_signature' ELSE 'path' END,
      confidence = CASE WHEN status IN ('draft', 'planned') THEN 'planned' WHEN status = 'verified' THEN 'verified' ELSE 'observed' END;

    CREATE TABLE task_node_artifact_links (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      tree_revision_id TEXT NOT NULL REFERENCES task_tree_revisions(id) ON DELETE CASCADE,
      task_node_id TEXT NOT NULL REFERENCES task_nodes(id) ON DELETE CASCADE,
      task_node_revision_id TEXT NOT NULL REFERENCES task_node_revisions(id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL CHECK(relation_type IN ('plans', 'implements', 'consumes', 'creates', 'modifies', 'reads', 'deletes', 'verifies')),
      source_planning_revision_id TEXT NOT NULL REFERENCES task_tree_revisions(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      UNIQUE(tree_revision_id, task_node_id, artifact_id, relation_type)
    );
    CREATE INDEX task_artifact_node_idx ON task_node_artifact_links(task_node_id, tree_revision_id, relation_type);
    CREATE INDEX task_artifact_artifact_idx ON task_node_artifact_links(artifact_id, tree_revision_id, relation_type);

    CREATE TABLE artifact_graph_relations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT REFERENCES task_trees(id) ON DELETE CASCADE,
      tree_revision_id TEXT REFERENCES task_tree_revisions(id) ON DELETE CASCADE,
      from_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      to_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      source_trace_event_id TEXT REFERENCES trace_events(id) ON DELETE SET NULL,
      source_planning_revision_id TEXT REFERENCES task_tree_revisions(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      UNIQUE(tree_revision_id, from_artifact_id, to_artifact_id, kind)
    );

    CREATE TABLE artifact_contracts (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      tree_revision_id TEXT NOT NULL REFERENCES task_tree_revisions(id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      contract_name TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      compatibility_policy TEXT NOT NULL CHECK(compatibility_policy IN ('exact', 'backward_compatible', 'custom_validation')),
      schema_or_signature TEXT NOT NULL,
      provider_revision_ids_json TEXT NOT NULL,
      consumer_revision_ids_json TEXT NOT NULL,
      validation_refs_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(contract_id, tree_revision_id)
    );
    CREATE INDEX artifact_contract_carrier_idx ON artifact_contracts(artifact_id, tree_revision_id);

    CREATE TABLE plan_drift_records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      task_node_id TEXT REFERENCES task_nodes(id) ON DELETE SET NULL,
      planned_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
      actual_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
      drift_type TEXT NOT NULL CHECK(drift_type IN ('missing_planned_artifact', 'unexpected_artifact', 'artifact_replaced', 'responsibility_changed', 'relation_changed')),
      severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'blocking')),
      trace_event_id TEXT NOT NULL UNIQUE REFERENCES trace_events(id) ON DELETE RESTRICT,
      drift_explanation TEXT NOT NULL,
      agent_recommendation TEXT,
      resolution_status TEXT NOT NULL CHECK(resolution_status IN ('pending_user_confirmation', 'accepted', 'rejected', 'branch_cancelled', 'recorded')),
      user_decision TEXT,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX plan_drift_scope_idx ON plan_drift_records(project_id, tree_id, task_node_id, severity, resolution_status);
  `,
}, {
  version: 5,
  sql: `
    ALTER TABLE runtime_actions ADD COLUMN action_type TEXT;
    ALTER TABLE runtime_actions ADD COLUMN target_type TEXT;
    ALTER TABLE runtime_actions ADD COLUMN target_id TEXT;
    ALTER TABLE runtime_actions ADD COLUMN expected_revision TEXT;
    ALTER TABLE runtime_actions ADD COLUMN reason TEXT;
    ALTER TABLE runtime_actions ADD COLUMN source_message_ref TEXT;
    ALTER TABLE runtime_actions ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'low'
      CHECK(risk_level IN ('low', 'medium', 'high', 'irreversible'));
    ALTER TABLE runtime_actions ADD COLUMN confirmation_requirement TEXT NOT NULL DEFAULT 'none'
      CHECK(confirmation_requirement IN ('none', 'required', 'ambiguous'));
    ALTER TABLE runtime_actions ADD COLUMN confirmation_prompt_id TEXT;
    ALTER TABLE runtime_actions ADD COLUMN status TEXT NOT NULL DEFAULT 'proposed'
      CHECK(status IN ('proposed', 'validated', 'pending_confirmation', 'committed', 'rejected', 'revision_conflict'));
    ALTER TABLE runtime_actions ADD COLUMN committed_at TEXT;

    UPDATE runtime_actions SET
      action_type = kind,
      status = 'committed',
      committed_at = created_at
    WHERE action_type IS NULL;

    ALTER TABLE runtime_confirmation_prompts ADD COLUMN prompt_type TEXT NOT NULL DEFAULT 'branch_confirmation'
      CHECK(prompt_type IN ('branch_confirmation', 'drift_resolution', 'change_confirmation', 'high_risk_action'));
    ALTER TABLE runtime_confirmation_prompts ADD COLUMN related_task_node_id TEXT REFERENCES task_nodes(id) ON DELETE SET NULL;
    ALTER TABLE runtime_confirmation_prompts ADD COLUMN related_artifact_ids_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE runtime_confirmation_prompts ADD COLUMN options_json TEXT NOT NULL DEFAULT '["yes","no"]';
    ALTER TABLE runtime_confirmation_prompts ADD COLUMN runtime_action_id TEXT REFERENCES runtime_actions(id) ON DELETE SET NULL;
    CREATE UNIQUE INDEX runtime_confirmation_action_idx
      ON runtime_confirmation_prompts(runtime_action_id) WHERE runtime_action_id IS NOT NULL;

    CREATE TABLE user_change_requests (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      task_node_id TEXT REFERENCES task_nodes(id) ON DELETE SET NULL,
      change_type TEXT NOT NULL CHECK(change_type IN ('minor_change', 'scope_change', 'priority_change')),
      source_trace_event_id TEXT NOT NULL REFERENCES trace_events(id) ON DELETE RESTRICT,
      expected_tree_revision_id TEXT NOT NULL REFERENCES task_tree_revisions(id) ON DELETE RESTRICT,
      summary TEXT NOT NULL,
      change_impact_json TEXT NOT NULL,
      proposed_document_json TEXT,
      priority_target_node_id TEXT REFERENCES task_nodes(id) ON DELETE SET NULL,
      prior_node_status TEXT,
      status TEXT NOT NULL CHECK(status IN ('proposed', 'pending_confirmation', 'paused', 'applied', 'rejected', 'revision_conflict')),
      runtime_action_id TEXT NOT NULL UNIQUE REFERENCES runtime_actions(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX user_change_scope_idx
      ON user_change_requests(project_id, tree_id, task_node_id, change_type, status, created_at DESC);
  `,
}, {
  version: 6,
  sql: `
    CREATE TABLE failure_cases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      source_task_node_id TEXT REFERENCES task_nodes(id) ON DELETE SET NULL,
      source_execution_attempt_id TEXT NOT NULL REFERENCES execution_attempts(id) ON DELETE RESTRICT,
      source_evaluation_id TEXT NOT NULL REFERENCES evaluations(id) ON DELETE RESTRICT,
      failure_goal TEXT NOT NULL,
      failure_signature TEXT NOT NULL,
      maturity_level TEXT NOT NULL CHECK(maturity_level IN ('L0_observed', 'L1_manual', 'L2_assisted', 'L3_automated', 'L4_regression')),
      availability_status TEXT NOT NULL CHECK(availability_status IN ('active', 'flaky', 'environment_blocked', 'quarantined', 'obsolete')),
      current_reproduction_revision_id TEXT,
      related_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, failure_signature)
    );
    CREATE INDEX failure_case_scope_idx
      ON failure_cases(project_id, tree_id, source_task_node_id, maturity_level, availability_status, updated_at DESC);

    CREATE TABLE failure_case_occurrences (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      failure_case_id TEXT NOT NULL REFERENCES failure_cases(id) ON DELETE CASCADE,
      execution_attempt_id TEXT NOT NULL REFERENCES execution_attempts(id) ON DELETE RESTRICT,
      evaluation_id TEXT NOT NULL REFERENCES evaluations(id) ON DELETE RESTRICT,
      evidence_refs_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, evaluation_id)
    );
    CREATE INDEX failure_occurrence_case_idx ON failure_case_occurrences(failure_case_id, created_at DESC);

    CREATE TABLE failure_reproduction_revisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      failure_case_id TEXT NOT NULL REFERENCES failure_cases(id) ON DELETE CASCADE,
      revision_number INTEGER NOT NULL CHECK(revision_number > 0),
      reproduction_mode TEXT NOT NULL CHECK(reproduction_mode IN ('observed', 'manual', 'assisted', 'automated')),
      contract_json TEXT NOT NULL,
      validation_status TEXT NOT NULL CHECK(validation_status IN ('draft', 'verified_manual', 'verified_assisted', 'verified_automated', 'rejected', 'stale')),
      created_at TEXT NOT NULL,
      UNIQUE(failure_case_id, revision_number)
    );
    CREATE INDEX failure_reproduction_case_idx ON failure_reproduction_revisions(failure_case_id, revision_number DESC);

    CREATE TABLE reproduction_validation_results (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      failure_case_id TEXT NOT NULL REFERENCES failure_cases(id) ON DELETE CASCADE,
      reproduction_revision_id TEXT NOT NULL REFERENCES failure_reproduction_revisions(id) ON DELETE RESTRICT,
      observation_json TEXT NOT NULL,
      pre_fix_verdict TEXT NOT NULL CHECK(pre_fix_verdict IN ('red', 'not_red', 'not_run')),
      post_fix_verdict TEXT NOT NULL CHECK(post_fix_verdict IN ('green', 'not_green', 'not_run')),
      oracle_discrimination_verdict TEXT NOT NULL CHECK(oracle_discrimination_verdict IN ('pass', 'fail', 'not_run')),
      repeat_stability_verdict TEXT NOT NULL CHECK(repeat_stability_verdict IN ('pass', 'fail', 'not_run')),
      isolation_verdict TEXT NOT NULL CHECK(isolation_verdict IN ('pass', 'fail', 'not_run')),
      evidence_refs_json TEXT NOT NULL,
      maturity_promotion_verdict TEXT NOT NULL CHECK(maturity_promotion_verdict IN ('L0_observed', 'L1_manual', 'L2_assisted', 'L3_automated', 'L4_regression')),
      rejection_reasons_json TEXT NOT NULL DEFAULT '[]',
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX reproduction_validation_revision_idx
      ON reproduction_validation_results(reproduction_revision_id, created_at DESC);
  `,
}, {
  version: 7,
  sql: `
    CREATE TABLE experiences (
      id TEXT PRIMARY KEY,
      source_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      source_tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE RESTRICT,
      source_task_node_id TEXT NOT NULL REFERENCES task_nodes(id) ON DELETE RESTRICT,
      source_task_node_revision_id TEXT NOT NULL REFERENCES task_node_revisions(id) ON DELETE RESTRICT,
      source_success_attempt_id TEXT NOT NULL REFERENCES execution_attempts(id) ON DELETE RESTRICT,
      source_success_evaluation_id TEXT NOT NULL UNIQUE REFERENCES evaluations(id) ON DELETE RESTRICT,
      source_failure_attempt_ids_json TEXT NOT NULL,
      source_failure_evaluation_ids_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      applicable_context_json TEXT NOT NULL,
      verification_json TEXT NOT NULL,
      related_artifact_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX experience_source_idx ON experiences(source_project_id, source_tree_id, source_task_node_id, created_at DESC);

    CREATE TABLE skills (
      id TEXT PRIMARY KEY,
      stable_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      trigger_context_json TEXT NOT NULL,
      current_candidate_revision_id TEXT,
      validation_status TEXT NOT NULL CHECK(validation_status IN ('draft', 'frozen', 'validating', 'passed', 'failed', 'promoted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      promoted_at TEXT
    );

    CREATE TABLE skill_candidate_revisions (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      revision_number INTEGER NOT NULL CHECK(revision_number > 0),
      source_experience_ids_json TEXT NOT NULL,
      instruction_snapshot TEXT NOT NULL,
      frozen_at TEXT NOT NULL,
      validation_status TEXT NOT NULL CHECK(validation_status IN ('frozen', 'validating', 'passed', 'failed', 'promoted')),
      UNIQUE(skill_id, revision_number)
    );
    CREATE INDEX skill_candidate_skill_idx ON skill_candidate_revisions(skill_id, revision_number DESC);

    CREATE TABLE skill_test_cases (
      id TEXT PRIMARY KEY,
      skill_candidate_revision_id TEXT NOT NULL REFERENCES skill_candidate_revisions(id) ON DELETE CASCADE,
      test_type TEXT NOT NULL CHECK(test_type IN ('real_failure_replay', 'variation', 'holdout', 'negative_applicability')),
      source_refs_json TEXT NOT NULL,
      target_behavior TEXT NOT NULL,
      applicable_context_json TEXT NOT NULL,
      fixture_setup_json TEXT NOT NULL,
      input_json TEXT NOT NULL,
      expected_result_json TEXT NOT NULL,
      oracle_json TEXT NOT NULL,
      reproduction_command TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL CHECK(timeout_ms > 0),
      generated_by TEXT NOT NULL,
      quality_status TEXT NOT NULL CHECK(quality_status IN ('draft', 'schema_valid', 'reproducible', 'discriminative', 'stable', 'accepted', 'rejected')),
      leakage_policy TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX skill_test_candidate_idx ON skill_test_cases(skill_candidate_revision_id, test_type, quality_status, created_at DESC);

    CREATE TABLE skill_test_quality_results (
      id TEXT PRIMARY KEY,
      skill_test_case_id TEXT NOT NULL REFERENCES skill_test_cases(id) ON DELETE CASCADE,
      schema_valid INTEGER NOT NULL CHECK(schema_valid IN (0, 1)),
      fixture_isolated INTEGER NOT NULL CHECK(fixture_isolated IN (0, 1)),
      failure_reproduced INTEGER NOT NULL CHECK(failure_reproduced IN (0, 1)),
      oracle_valid INTEGER NOT NULL CHECK(oracle_valid IN (0, 1)),
      discriminative INTEGER NOT NULL CHECK(discriminative IN (0, 1)),
      stable INTEGER NOT NULL CHECK(stable IN (0, 1)),
      split_valid INTEGER NOT NULL CHECK(split_valid IN (0, 1)),
      evidence_refs_json TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK(verdict IN ('accepted', 'rejected')),
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX skill_quality_case_idx ON skill_test_quality_results(skill_test_case_id, created_at DESC);

    CREATE TABLE skill_validation_runs (
      id TEXT PRIMARY KEY,
      skill_candidate_revision_id TEXT NOT NULL REFERENCES skill_candidate_revisions(id) ON DELETE CASCADE,
      skill_test_case_id TEXT NOT NULL REFERENCES skill_test_cases(id) ON DELETE CASCADE,
      run_mode TEXT NOT NULL CHECK(run_mode IN ('no_skill_baseline', 'skill_enabled')),
      repetition_index INTEGER NOT NULL CHECK(repetition_index > 0),
      verdict TEXT NOT NULL CHECK(verdict IN ('passed', 'failed', 'blocked', 'invalid')),
      token_usage INTEGER CHECK(token_usage IS NULL OR token_usage >= 0),
      tool_call_count INTEGER CHECK(tool_call_count IS NULL OR tool_call_count >= 0),
      side_effect_risk TEXT NOT NULL CHECK(side_effect_risk IN ('none', 'low', 'medium', 'high', 'irreversible')),
      side_effect_summary TEXT NOT NULL,
      evidence_refs_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(skill_candidate_revision_id, skill_test_case_id, run_mode, repetition_index)
    );
    CREATE INDEX skill_run_candidate_idx ON skill_validation_runs(skill_candidate_revision_id, skill_test_case_id, run_mode, repetition_index);

    CREATE TABLE skill_validation_reports (
      id TEXT PRIMARY KEY,
      skill_candidate_revision_id TEXT NOT NULL REFERENCES skill_candidate_revisions(id) ON DELETE CASCADE,
      baseline_summary_json TEXT NOT NULL,
      enabled_summary_json TEXT NOT NULL,
      replay_result_json TEXT NOT NULL,
      holdout_result_json TEXT NOT NULL,
      negative_applicability_result_json TEXT NOT NULL,
      stability_result_json TEXT NOT NULL,
      risk_summary_json TEXT NOT NULL,
      promotion_verdict TEXT NOT NULL CHECK(promotion_verdict IN ('pass', 'fail', 'uncertain')),
      rejection_reasons_json TEXT NOT NULL,
      evidence_refs_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX skill_report_candidate_idx ON skill_validation_reports(skill_candidate_revision_id, created_at DESC);
  `,
}, {
  version: 8,
  sql: `
    CREATE TABLE task_node_candidate_revisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      task_node_id TEXT NOT NULL REFERENCES task_nodes(id) ON DELETE CASCADE,
      base_tree_revision_id TEXT NOT NULL REFERENCES task_tree_revisions(id) ON DELETE RESTRICT,
      base_node_revision_id TEXT NOT NULL REFERENCES task_node_revisions(id) ON DELETE RESTRICT,
      body_json TEXT NOT NULL,
      provides_contract_ids_json TEXT NOT NULL,
      requires_contract_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX replacement_candidate_node_idx
      ON task_node_candidate_revisions(project_id, tree_id, task_node_id, created_at DESC);

    CREATE TABLE task_node_revision_contract_bindings (
      task_node_revision_id TEXT PRIMARY KEY REFERENCES task_node_revisions(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      task_node_id TEXT NOT NULL REFERENCES task_nodes(id) ON DELETE CASCADE,
      provides_contract_ids_json TEXT NOT NULL,
      requires_contract_ids_json TEXT NOT NULL,
      source_candidate_revision_id TEXT REFERENCES task_node_candidate_revisions(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE task_node_composition_states (
      task_node_id TEXT PRIMARY KEY REFERENCES task_nodes(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      active_revision_id TEXT NOT NULL REFERENCES task_node_revisions(id) ON DELETE RESTRICT,
      composition_state TEXT NOT NULL CHECK(composition_state IN (
        'pending_dependency', 'active', 'suspending', 'replacing', 'needs_replanning', 'disposed'
      )),
      replacement_id TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX composition_state_scope_idx
      ON task_node_composition_states(project_id, tree_id, composition_state);

    CREATE TABLE task_node_composition_transitions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      task_node_id TEXT NOT NULL REFERENCES task_nodes(id) ON DELETE CASCADE,
      task_node_revision_id TEXT NOT NULL REFERENCES task_node_revisions(id) ON DELETE RESTRICT,
      from_state TEXT CHECK(from_state IS NULL OR from_state IN (
        'pending_dependency', 'active', 'suspending', 'replacing', 'needs_replanning', 'disposed'
      )),
      to_state TEXT NOT NULL CHECK(to_state IN (
        'pending_dependency', 'active', 'suspending', 'replacing', 'needs_replanning', 'disposed'
      )),
      reason TEXT NOT NULL,
      replacement_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX composition_transition_node_idx
      ON task_node_composition_transitions(task_node_id, created_at DESC);

    CREATE TABLE task_node_effects (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      task_node_id TEXT NOT NULL REFERENCES task_nodes(id) ON DELETE CASCADE,
      owner_revision_id TEXT NOT NULL REFERENCES task_node_revisions(id) ON DELETE RESTRICT,
      effect_type TEXT NOT NULL CHECK(effect_type IN ('reversible', 'version_reversible', 'compensatable', 'irreversible')),
      target_ref TEXT NOT NULL,
      operation TEXT NOT NULL,
      baseline_ref TEXT,
      inverse_operation TEXT,
      compensation_operation TEXT,
      evidence_refs_json TEXT NOT NULL,
      disposal_status TEXT NOT NULL CHECK(disposal_status IN (
        'active', 'disposed', 'compensated', 'conflict', 'manual_resolution', 'not_disposable'
      )),
      created_at TEXT NOT NULL,
      disposed_at TEXT
    );
    CREATE INDEX task_node_effect_owner_idx
      ON task_node_effects(project_id, tree_id, owner_revision_id, disposal_status);
    CREATE INDEX task_node_effect_target_idx
      ON task_node_effects(project_id, target_ref, disposal_status);

    CREATE TABLE task_node_replacement_records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      task_node_id TEXT NOT NULL REFERENCES task_nodes(id) ON DELETE CASCADE,
      old_revision_id TEXT NOT NULL REFERENCES task_node_revisions(id) ON DELETE RESTRICT,
      candidate_revision_id TEXT NOT NULL UNIQUE REFERENCES task_node_candidate_revisions(id) ON DELETE RESTRICT,
      expected_tree_revision_id TEXT NOT NULL REFERENCES task_tree_revisions(id) ON DELETE RESTRICT,
      affected_task_node_ids_json TEXT NOT NULL,
      suspension_order_json TEXT NOT NULL,
      contract_diff_json TEXT NOT NULL,
      effect_risk_summary_json TEXT NOT NULL,
      prior_execution_statuses_json TEXT NOT NULL DEFAULT '{}',
      user_confirmation_ref TEXT REFERENCES runtime_confirmation_prompts(id) ON DELETE SET NULL,
      runtime_action_id TEXT UNIQUE REFERENCES runtime_actions(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK(status IN (
        'pending_confirmation', 'suspending', 'disposing', 'activating',
        'completed', 'rolled_back', 'replacement_failed'
      )),
      disposal_result_refs_json TEXT NOT NULL,
      recovery_result_json TEXT,
      trace_event_ids_json TEXT NOT NULL,
      activated_tree_revision_id TEXT REFERENCES task_tree_revisions(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX replacement_scope_idx
      ON task_node_replacement_records(project_id, tree_id, task_node_id, status, created_at DESC);

    CREATE TABLE effect_disposal_results (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      replacement_id TEXT NOT NULL REFERENCES task_node_replacement_records(id) ON DELETE CASCADE,
      task_node_effect_id TEXT NOT NULL REFERENCES task_node_effects(id) ON DELETE RESTRICT,
      disposition_action TEXT NOT NULL CHECK(disposition_action IN ('inverse_applied', 'compensation_applied', 'retain')),
      disposal_capability TEXT NOT NULL CHECK(disposal_capability IN (
        'auto_reversible', 'requires_baseline_check', 'compensation_only', 'manual_confirmation_required'
      )),
      disposal_status TEXT NOT NULL CHECK(disposal_status IN (
        'disposed', 'compensated', 'conflict', 'manual_resolution', 'not_disposable'
      )),
      observed_baseline_ref TEXT,
      evidence_refs_json TEXT NOT NULL,
      residual_impact TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX effect_disposal_replacement_idx
      ON effect_disposal_results(replacement_id, created_at);
  `,
}, {
  version: 9,
  sql: `
    ALTER TABLE projects ADD COLUMN identity_token TEXT;
    ALTER TABLE projects ADD COLUMN display_path TEXT;
    ALTER TABLE projects ADD COLUMN display_name TEXT;
    ALTER TABLE projects ADD COLUMN platform TEXT;
    ALTER TABLE projects ADD COLUMN cloned_from_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
    ALTER TABLE projects ADD COLUMN cloned_at TEXT;
    CREATE UNIQUE INDEX project_identity_token_unique
      ON projects(identity_token) WHERE identity_token IS NOT NULL;
    CREATE INDEX project_clone_source_idx ON projects(cloned_from_project_id, cloned_at);

    ALTER TABLE project_path_aliases ADD COLUMN observed_path TEXT;
    ALTER TABLE project_path_aliases ADD COLUMN platform TEXT;
    ALTER TABLE project_path_aliases ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0, 1));
    UPDATE project_path_aliases
      SET observed_path = normalized_path,
          is_primary = CASE WHEN normalized_path = (
            SELECT canonical_path FROM projects WHERE projects.id = project_path_aliases.project_id
          ) THEN 1 ELSE 0 END;
    CREATE UNIQUE INDEX one_primary_project_path
      ON project_path_aliases(project_id) WHERE is_primary = 1;

    ALTER TABLE task_trees ADD COLUMN cloned_from_task_tree_id TEXT;
    CREATE INDEX task_tree_clone_source_idx ON task_trees(cloned_from_task_tree_id);

    CREATE TABLE project_clone_records (
      id TEXT PRIMARY KEY,
      source_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      target_project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      source_path TEXT NOT NULL,
      target_path TEXT NOT NULL,
      cloned_entity_counts_json TEXT NOT NULL,
      provenance_policy_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'cloning', 'completed', 'incomplete', 'failed', 'recovered')),
      error_summary TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX project_clone_history_idx
      ON project_clone_records(source_project_id, created_at DESC);

    CREATE TABLE project_clone_entity_maps (
      clone_id TEXT NOT NULL REFERENCES project_clone_records(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(clone_id, entity_type, source_entity_id),
      UNIQUE(clone_id, entity_type, target_entity_id)
    );
    CREATE INDEX project_clone_target_map_idx
      ON project_clone_entity_maps(clone_id, target_entity_id);

    CREATE TABLE project_clone_inherited_evidence (
      id TEXT PRIMARY KEY,
      clone_id TEXT NOT NULL REFERENCES project_clone_records(id) ON DELETE CASCADE,
      source_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      target_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('evaluation', 'completion_evidence', 'confirmation')),
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT,
      inheritance_status TEXT NOT NULL CHECK(inheritance_status IN ('inherited_from_clone', 'needs_revalidation', 'invalidated')),
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(clone_id, evidence_kind, source_entity_id, target_entity_id)
    );
    CREATE INDEX project_clone_evidence_target_idx
      ON project_clone_inherited_evidence(target_project_id, target_entity_id, created_at DESC);
  `,
}, {
  version: 10,
  sql: `
    CREATE TABLE runtime_plugins (
      id TEXT PRIMARY KEY,
      current_revision_id TEXT,
      composition_state TEXT NOT NULL CHECK(composition_state IN (
        'pending_dependency', 'active', 'suspending', 'replacing', 'needs_recovery', 'disposed'
      )),
      missing_requirements_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX runtime_plugin_state_idx ON runtime_plugins(composition_state, updated_at DESC);

    CREATE TABLE runtime_plugin_revisions (
      id TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL REFERENCES runtime_plugins(id) ON DELETE CASCADE,
      revision TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('candidate', 'active', 'suspended', 'replaced', 'failed', 'disposed')),
      created_at TEXT NOT NULL,
      UNIQUE(plugin_id, revision)
    );
    CREATE INDEX runtime_plugin_revision_history_idx ON runtime_plugin_revisions(plugin_id, created_at DESC);

    CREATE TABLE runtime_plugin_contracts (
      plugin_revision_id TEXT NOT NULL REFERENCES runtime_plugin_revisions(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK(direction IN ('provides', 'requires')),
      contract_id TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      PRIMARY KEY(plugin_revision_id, direction, contract_id, contract_version)
    );
    CREATE INDEX runtime_plugin_contract_lookup_idx
      ON runtime_plugin_contracts(direction, contract_id, contract_version, plugin_revision_id);

    CREATE TABLE runtime_plugin_registrations (
      id TEXT PRIMARY KEY,
      plugin_revision_id TEXT NOT NULL REFERENCES runtime_plugin_revisions(id) ON DELETE CASCADE,
      registration_key TEXT NOT NULL,
      registration_kind TEXT NOT NULL CHECK(registration_kind IN ('skill', 'workflow', 'hook', 'binding', 'runtime_extension')),
      target_ref TEXT NOT NULL,
      disposer_kind TEXT NOT NULL CHECK(disposer_kind IN ('unregister_callback', 'restart_required', 'manual')),
      disposer_ref TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('declared', 'active', 'disposed', 'retained', 'conflict')),
      created_at TEXT NOT NULL,
      disposed_at TEXT,
      UNIQUE(plugin_revision_id, registration_key)
    );
    CREATE INDEX runtime_plugin_registration_target_idx ON runtime_plugin_registrations(target_ref, status);

    CREATE TABLE runtime_plugin_effects (
      id TEXT PRIMARY KEY,
      plugin_revision_id TEXT NOT NULL REFERENCES runtime_plugin_revisions(id) ON DELETE CASCADE,
      effect_key TEXT NOT NULL,
      effect_type TEXT NOT NULL CHECK(effect_type IN ('reversible', 'version_reversible', 'compensatable', 'irreversible')),
      target_ref TEXT NOT NULL,
      operation TEXT NOT NULL,
      baseline_ref TEXT,
      inverse_operation TEXT,
      compensation_operation TEXT,
      evidence_refs_json TEXT NOT NULL,
      disposal_status TEXT NOT NULL CHECK(disposal_status IN (
        'pending', 'active', 'disposed', 'compensated', 'conflict', 'manual_resolution', 'not_disposable'
      )),
      created_at TEXT NOT NULL,
      disposed_at TEXT,
      UNIQUE(plugin_revision_id, effect_key)
    );
    CREATE INDEX runtime_plugin_effect_target_idx ON runtime_plugin_effects(target_ref, disposal_status);

    CREATE TABLE runtime_plugin_dependency_edges (
      id TEXT PRIMARY KEY,
      consumer_plugin_id TEXT NOT NULL REFERENCES runtime_plugins(id) ON DELETE CASCADE,
      consumer_revision_id TEXT NOT NULL REFERENCES runtime_plugin_revisions(id) ON DELETE CASCADE,
      provider_plugin_id TEXT NOT NULL REFERENCES runtime_plugins(id) ON DELETE CASCADE,
      provider_revision_id TEXT NOT NULL REFERENCES runtime_plugin_revisions(id) ON DELETE CASCADE,
      contract_id TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      active INTEGER NOT NULL CHECK(active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(consumer_revision_id, provider_revision_id, contract_id, contract_version)
    );
    CREATE INDEX runtime_plugin_dependency_consumer_idx
      ON runtime_plugin_dependency_edges(consumer_plugin_id, consumer_revision_id, active);
    CREATE INDEX runtime_plugin_dependency_provider_idx
      ON runtime_plugin_dependency_edges(provider_plugin_id, provider_revision_id, active);

    CREATE TABLE runtime_plugin_composition_transitions (
      id TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL REFERENCES runtime_plugins(id) ON DELETE CASCADE,
      plugin_revision_id TEXT REFERENCES runtime_plugin_revisions(id) ON DELETE SET NULL,
      from_state TEXT CHECK(from_state IS NULL OR from_state IN (
        'pending_dependency', 'active', 'suspending', 'replacing', 'needs_recovery', 'disposed'
      )),
      to_state TEXT NOT NULL CHECK(to_state IN (
        'pending_dependency', 'active', 'suspending', 'replacing', 'needs_recovery', 'disposed'
      )),
      reason TEXT NOT NULL,
      replacement_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX runtime_plugin_transition_history_idx
      ON runtime_plugin_composition_transitions(plugin_id, created_at DESC);

    CREATE TABLE runtime_plugin_replacement_records (
      id TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL REFERENCES runtime_plugins(id) ON DELETE CASCADE,
      old_revision_id TEXT NOT NULL REFERENCES runtime_plugin_revisions(id) ON DELETE RESTRICT,
      candidate_revision_id TEXT NOT NULL UNIQUE REFERENCES runtime_plugin_revisions(id) ON DELETE RESTRICT,
      contract_diff_json TEXT NOT NULL,
      affected_plugin_ids_json TEXT NOT NULL,
      suspension_order_json TEXT NOT NULL,
      effect_risk_summary_json TEXT NOT NULL,
      prior_plugin_states_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'previewed', 'disposing', 'activating', 'completed', 'rolled_back', 'replacement_failed'
      )),
      disposal_result_refs_json TEXT NOT NULL,
      activation_evidence_refs_json TEXT NOT NULL,
      recovery_result_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX runtime_plugin_replacement_history_idx
      ON runtime_plugin_replacement_records(plugin_id, created_at DESC);

    CREATE TABLE runtime_plugin_registration_disposals (
      id TEXT PRIMARY KEY,
      replacement_id TEXT REFERENCES runtime_plugin_replacement_records(id) ON DELETE CASCADE,
      plugin_registration_id TEXT NOT NULL REFERENCES runtime_plugin_registrations(id) ON DELETE RESTRICT,
      disposition_action TEXT NOT NULL CHECK(disposition_action IN ('disposed', 'retain')),
      disposal_status TEXT NOT NULL CHECK(disposal_status IN ('disposed', 'retained', 'manual_resolution')),
      evidence_refs_json TEXT NOT NULL,
      residual_impact TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX runtime_plugin_registration_disposal_idx
      ON runtime_plugin_registration_disposals(plugin_registration_id, created_at DESC);

    CREATE TABLE runtime_plugin_effect_disposals (
      id TEXT PRIMARY KEY,
      replacement_id TEXT REFERENCES runtime_plugin_replacement_records(id) ON DELETE CASCADE,
      plugin_effect_id TEXT NOT NULL REFERENCES runtime_plugin_effects(id) ON DELETE RESTRICT,
      disposition_action TEXT NOT NULL CHECK(disposition_action IN ('inverse_applied', 'compensation_applied', 'retain')),
      disposal_capability TEXT NOT NULL CHECK(disposal_capability IN (
        'auto_reversible', 'requires_baseline_check', 'compensation_only', 'manual_confirmation_required'
      )),
      disposal_status TEXT NOT NULL CHECK(disposal_status IN (
        'disposed', 'compensated', 'conflict', 'manual_resolution', 'not_disposable'
      )),
      observed_baseline_ref TEXT,
      evidence_refs_json TEXT NOT NULL,
      residual_impact TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX runtime_plugin_effect_disposal_idx
      ON runtime_plugin_effect_disposals(plugin_effect_id, created_at DESC);
  `,
}, {
  version: 11,
  sql: `
    CREATE TABLE draft_change_set_previews (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      base_revision_id TEXT NOT NULL REFERENCES task_tree_revisions(id) ON DELETE RESTRICT,
      proposed_document_hash TEXT NOT NULL,
      proposed_document_json TEXT NOT NULL,
      impact_json TEXT NOT NULL,
      apply_mode TEXT NOT NULL CHECK(apply_mode IN ('direct', 'preview_required')),
      status TEXT NOT NULL CHECK(status IN ('active', 'applied', 'stale', 'cancelled')),
      created_at TEXT NOT NULL,
      applied_at TEXT
    );
    CREATE INDEX draft_change_set_preview_scope_idx
      ON draft_change_set_previews(project_id, tree_id, base_revision_id, status, created_at DESC);

    ALTER TABLE draft_change_sets ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
    ALTER TABLE draft_change_sets ADD COLUMN result_revision_id TEXT REFERENCES task_tree_revisions(id) ON DELETE SET NULL;
    ALTER TABLE draft_change_sets ADD COLUMN source_message_trace_event_id TEXT REFERENCES trace_events(id) ON DELETE RESTRICT;
    ALTER TABLE draft_change_sets ADD COLUMN affected_node_ids_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE draft_change_sets ADD COLUMN affected_branch_ids_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE draft_change_sets ADD COLUMN affected_artifact_ids_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE draft_change_sets ADD COLUMN affected_relation_refs_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE draft_change_sets ADD COLUMN affected_contract_ids_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE draft_change_sets ADD COLUMN apply_mode TEXT NOT NULL DEFAULT 'direct'
      CHECK(apply_mode IN ('direct', 'preview_required'));
    ALTER TABLE draft_change_sets ADD COLUMN preview_id TEXT REFERENCES draft_change_set_previews(id) ON DELETE SET NULL;
    ALTER TABLE draft_change_sets ADD COLUMN planning_decision_id TEXT REFERENCES planning_decisions(id) ON DELETE SET NULL;
    ALTER TABLE draft_change_sets ADD COLUMN planning_trace_event_id TEXT REFERENCES trace_events(id) ON DELETE SET NULL;
    CREATE INDEX draft_change_set_scope_idx
      ON draft_change_sets(project_id, tree_id, created_at DESC);

    ALTER TABLE planning_decisions ADD COLUMN base_revision_id TEXT REFERENCES task_tree_revisions(id) ON DELETE SET NULL;
    ALTER TABLE planning_decisions ADD COLUMN result_revision_id TEXT REFERENCES task_tree_revisions(id) ON DELETE SET NULL;
    ALTER TABLE planning_decisions ADD COLUMN change_set_id TEXT REFERENCES draft_change_sets(id) ON DELETE SET NULL;
    ALTER TABLE planning_decisions ADD COLUMN discussion_topic TEXT;
    ALTER TABLE planning_decisions ADD COLUMN current_understanding TEXT;
    ALTER TABLE planning_decisions ADD COLUMN considered_options_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE planning_decisions ADD COLUMN agent_recommendation TEXT;
    ALTER TABLE planning_decisions ADD COLUMN user_decision TEXT;
    ALTER TABLE planning_decisions ADD COLUMN affected_refs_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE planning_decisions ADD COLUMN source_message_trace_event_id TEXT REFERENCES trace_events(id) ON DELETE SET NULL;
    CREATE INDEX planning_decision_history_idx
      ON planning_decisions(tree_id, created_at DESC);

    ALTER TABLE plan_readiness_results ADD COLUMN issues_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE plan_readiness_results ADD COLUMN warnings_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE plan_readiness_results ADD COLUMN recommended_issue_json TEXT;
    ALTER TABLE plan_readiness_results ADD COLUMN priority_policy_version TEXT NOT NULL DEFAULT 'refinement-priority-v1';

    ALTER TABLE skeleton_acceptance_criteria ADD COLUMN branch_task_node_id TEXT REFERENCES task_nodes(id) ON DELETE CASCADE;
    ALTER TABLE skeleton_acceptance_criteria ADD COLUMN criteria_json TEXT;
    ALTER TABLE skeleton_acceptance_criteria ADD COLUMN source_planning_revision_id TEXT REFERENCES task_tree_revisions(id) ON DELETE CASCADE;
    CREATE INDEX skeleton_acceptance_branch_idx
      ON skeleton_acceptance_criteria(tree_revision_id, branch_task_node_id);
  `,
}, {
  version: 12,
  sql: `
    ALTER TABLE trace_events ADD COLUMN execution_context_json TEXT NOT NULL DEFAULT '{}';
    CREATE INDEX trace_project_run_time_idx
      ON trace_events(project_id, session_id, occurred_at DESC, id DESC);
  `,
}, {
  version: 13,
  sql: `
    ALTER TABLE task_trees ADD COLUMN archived_at TEXT;
    ALTER TABLE task_trees ADD COLUMN archived_from_status TEXT;

    CREATE TABLE task_tree_collection_transitions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tree_id TEXT NOT NULL REFERENCES task_trees(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK(action IN ('selected', 'archived', 'restored')),
      from_status TEXT,
      to_status TEXT NOT NULL,
      previous_selected_tree_id TEXT REFERENCES task_trees(id) ON DELETE SET NULL,
      selected_tree_id TEXT REFERENCES task_trees(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX task_tree_collection_transition_history_idx
      ON task_tree_collection_transitions(project_id, tree_id, created_at DESC, id DESC);

    CREATE TRIGGER task_tree_collection_transitions_no_update
      BEFORE UPDATE ON task_tree_collection_transitions
      BEGIN SELECT RAISE(ABORT, 'task tree collection transitions are immutable'); END;
    CREATE TRIGGER task_tree_collection_transitions_no_delete
      BEFORE DELETE ON task_tree_collection_transitions
      BEGIN SELECT RAISE(ABORT, 'task tree collection transitions are immutable'); END;
  `,
}];
