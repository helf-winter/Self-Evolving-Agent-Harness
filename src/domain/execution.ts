export type TaskNodeExecutionStatus =
  | "draft"
  | "pending_user_confirmation"
  | "ready"
  | "running"
  | "verifying"
  | "succeeded"
  | "failed"
  | "blocked"
  | "needs_revalidation"
  | "cancelled";

export type ExecutionAttemptStatus = "running" | "verifying" | "succeeded" | "failed" | "blocked" | "aborted";
export type EvaluationVerdict = "succeeded" | "failed" | "blocked" | "uncertain";

export const LIFECYCLE_POLICY_VERSION = "task-node-lifecycle/v1" as const;

export interface LifecycleTransitionInput {
  currentRevision: boolean;
  fromStatus: TaskNodeExecutionStatus;
  verdict: EvaluationVerdict;
  evidenceComplete: boolean;
  dependenciesSucceeded: boolean;
  childrenSucceeded: boolean;
}

export interface LifecycleTransitionDecision {
  policyVersion: typeof LIFECYCLE_POLICY_VERSION;
  applied: boolean;
  targetStatus: TaskNodeExecutionStatus;
  rejectionCode:
    | "stale_revision"
    | "invalid_from_status"
    | "missing_required_evidence"
    | "dependencies_incomplete"
    | "children_incomplete"
    | "evaluation_uncertain"
    | null;
}

export function decideLifecycleTransition(input: LifecycleTransitionInput): LifecycleTransitionDecision {
  const base = { policyVersion: LIFECYCLE_POLICY_VERSION, applied: false } as const;
  if (!input.currentRevision) {
    return { ...base, targetStatus: "needs_revalidation", rejectionCode: "stale_revision" };
  }
  if (input.fromStatus !== "verifying") {
    return { ...base, targetStatus: input.fromStatus, rejectionCode: "invalid_from_status" };
  }
  if (input.verdict === "uncertain") {
    return { ...base, targetStatus: "verifying", rejectionCode: "evaluation_uncertain" };
  }
  if (input.verdict === "failed" || input.verdict === "blocked") {
    return { policyVersion: LIFECYCLE_POLICY_VERSION, applied: true, targetStatus: input.verdict, rejectionCode: null };
  }
  if (!input.evidenceComplete) {
    return { ...base, targetStatus: "verifying", rejectionCode: "missing_required_evidence" };
  }
  if (!input.dependenciesSucceeded) {
    return { ...base, targetStatus: "verifying", rejectionCode: "dependencies_incomplete" };
  }
  if (!input.childrenSucceeded) {
    return { ...base, targetStatus: "verifying", rejectionCode: "children_incomplete" };
  }
  return { policyVersion: LIFECYCLE_POLICY_VERSION, applied: true, targetStatus: "succeeded", rejectionCode: null };
}
