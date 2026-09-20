export type HarnessErrorCode =
  | "invalid_input"
  | "project_identity_conflict"
  | "project_not_registered"
  | "not_found"
  | "revision_conflict"
  | "invalid_tree_structure"
  | "leaf_contract_invalid"
  | "relation_artifact_required"
  | "workflow_transition_rejected"
  | "attempt_already_active"
  | "attempt_not_executable"
  | "attempt_state_conflict"
  | "evidence_not_found"
  | "evidence_scope_mismatch"
  | "evaluation_not_applicable"
  | "runtime_action_rejected"
  | "confirmation_not_applicable"
  | "failure_case_invalid"
  | "reproduction_validation_rejected"
  | "evolution_not_eligible"
  | "skill_candidate_invalid"
  | "skill_test_invalid"
  | "skill_validation_rejected"
  | "database_busy"
  | "storage_failure";

export class HarnessError extends Error {
  constructor(readonly code: HarnessErrorCode, message: string, readonly details?: unknown) {
    super(message);
    this.name = "HarnessError";
  }
}
