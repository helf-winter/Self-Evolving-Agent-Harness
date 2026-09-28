import { describe, expect, it, vi } from "vitest";
import { JevEvaluationProvider } from "../../src/bindings/typesafe/jev-evaluation-provider.js";
import { resolveJevConfiguration, type SemanticEvidenceSnapshot } from "../../src/domain/semantic-evaluation.js";

const snapshot: SemanticEvidenceSnapshot = {
  schemaVersion: 1,
  task: { title: "Repair login", objectives: ["Restore login"], acceptanceCriteria: ["test passes"] },
  evidence: [{
    key: "test", description: "login test passes",
    observations: [{
      traceEventId: "trace-1", eventName: "PostToolUse", sourceEvent: "PostToolUse", toolName: "Bash",
      artifactRefs: ["artifact-1"], outcome: { ok: true, exitCode: 0 },
    }],
  }],
};

describe("JevEvaluationProvider", () => {
  it("calls the pinned API with typed independent questions and parses usage", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "jev-1.13.0", state: snapshot });
      expect(body.questions).toMatchObject({ evidence_0: { type: "choice" } });
      expect(String((init?.headers as Record<string, string>).Authorization)).toBe("Bearer test-key");
      return new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          evidence_0: {
            type: "choice", choice: "supported",
            probabilities: { supported: 0.9, unsupported: 0.05, insufficient_context: 0.05 }, confidence: 0.8,
          },
        },
        usage: { input_tokens: 100, output_tokens: 20 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = new JevEvaluationProvider(resolveJevConfiguration({
      HARNESS_JEV_ENABLED: "true", TYPESAFE_API_KEY: "test-key",
    }), fetcher as typeof fetch);
    await expect(provider.evaluate(snapshot)).resolves.toMatchObject({
      model: "jev-1.13.0", usage: { inputTokens: 100, outputTokens: 20 },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "provider_authentication_failed"],
    [422, "provider_request_invalid"],
    [429, "provider_rate_limited"],
    [529, "provider_overloaded"],
    [500, "provider_http_error"],
  ])("maps HTTP %i to the sanitized %s code", async (status, code) => {
    const provider = new JevEvaluationProvider(resolveJevConfiguration({
      HARNESS_JEV_ENABLED: "true", TYPESAFE_API_KEY: "test-key",
    }), vi.fn(async () => new Response("secret provider response", { status })) as unknown as typeof fetch);
    await expect(provider.evaluate(snapshot)).rejects.toMatchObject({ code });
  });

  it("maps timeout, connection, and malformed response failures", async () => {
    const config = resolveJevConfiguration({ HARNESS_JEV_ENABLED: "true", TYPESAFE_API_KEY: "test-key" });
    await expect(new JevEvaluationProvider(config, vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch).evaluate(snapshot)).rejects.toMatchObject({ code: "provider_timeout" });
    await expect(new JevEvaluationProvider(config, vi.fn(async () => {
      throw new Error("socket exposed details");
    }) as unknown as typeof fetch).evaluate(snapshot)).rejects.toMatchObject({ code: "provider_connection_failed" });
    await expect(new JevEvaluationProvider(config, vi.fn(async () => new Response("not json", { status: 200 })) as unknown as typeof fetch)
      .evaluate(snapshot)).rejects.toMatchObject({ code: "provider_response_invalid" });
  });
});
