import { createHash } from "node:crypto";
import { HarnessError } from "./errors.js";
import { canonicalJson } from "./trace.js";

export type SemanticEvaluationStatus = "passed" | "review" | "unavailable";
export type JevReadiness = "disabled" | "ready" | "misconfigured";

export interface SemanticEvidenceObservation {
  traceEventId: string;
  eventName: string;
  sourceEvent: string | null;
  toolName: string | null;
  artifactRefs: string[];
  outcome: { ok?: boolean; exitCode?: number; status?: string };
}

export interface SemanticEvidenceSnapshot {
  schemaVersion: 1;
  task: {
    title: string;
    objectives: string[];
    acceptanceCriteria: string[];
  };
  evidence: Array<{
    key: string;
    description: string;
    observations: SemanticEvidenceObservation[];
  }>;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: "supported" | "unsupported" | "insufficient_context";
  probabilities: Record<string, number>;
  confidence: number;
}

export interface SemanticQuestionResult {
  evidenceKey: string;
  choice: JevChoiceAnswer["choice"];
  supportedProbability: number;
  confidence: number;
  passed: boolean;
}

export interface JevConfiguration {
  enabled: boolean;
  readiness: JevReadiness;
  apiKey: string | null;
  endpoint: "https://api.typesafe.ai/v1/systemone";
  model: "jev-1.13.0";
  timeoutMs: number;
  minProbability: number;
  minConfidence: number;
}

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new HarnessError("invalid_configuration", `semantic evaluation value must be between ${min} and ${max}`);
  }
  return parsed;
}

export function resolveJevConfiguration(environment: NodeJS.ProcessEnv): JevConfiguration {
  const enabled = environment.HARNESS_JEV_ENABLED === "true";
  const apiKey = environment.TYPESAFE_API_KEY?.trim() || null;
  return {
    enabled,
    readiness: !enabled ? "disabled" : apiKey ? "ready" : "misconfigured",
    apiKey,
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-1.13.0",
    timeoutMs: boundedNumber(environment.HARNESS_JEV_TIMEOUT_MS, 10_000, 100, 60_000),
    minProbability: boundedNumber(environment.HARNESS_JEV_MIN_PROBABILITY, 0.7, 0, 1),
    minConfidence: boundedNumber(environment.HARNESS_JEV_MIN_CONFIDENCE, 0.5, 0, 1),
  };
}

export function semanticSnapshotHash(snapshot: SemanticEvidenceSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

export function aggregateSemanticAnswers(input: {
  snapshot: SemanticEvidenceSnapshot;
  answers: Record<string, JevChoiceAnswer>;
  minProbability: number;
  minConfidence: number;
}): { status: "passed" | "review"; results: SemanticQuestionResult[] } {
  const results = input.snapshot.evidence.map((item, index) => {
    const answer = input.answers[`evidence_${index}`];
    if (!answer || answer.type !== "choice" || !["supported", "unsupported", "insufficient_context"].includes(answer.choice)) {
      throw new HarnessError("provider_response_invalid", "Jev response is missing a valid evidence answer");
    }
    const supportedProbability = answer.probabilities.supported ?? Number.NaN;
    if (!Number.isFinite(supportedProbability) || !Number.isFinite(answer.confidence)) {
      throw new HarnessError("provider_response_invalid", "Jev response contains invalid probability or confidence values");
    }
    const passed = answer.choice === "supported"
      && supportedProbability >= input.minProbability
      && answer.confidence >= input.minConfidence;
    return { evidenceKey: item.key, choice: answer.choice, supportedProbability, confidence: answer.confidence, passed };
  });
  return { status: results.length > 0 && results.every((result) => result.passed) ? "passed" : "review", results };
}
