import { describe, expect, it } from "vitest";
import {
  aggregateSemanticAnswers,
  resolveJevConfiguration,
  semanticSnapshotHash,
  type SemanticEvidenceSnapshot,
} from "../../src/domain/semantic-evaluation.js";

const snapshot: SemanticEvidenceSnapshot = {
  schemaVersion: 1,
  task: { title: "Repair login", objectives: ["Restore login"], acceptanceCriteria: ["tests pass"] },
  evidence: [{ key: "test", description: "login test passes", observations: [] }],
};

describe("semantic evaluation policy", () => {
  it("is disabled by default and never infers enablement from the API key alone", () => {
    expect(resolveJevConfiguration({ TYPESAFE_API_KEY: "secret" })).toMatchObject({
      enabled: false, readiness: "disabled", model: "jev-1.13.0",
      minProbability: 0.7, minConfidence: 0.5,
    });
    expect(resolveJevConfiguration({ HARNESS_JEV_ENABLED: "true" })).toMatchObject({
      enabled: true, readiness: "misconfigured", apiKey: null,
    });
  });

  it("uses pinned configuration and validates bounded thresholds", () => {
    expect(resolveJevConfiguration({
      HARNESS_JEV_ENABLED: "true", TYPESAFE_API_KEY: "secret",
      HARNESS_JEV_MIN_PROBABILITY: "0.8", HARNESS_JEV_MIN_CONFIDENCE: "0.6",
    })).toMatchObject({
      readiness: "ready", model: "jev-1.13.0", minProbability: 0.8, minConfidence: 0.6,
    });
    expect(() => resolveJevConfiguration({ HARNESS_JEV_MIN_PROBABILITY: "2" }))
      .toThrow(expect.objectContaining({ code: "invalid_configuration" }));
  });

  it("passes only when every answer is supported above probability and confidence thresholds", () => {
    expect(aggregateSemanticAnswers({
      snapshot,
      answers: {
        evidence_0: {
          type: "choice", choice: "supported",
          probabilities: { supported: 0.9, unsupported: 0.05, insufficient_context: 0.05 }, confidence: 0.8,
        },
      },
      minProbability: 0.7,
      minConfidence: 0.5,
    })).toMatchObject({ status: "passed", results: [{ evidenceKey: "test", passed: true }] });
    expect(aggregateSemanticAnswers({
      snapshot,
      answers: {
        evidence_0: {
          type: "choice", choice: "supported",
          probabilities: { supported: 0.6, unsupported: 0.2, insufficient_context: 0.2 }, confidence: 0.4,
        },
      },
      minProbability: 0.7,
      minConfidence: 0.5,
    }).status).toBe("review");
  });

  it("hashes canonical evidence snapshots deterministically", () => {
    expect(semanticSnapshotHash(snapshot)).toBe(semanticSnapshotHash(structuredClone(snapshot)));
  });
});
