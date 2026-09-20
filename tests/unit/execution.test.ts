import { describe, expect, it } from "vitest";
import { decideLifecycleTransition } from "../../src/domain/execution.js";

describe("Task Node lifecycle policy", () => {
  it("applies succeeded only when current evidence and dependencies are complete", () => {
    expect(decideLifecycleTransition({
      currentRevision: true,
      fromStatus: "verifying",
      verdict: "succeeded",
      evidenceComplete: true,
      dependenciesSucceeded: true,
      childrenSucceeded: true,
    })).toEqual({
      policyVersion: "task-node-lifecycle/v1",
      applied: true,
      targetStatus: "succeeded",
      rejectionCode: null,
    });
  });

  it("keeps uncertain evaluations in verifying", () => {
    expect(decideLifecycleTransition({
      currentRevision: true,
      fromStatus: "verifying",
      verdict: "uncertain",
      evidenceComplete: false,
      dependenciesSucceeded: true,
      childrenSucceeded: true,
    })).toMatchObject({ applied: false, targetStatus: "verifying", rejectionCode: "evaluation_uncertain" });
  });

  it("does not apply a stale evaluation to the current node", () => {
    expect(decideLifecycleTransition({
      currentRevision: false,
      fromStatus: "verifying",
      verdict: "succeeded",
      evidenceComplete: true,
      dependenciesSucceeded: true,
      childrenSucceeded: true,
    })).toMatchObject({ applied: false, targetStatus: "needs_revalidation", rejectionCode: "stale_revision" });
  });

  it("applies failed and blocked verdicts to the current attempt", () => {
    const common = {
      currentRevision: true,
      fromStatus: "verifying" as const,
      evidenceComplete: true,
      dependenciesSucceeded: true,
      childrenSucceeded: true,
    };
    expect(decideLifecycleTransition({ ...common, verdict: "failed" })).toMatchObject({ applied: true, targetStatus: "failed" });
    expect(decideLifecycleTransition({ ...common, verdict: "blocked" })).toMatchObject({ applied: true, targetStatus: "blocked" });
  });

  it("keeps a node blocked while a blocking Plan Drift awaits confirmation", () => {
    expect(decideLifecycleTransition({
      currentRevision: true,
      fromStatus: "blocked",
      verdict: "uncertain",
      evidenceComplete: true,
      dependenciesSucceeded: true,
      childrenSucceeded: true,
      blockingDrift: true,
    })).toMatchObject({ applied: false, targetStatus: "blocked", rejectionCode: "blocking_drift" });
  });
});
