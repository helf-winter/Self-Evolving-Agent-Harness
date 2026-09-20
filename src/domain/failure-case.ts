import { HarnessError } from "./errors.js";

export type FailureMaturityLevel =
  | "L0_observed"
  | "L1_manual"
  | "L2_assisted"
  | "L3_automated"
  | "L4_regression";

export type FailureAvailabilityStatus = "active" | "flaky" | "environment_blocked" | "quarantined" | "obsolete";
export type FailureReproductionMode = "observed" | "manual" | "assisted" | "automated";
export type FailureIsolationStrategy =
  | "fixture"
  | "worktree"
  | "temporary_directory"
  | "project_native"
  | "container"
  | "virtual_environment";
export type ValidationGateVerdict = "pass" | "fail" | "not_run";
export type PreFixVerdict = "red" | "not_red" | "not_run";
export type PostFixVerdict = "green" | "not_green" | "not_run";

export interface FailureOracle {
  kind: "exit_code" | "assertion" | "failure_signature" | "artifact_state" | "schema";
  expression: string;
}

export interface FailureReproductionContract {
  mode: Exclude<FailureReproductionMode, "observed">;
  preconditions: string[];
  environmentManifest: Record<string, string>;
  sourceRevisionRef: string;
  fixtureRefs: string[];
  setupSteps: string[];
  reproductionSteps: string[];
  cleanupSteps: string[];
  entryCommand: string | null;
  timeoutMs: number | null;
  isolationStrategy: FailureIsolationStrategy;
  expectedResult: string;
  actualFailure: string;
  failureOracle: FailureOracle;
  expectedFailureSignature: string | null;
  preFixBaselineRef: string | null;
  postFixBaselineRef: string | null;
  repeatPolicy: { runs: number; allowedFailures: number };
  automationCoverage: number;
  evidenceRefs: string[];
}

export interface ReproductionValidationObservation {
  preFixVerdict: PreFixVerdict;
  postFixVerdict: PostFixVerdict;
  oracleDiscriminationVerdict: ValidationGateVerdict;
  repeatStabilityVerdict: ValidationGateVerdict;
  isolationVerdict: ValidationGateVerdict;
  evidenceRefs: string[];
}

const nonEmpty = (values: string[]) => values.length > 0 && values.every((value) => value.trim().length > 0);
const secretKey = /(authorization|api[-_]?key|token|credential|cookie|password|secret)/i;

export function validateReproductionContract(contract: FailureReproductionContract): void {
  if (!nonEmpty(contract.preconditions)
    || !contract.sourceRevisionRef.trim()
    || !nonEmpty(contract.fixtureRefs)
    || !nonEmpty(contract.setupSteps)
    || !nonEmpty(contract.reproductionSteps)
    || !nonEmpty(contract.cleanupSteps)
    || !contract.expectedResult.trim()
    || !contract.actualFailure.trim()
    || !contract.failureOracle.expression.trim()
    || !nonEmpty(contract.evidenceRefs)) {
    throw new HarnessError("failure_case_invalid", "reproduction contract is missing required structured fields or evidence");
  }
  for (const [key, value] of Object.entries(contract.environmentManifest)) {
    if (!key.trim() || !value.trim() || (secretKey.test(key) && value !== "[REDACTED]")) {
      throw new HarnessError("failure_case_invalid", "environment manifest must contain metadata only and redact secret values");
    }
  }
  if (!Number.isInteger(contract.repeatPolicy.runs)
    || contract.repeatPolicy.runs < 1
    || !Number.isInteger(contract.repeatPolicy.allowedFailures)
    || contract.repeatPolicy.allowedFailures < 0
    || contract.repeatPolicy.allowedFailures >= contract.repeatPolicy.runs) {
    throw new HarnessError("failure_case_invalid", "repeat policy must define a positive run count and a smaller failure allowance");
  }
  if (contract.automationCoverage < 0 || contract.automationCoverage > 1) {
    throw new HarnessError("failure_case_invalid", "automation coverage must be between zero and one");
  }
  if (contract.mode === "manual") {
    if (contract.entryCommand || contract.timeoutMs !== null || contract.automationCoverage !== 0) {
      throw new HarnessError("failure_case_invalid", "manual reproduction cannot claim an automated entry point or coverage");
    }
    return;
  }
  if (!contract.entryCommand?.trim()
    || !contract.timeoutMs
    || contract.timeoutMs <= 0
    || !contract.expectedFailureSignature?.trim()) {
    throw new HarnessError("failure_case_invalid", "assisted and automated reproduction require an entry command, timeout, and expected failure signature");
  }
  if (contract.mode === "assisted" && !(contract.automationCoverage > 0 && contract.automationCoverage < 1)) {
    throw new HarnessError("failure_case_invalid", "assisted reproduction coverage must be greater than zero and less than one");
  }
  if (contract.mode === "automated" && (contract.automationCoverage !== 1 || !contract.preFixBaselineRef?.trim())) {
    throw new HarnessError("failure_case_invalid", "automated reproduction requires full coverage and a pre-fix baseline");
  }
}

function validateObservation(observation: ReproductionValidationObservation): void {
  if (!nonEmpty(observation.evidenceRefs)) {
    throw new HarnessError("reproduction_validation_rejected", "reproduction validation requires independent persisted evidence");
  }
}

export function determineFailureMaturity(input: {
  mode: FailureReproductionMode;
  contract: FailureReproductionContract | null;
  validation: ReproductionValidationObservation | null;
}): FailureMaturityLevel {
  if (input.mode === "observed") return "L0_observed";
  if (!input.contract || input.contract.mode !== input.mode) {
    throw new HarnessError("failure_case_invalid", "reproduction mode and contract do not match");
  }
  validateReproductionContract(input.contract);
  if (!input.validation) return "L0_observed";
  validateObservation(input.validation);
  if (input.validation.preFixVerdict !== "red" || input.validation.isolationVerdict !== "pass") return "L0_observed";
  if (input.mode === "manual") return "L1_manual";
  if (input.validation.repeatStabilityVerdict !== "pass") return "L0_observed";
  if (input.mode === "assisted") return "L2_assisted";
  if (input.validation.oracleDiscriminationVerdict !== "pass") return "L0_observed";
  if (input.validation.postFixVerdict === "green" && input.contract.postFixBaselineRef?.trim()) return "L4_regression";
  return "L3_automated";
}
