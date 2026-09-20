import { describe, expect, it } from "vitest";
import {
  determineFailureMaturity,
  validateReproductionContract,
  type FailureReproductionContract,
  type ReproductionValidationObservation,
} from "../../src/domain/failure-case.js";

function contract(mode: "manual" | "assisted" | "automated"): FailureReproductionContract {
  return {
    mode,
    preconditions: ["dependencies installed"],
    environmentManifest: { node: "22", os: "linux" },
    sourceRevisionRef: "git:broken",
    fixtureRefs: ["fixture:minimal-project"],
    setupSteps: ["install fixture"],
    reproductionSteps: ["run the failing scenario"],
    cleanupSteps: ["remove temporary fixture"],
    entryCommand: mode === "manual" ? null : "npm test -- failure.test.ts",
    timeoutMs: mode === "manual" ? null : 30_000,
    isolationStrategy: "temporary_directory",
    expectedResult: "command exits successfully",
    actualFailure: "command exits 1 with assertion mismatch",
    failureOracle: { kind: "exit_code", expression: "exitCode == 1" },
    expectedFailureSignature: mode === "manual" ? null : "AssertionError:endpoint",
    preFixBaselineRef: mode === "automated" ? "git:broken" : null,
    postFixBaselineRef: null,
    repeatPolicy: { runs: mode === "manual" ? 1 : 3, allowedFailures: 0 },
    automationCoverage: mode === "manual" ? 0 : mode === "assisted" ? 0.8 : 1,
    evidenceRefs: ["trace:failure"],
  };
}

function observation(overrides: Partial<ReproductionValidationObservation> = {}): ReproductionValidationObservation {
  return {
    preFixVerdict: "red",
    postFixVerdict: "not_run",
    oracleDiscriminationVerdict: "pass",
    repeatStabilityVerdict: "pass",
    isolationVerdict: "pass",
    evidenceRefs: ["trace:validation"],
    ...overrides,
  };
}

describe("Failure Case maturity policy", () => {
  it("keeps an observed or unvalidated reproduction at L0", () => {
    expect(determineFailureMaturity({ mode: "observed", contract: null, validation: null })).toBe("L0_observed");
    expect(determineFailureMaturity({ mode: "manual", contract: contract("manual"), validation: null })).toBe("L0_observed");
  });

  it("promotes validated manual and assisted revisions only to their matching levels", () => {
    expect(determineFailureMaturity({ mode: "manual", contract: contract("manual"), validation: observation() })).toBe("L1_manual");
    expect(determineFailureMaturity({ mode: "assisted", contract: contract("assisted"), validation: observation() })).toBe("L2_assisted");
  });

  it("requires every automation gate for L3 and post-fix GREEN for L4", () => {
    const automated = contract("automated");
    expect(determineFailureMaturity({ mode: "automated", contract: automated, validation: observation() })).toBe("L3_automated");
    expect(determineFailureMaturity({
      mode: "automated",
      contract: { ...automated, postFixBaselineRef: "git:fixed" },
      validation: observation({ postFixVerdict: "green" }),
    })).toBe("L4_regression");
    for (const validation of [
      observation({ preFixVerdict: "not_red" }),
      observation({ oracleDiscriminationVerdict: "fail" }),
      observation({ repeatStabilityVerdict: "fail" }),
      observation({ isolationVerdict: "fail" }),
    ]) {
      expect(determineFailureMaturity({ mode: "automated", contract: automated, validation })).toBe("L0_observed");
    }
  });

  it("rejects incomplete contracts and plain-text secrets", () => {
    expect(() => validateReproductionContract({ ...contract("manual"), cleanupSteps: [] }))
      .toThrow(expect.objectContaining({ code: "failure_case_invalid" }));
    expect(() => validateReproductionContract({
      ...contract("manual"), environmentManifest: { API_KEY: "plaintext-secret" },
    })).toThrow(expect.objectContaining({ code: "failure_case_invalid" }));
    expect(() => validateReproductionContract({ ...contract("automated"), entryCommand: null }))
      .toThrow(expect.objectContaining({ code: "failure_case_invalid" }));
  });

  it("rejects validation claims without independent evidence", () => {
    expect(() => determineFailureMaturity({
      mode: "manual", contract: contract("manual"), validation: observation({ evidenceRefs: [] }),
    })).toThrow(expect.objectContaining({ code: "reproduction_validation_rejected" }));
  });
});
