export const workflowStages = [
  "intake",
  "task_affiliation_confirmation",
  "draft_task_tree",
  "task_tree_refinement",
  "branch_confirmation",
  "skeleton_pass",
  "skeleton_gate",
  "branch_implementation",
  "branch_verification",
  "root_verification",
  "final_report",
] as const;

export type WorkflowStage = (typeof workflowStages)[number];

export function canTransitionWorkflow(
  from: WorkflowStage,
  to: WorkflowStage,
  evidence: { confirmationId?: string; skeletonGateEvidenceId?: string } = {},
): { ok: true } | { ok: false; code: "workflow_transition_rejected"; reason: string } {
  if (workflowStages.indexOf(to) !== workflowStages.indexOf(from) + 1) {
    return { ok: false, code: "workflow_transition_rejected", reason: "workflow stages cannot be skipped" };
  }
  if (from === "branch_confirmation" && !evidence.confirmationId) {
    return { ok: false, code: "workflow_transition_rejected", reason: "scope confirmation is required" };
  }
  if (from === "skeleton_gate" && !evidence.skeletonGateEvidenceId) {
    return { ok: false, code: "workflow_transition_rejected", reason: "skeleton gate evidence is required" };
  }
  return { ok: true };
}
