export type SkeletonGateStatus = "passed" | "failed" | "uncertain";

export interface SkeletonGateCheck {
  ref: string;
  satisfied: boolean;
  evidenceRefs: string[];
}

export interface SkeletonGateBranchObservation {
  branchNodeId: string;
  criterionId: string | null;
  criterionComplete: boolean;
  skeletonNodeIds: string[];
  succeededAttemptIds: string[];
  expectedArtifacts: SkeletonGateCheck[];
  requiredContracts: SkeletonGateCheck[];
  verificationCommands: SkeletonGateCheck[];
  readinessConditions: SkeletonGateCheck[];
}

export interface SkeletonGateBlocker {
  code:
    | "no_confirmed_branch"
    | "criterion_missing_or_incomplete"
    | "skeleton_node_missing"
    | "skeleton_attempt_incomplete"
    | "expected_artifact_missing"
    | "required_contract_missing"
    | "verification_command_missing"
    | "readiness_evidence_missing"
    | "blocking_drift";
  ref: string;
}

export interface SkeletonGateEvaluation {
  status: SkeletonGateStatus;
  blockers: SkeletonGateBlocker[];
}

export function evaluateSkeletonGate(input: {
  structured: boolean;
  branches: SkeletonGateBranchObservation[];
  blockingDriftIds: string[];
}): SkeletonGateEvaluation {
  const blockers: SkeletonGateBlocker[] = [];
  if (!input.branches.length) blockers.push({ code: "no_confirmed_branch", ref: "task-tree" });
  for (const branch of input.branches) {
    if (input.structured && (!branch.criterionId || !branch.criterionComplete)) {
      blockers.push({ code: "criterion_missing_or_incomplete", ref: branch.branchNodeId });
    }
    if (!branch.skeletonNodeIds.length) blockers.push({ code: "skeleton_node_missing", ref: branch.branchNodeId });
    if (branch.succeededAttemptIds.length !== branch.skeletonNodeIds.length) {
      blockers.push({ code: "skeleton_attempt_incomplete", ref: branch.branchNodeId });
    }
    if (input.structured) {
      for (const check of branch.expectedArtifacts.filter((value) => !value.satisfied)) {
        blockers.push({ code: "expected_artifact_missing", ref: check.ref });
      }
      for (const check of branch.requiredContracts.filter((value) => !value.satisfied)) {
        blockers.push({ code: "required_contract_missing", ref: check.ref });
      }
      for (const check of branch.verificationCommands.filter((value) => !value.satisfied)) {
        blockers.push({ code: "verification_command_missing", ref: check.ref });
      }
      for (const check of branch.readinessConditions.filter((value) => !value.satisfied)) {
        blockers.push({ code: "readiness_evidence_missing", ref: check.ref });
      }
    }
  }
  for (const driftId of input.blockingDriftIds) blockers.push({ code: "blocking_drift", ref: driftId });
  const unique = [...new Map(blockers.map((blocker) => [`${blocker.code}\u0000${blocker.ref}`, blocker])).values()];
  const uncertain = unique.some((blocker) => blocker.code === "no_confirmed_branch" || blocker.code === "criterion_missing_or_incomplete");
  return { status: unique.length ? uncertain ? "uncertain" : "failed" : "passed", blockers: unique };
}
