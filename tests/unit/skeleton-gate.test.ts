import { describe, expect, it } from "vitest";
import { evaluateSkeletonGate, type SkeletonGateBranchObservation } from "../../src/domain/skeleton-gate.js";

function branch(overrides: Partial<SkeletonGateBranchObservation> = {}): SkeletonGateBranchObservation {
  return {
    branchNodeId: "branch", criterionId: "criterion", criterionComplete: true,
    skeletonNodeIds: ["skeleton"], succeededAttemptIds: ["attempt"],
    expectedArtifacts: [{ ref: "src/a.ts", satisfied: true, evidenceRefs: ["write"] }],
    requiredContracts: [{ ref: "api-contract", satisfied: true, evidenceRefs: ["build"] }],
    verificationCommands: [{ ref: "npm run build", satisfied: true, evidenceRefs: ["build"] }],
    readinessConditions: [{ ref: "wired", satisfied: true, evidenceRefs: ["build"] }],
    ...overrides,
  };
}

describe("Skeleton Gate policy", () => {
  it("passes only a fully evidenced structured branch", () => {
    expect(evaluateSkeletonGate({ structured: true, branches: [branch()], blockingDriftIds: [] }))
      .toEqual({ status: "passed", blockers: [] });
  });

  it("reports deterministic missing facts and blocking drift", () => {
    expect(evaluateSkeletonGate({
      structured: true,
      branches: [branch({
        succeededAttemptIds: [],
        expectedArtifacts: [{ ref: "src/a.ts", satisfied: false, evidenceRefs: [] }],
      })],
      blockingDriftIds: ["drift-1"],
    })).toEqual({
      status: "failed",
      blockers: [
        { code: "skeleton_attempt_incomplete", ref: "branch" },
        { code: "expected_artifact_missing", ref: "src/a.ts" },
        { code: "blocking_drift", ref: "drift-1" },
      ],
    });
  });

  it("marks an absent structured criterion uncertain but preserves legacy compatibility", () => {
    expect(evaluateSkeletonGate({
      structured: true, branches: [branch({ criterionId: null, criterionComplete: false })], blockingDriftIds: [],
    }).status).toBe("uncertain");
    expect(evaluateSkeletonGate({
      structured: false,
      branches: [branch({ criterionId: null, criterionComplete: true, expectedArtifacts: [], requiredContracts: [], verificationCommands: [], readinessConditions: [] })],
      blockingDriftIds: [],
    }).status).toBe("passed");
  });
});

