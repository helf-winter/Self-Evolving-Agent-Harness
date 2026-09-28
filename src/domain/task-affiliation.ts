import { HarnessError } from "./errors.js";

export type TaskAffiliationRecommendation = "new_tree" | "merge";
export type TaskAffiliationChoice = "new_tree" | "merge" | "pause";
export type TaskAffiliationStatus = "pending" | "new_tree" | "merged" | "paused";

export function validateAffiliationRecommendation(input: {
  recommendation: TaskAffiliationRecommendation;
  recommendedTreeId?: string | null;
}): void {
  if (input.recommendation === "merge" && !input.recommendedTreeId?.trim()) {
    throw new HarnessError("invalid_input", "a merge recommendation requires a recommended Task Tree");
  }
  if (input.recommendation === "new_tree" && input.recommendedTreeId) {
    throw new HarnessError("invalid_input", "a new-tree recommendation cannot target an existing Task Tree");
  }
}

export function statusForAffiliationChoice(choice: TaskAffiliationChoice): TaskAffiliationStatus {
  if (choice === "merge") return "merged";
  if (choice === "pause") return "paused";
  return choice;
}
