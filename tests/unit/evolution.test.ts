import { describe, expect, it } from "vitest";
import {
  evaluateExperienceEligibility,
  evaluateSkillPromotion,
  type SkillTestType,
  type SkillValidationRunFact,
} from "../../src/domain/evolution.js";

describe("Skill Evolution policy", () => {
  it("requires two applied failures before an applied success on the same revision", () => {
    const facts = [
      { evaluationId: "e1", attemptId: "a1", nodeRevisionId: "nr1", verdict: "failed" as const, applied: true, occurredAt: "1" },
      { evaluationId: "e2", attemptId: "a2", nodeRevisionId: "nr1", verdict: "failed" as const, applied: true, occurredAt: "2" },
      { evaluationId: "e3", attemptId: "a3", nodeRevisionId: "nr1", verdict: "succeeded" as const, applied: true, occurredAt: "3" },
    ];
    expect(evaluateExperienceEligibility(facts)).toEqual({
      eligible: true, nodeRevisionId: "nr1", successEvaluationId: "e3", successAttemptId: "a3",
      failureEvaluationIds: ["e1", "e2"], failureAttemptIds: ["a1", "a2"],
    });
    expect(evaluateExperienceEligibility(facts.slice(1))).toMatchObject({ eligible: false, reason: "insufficient_failures" });
    expect(evaluateExperienceEligibility([
      ...facts.slice(0, 2), { ...facts[2]!, nodeRevisionId: "nr2" },
    ])).toMatchObject({ eligible: false, reason: "insufficient_failures" });
  });

  it("ignores unapplied and nonterminal evaluation facts", () => {
    expect(evaluateExperienceEligibility([
      { evaluationId: "e1", attemptId: "a1", nodeRevisionId: "nr1", verdict: "failed", applied: true, occurredAt: "1" },
      { evaluationId: "e2", attemptId: "a2", nodeRevisionId: "nr1", verdict: "failed", applied: false, occurredAt: "2" },
      { evaluationId: "e3", attemptId: "a3", nodeRevisionId: "nr1", verdict: "uncertain", applied: false, occurredAt: "3" },
      { evaluationId: "e4", attemptId: "a4", nodeRevisionId: "nr1", verdict: "succeeded", applied: true, occurredAt: "4" },
    ])).toMatchObject({ eligible: false, reason: "insufficient_failures" });
  });

  function completeRunFacts(overrides: Partial<SkillValidationRunFact> = {}): {
    cases: Array<{ testCaseId: string; testType: SkillTestType; qualityStatus: "accepted" }>;
    runs: SkillValidationRunFact[];
  } {
    const types: SkillTestType[] = ["real_failure_replay", "variation", "holdout", "negative_applicability"];
    const cases = types.map((testType) => ({ testCaseId: testType, testType, qualityStatus: "accepted" as const }));
    const runs = cases.flatMap((test) => (["no_skill_baseline", "skill_enabled"] as const).flatMap((runMode) =>
      [1, 2, 3].map((repetitionIndex): SkillValidationRunFact => ({
        testCaseId: test.testCaseId,
        testType: test.testType,
        runMode,
        repetitionIndex,
        verdict: runMode === "no_skill_baseline" && test.testType === "real_failure_replay" ? "failed" : "passed",
        sideEffectRisk: "none",
        ...overrides,
      })),
    ));
    return { cases, runs };
  }

  it("passes only a complete, stable, discriminative, low-risk validation matrix", () => {
    const complete = completeRunFacts();
    expect(evaluateSkillPromotion(complete)).toEqual({ verdict: "pass", reasons: [] });

    expect(evaluateSkillPromotion({ cases: complete.cases.filter((item) => item.testType !== "holdout"), runs: complete.runs }))
      .toMatchObject({ verdict: "fail", reasons: expect.arrayContaining(["missing_holdout"]) });
    expect(evaluateSkillPromotion({ cases: complete.cases, runs: complete.runs.filter((item) => item.repetitionIndex < 3) }))
      .toMatchObject({ verdict: "fail", reasons: expect.arrayContaining(["insufficient_repetitions"]) });
  });

  it("rejects missing baseline discrimination, enabled failures, and high-risk effects", () => {
    const complete = completeRunFacts();
    expect(evaluateSkillPromotion({
      cases: complete.cases,
      runs: complete.runs.map((run) => run.testType === "real_failure_replay" && run.runMode === "no_skill_baseline"
        ? { ...run, verdict: "passed" as const }
        : run),
    })).toMatchObject({ verdict: "fail", reasons: expect.arrayContaining(["baseline_not_discriminative"]) });
    expect(evaluateSkillPromotion({
      cases: complete.cases,
      runs: complete.runs.map((run) => run.testType === "holdout" && run.runMode === "skill_enabled" && run.repetitionIndex === 2
        ? { ...run, verdict: "failed" as const }
        : run),
    })).toMatchObject({ verdict: "fail", reasons: expect.arrayContaining(["enabled_run_failed", "unstable_results"]) });
    expect(evaluateSkillPromotion({
      cases: complete.cases,
      runs: complete.runs.map((run) => run.runMode === "skill_enabled" && run.testType === "variation"
        ? { ...run, sideEffectRisk: "high" as const }
        : run),
    })).toMatchObject({ verdict: "fail", reasons: expect.arrayContaining(["high_risk_side_effect"]) });
  });
});
