import { describe, expect, it } from "vitest";
import { evaluateRuntimeActionSafety } from "../../src/domain/runtime-action.js";

describe("Runtime Action safety policy", () => {
  it("requires confirmation for blocking Drift resolution", () => {
    expect(evaluateRuntimeActionSafety({
      actionType: "resolve_plan_drift",
      reason: "Apply the user's decision to the blocking Drift",
      sourceMessageRef: "trace-1",
    })).toEqual({ confirmationRequirement: "required", promptType: "drift_resolution" });
  });

  it("requires confirmation only for scope-changing User Changes", () => {
    expect(evaluateRuntimeActionSafety({
      actionType: "record_user_change", userChangeType: "scope_change",
      reason: "Change the confirmed endpoint", sourceMessageRef: "trace-1",
    })).toEqual({ confirmationRequirement: "required", promptType: "change_confirmation" });

    for (const userChangeType of ["minor_change", "priority_change"] as const) {
      expect(evaluateRuntimeActionSafety({
        actionType: "record_user_change", userChangeType,
        reason: "Record an authorized low-risk change", sourceMessageRef: "trace-1",
      })).toEqual({ confirmationRequirement: "none", promptType: null });
    }
  });

  it("rejects unsupported action and User Change combinations", () => {
    expect(() => evaluateRuntimeActionSafety({
      actionType: "resolve_plan_drift", userChangeType: "minor_change",
      reason: "invalid combination", sourceMessageRef: "trace-1",
    })).toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(() => evaluateRuntimeActionSafety({
      actionType: "record_user_change", reason: "missing type", sourceMessageRef: "trace-1",
    })).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("requires a reason and source message reference", () => {
    expect(() => evaluateRuntimeActionSafety({
      actionType: "resolve_plan_drift", reason: " ", sourceMessageRef: "trace-1",
    })).toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(() => evaluateRuntimeActionSafety({
      actionType: "record_user_change", userChangeType: "minor_change",
      reason: "Record change", sourceMessageRef: " ",
    })).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });
});
