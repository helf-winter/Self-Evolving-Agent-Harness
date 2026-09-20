export type SkillTestType = "real_failure_replay" | "variation" | "holdout" | "negative_applicability";
export type SkillTestQualityStatus =
  | "draft"
  | "schema_valid"
  | "reproducible"
  | "discriminative"
  | "stable"
  | "accepted"
  | "rejected";
export type SkillValidationRunMode = "no_skill_baseline" | "skill_enabled";
export type SkillValidationRunVerdict = "passed" | "failed" | "blocked" | "invalid";
export type SkillSideEffectRisk = "none" | "low" | "medium" | "high" | "irreversible";
export type SkillPromotionVerdict = "pass" | "fail" | "uncertain";

export interface EvolutionEvaluationFact {
  evaluationId: string;
  attemptId: string;
  nodeRevisionId: string;
  verdict: "succeeded" | "failed" | "blocked" | "uncertain";
  applied: boolean;
  occurredAt: string;
}

export type ExperienceEligibility = {
  eligible: true;
  nodeRevisionId: string;
  successEvaluationId: string;
  successAttemptId: string;
  failureEvaluationIds: string[];
  failureAttemptIds: string[];
} | {
  eligible: false;
  reason: "no_applied_success" | "insufficient_failures";
};

export interface SkillValidationRunFact {
  testCaseId: string;
  testType: SkillTestType;
  runMode: SkillValidationRunMode;
  repetitionIndex: number;
  verdict: SkillValidationRunVerdict;
  sideEffectRisk: SkillSideEffectRisk;
}

const requiredTestTypes: SkillTestType[] = [
  "real_failure_replay", "variation", "holdout", "negative_applicability",
];

export function evaluateExperienceEligibility(facts: EvolutionEvaluationFact[]): ExperienceEligibility {
  const ordered = [...facts].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
    || left.evaluationId.localeCompare(right.evaluationId));
  const successIndex = ordered.findLastIndex((fact) => fact.applied && fact.verdict === "succeeded");
  if (successIndex < 0) return { eligible: false, reason: "no_applied_success" };
  const success = ordered[successIndex]!;
  const failures = ordered.slice(0, successIndex).filter((fact) =>
    fact.applied && fact.verdict === "failed" && fact.nodeRevisionId === success.nodeRevisionId,
  );
  if (failures.length < 2) return { eligible: false, reason: "insufficient_failures" };
  return {
    eligible: true,
    nodeRevisionId: success.nodeRevisionId,
    successEvaluationId: success.evaluationId,
    successAttemptId: success.attemptId,
    failureEvaluationIds: failures.map((fact) => fact.evaluationId),
    failureAttemptIds: failures.map((fact) => fact.attemptId),
  };
}

export function evaluateSkillPromotion(input: {
  cases: Array<{ testCaseId: string; testType: SkillTestType; qualityStatus: SkillTestQualityStatus }>;
  runs: SkillValidationRunFact[];
}): { verdict: SkillPromotionVerdict; reasons: string[] } {
  const reasons = new Set<string>();
  const acceptedByType = new Map<SkillTestType, string>();
  for (const testType of requiredTestTypes) {
    const matching = input.cases.find((item) => item.testType === testType);
    if (!matching) reasons.add(`missing_${testType === "real_failure_replay" ? "real_failure_replay" : testType}`);
    else if (matching.qualityStatus !== "accepted") reasons.add("unaccepted_test_case");
    else acceptedByType.set(testType, matching.testCaseId);
  }

  for (const [testType, testCaseId] of acceptedByType) {
    for (const runMode of ["no_skill_baseline", "skill_enabled"] as const) {
      const runs = input.runs.filter((run) => run.testCaseId === testCaseId && run.testType === testType && run.runMode === runMode);
      const repetitions = new Set(runs.map((run) => run.repetitionIndex));
      if (repetitions.size < 3) reasons.add("insufficient_repetitions");
      if (new Set(runs.map((run) => run.verdict)).size > 1) reasons.add("unstable_results");
      if (runMode === "skill_enabled" && runs.some((run) => run.verdict !== "passed")) reasons.add("enabled_run_failed");
      if (runMode === "skill_enabled" && runs.some((run) => run.sideEffectRisk === "high" || run.sideEffectRisk === "irreversible")) {
        reasons.add("high_risk_side_effect");
      }
      if (testType === "negative_applicability" && runs.some((run) => run.verdict !== "passed")) {
        reasons.add("negative_applicability_failed");
      }
    }
  }

  const replayId = acceptedByType.get("real_failure_replay");
  if (replayId) {
    const baseline = input.runs.filter((run) => run.testCaseId === replayId && run.runMode === "no_skill_baseline");
    if (baseline.length < 3 || baseline.some((run) => run.verdict !== "failed")) reasons.add("baseline_not_discriminative");
  }
  return { verdict: reasons.size === 0 ? "pass" : "fail", reasons: [...reasons] };
}
