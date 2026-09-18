import { describe, expect, it } from "vitest";
import { canTransitionWorkflow } from "../../src/domain/workflow.js";

describe("coding workflow", () => {
  it("allows the declared next stage with required confirmation evidence", () => {
    expect(canTransitionWorkflow("branch_confirmation", "skeleton_pass", { confirmationId: "c1" })).toEqual({ ok: true });
  });

  it("rejects stage skipping and a missing skeleton gate result", () => {
    expect(canTransitionWorkflow("draft_task_tree", "branch_implementation", {})).toMatchObject({ ok: false });
    expect(canTransitionWorkflow("skeleton_gate", "branch_implementation", {})).toEqual({
      ok: false,
      code: "workflow_transition_rejected",
      reason: "skeleton gate evidence is required",
    });
  });
});
