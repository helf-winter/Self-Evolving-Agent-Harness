import { HarnessError } from "./errors.js";

export type RuntimeActionType = "resolve_plan_drift" | "record_user_change";
export type RuntimeActionRiskLevel = "low" | "medium" | "high" | "irreversible";
export type RuntimeActionStatus =
  | "proposed"
  | "validated"
  | "pending_confirmation"
  | "committed"
  | "rejected"
  | "revision_conflict";
export type RuntimeConfirmationAnswer = "yes" | "no" | "pause";
export type UserChangeType = "minor_change" | "scope_change" | "priority_change";
export type RuntimeConfirmationRequirement = "none" | "required";
export type RuntimePromptType = "drift_resolution" | "change_confirmation";

export interface RuntimeActionSafetyInput {
  actionType: RuntimeActionType;
  userChangeType?: UserChangeType;
  reason: string;
  sourceMessageRef: string;
}

export interface RuntimeActionSafetyDecision {
  confirmationRequirement: RuntimeConfirmationRequirement;
  promptType: RuntimePromptType | null;
}

export function evaluateRuntimeActionSafety(input: RuntimeActionSafetyInput): RuntimeActionSafetyDecision {
  if (!input.reason.trim() || !input.sourceMessageRef.trim()) {
    throw new HarnessError("invalid_input", "Runtime Action reason and source message reference are required");
  }
  if (input.actionType === "resolve_plan_drift") {
    if (input.userChangeType) {
      throw new HarnessError("invalid_input", "Plan Drift resolution cannot declare a User Change type");
    }
    return { confirmationRequirement: "required", promptType: "drift_resolution" };
  }
  if (!input.userChangeType) {
    throw new HarnessError("invalid_input", "record_user_change requires a User Change type");
  }
  return input.userChangeType === "scope_change"
    ? { confirmationRequirement: "required", promptType: "change_confirmation" }
    : { confirmationRequirement: "none", promptType: null };
}
