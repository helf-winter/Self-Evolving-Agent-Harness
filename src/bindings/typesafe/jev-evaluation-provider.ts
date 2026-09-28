import { HarnessError, type HarnessErrorCode } from "../../domain/errors.js";
import type { JevChoiceAnswer, JevConfiguration, SemanticEvidenceSnapshot } from "../../domain/semantic-evaluation.js";

export interface JevEvaluationResponse {
  model: string;
  answers: Record<string, JevChoiceAnswer>;
  usage: { inputTokens: number; outputTokens: number };
}

export type JevFetch = typeof fetch;

function providerErrorCode(status: number): HarnessErrorCode {
  if (status === 401) return "provider_authentication_failed";
  if (status === 429) return "provider_rate_limited";
  if (status === 529) return "provider_overloaded";
  if (status === 422) return "provider_request_invalid";
  return "provider_http_error";
}

export class JevEvaluationProvider {
  constructor(private readonly config: JevConfiguration, private readonly fetcher: JevFetch = fetch) {}

  async evaluate(snapshot: SemanticEvidenceSnapshot): Promise<JevEvaluationResponse> {
    if (!this.config.enabled) throw new HarnessError("provider_disabled", "Jev semantic evaluation is disabled");
    if (!this.config.apiKey) throw new HarnessError("provider_misconfigured", "TYPESAFE_API_KEY is not configured");
    const questions = Object.fromEntries(snapshot.evidence.map((item, index) => [`evidence_${index}`, {
      type: "choice",
      instructions: {
        question: "Does the observed evidence directly support this required evidence and the task acceptance criteria?",
        required_evidence: { key: item.key, description: item.description },
      },
      criteria: {
        supported: "The observations directly and positively support the requirement without a material contradiction.",
        unsupported: "The observations show failure, contradiction, or that the requirement was not met.",
        insufficient_context: "The bounded observations do not contain enough information to decide safely.",
      },
    }]));
    let response: Response;
    try {
      response = await this.fetcher(this.config.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state: snapshot, model: this.config.model, questions }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      const code = error instanceof Error && error.name === "TimeoutError" ? "provider_timeout" : "provider_connection_failed";
      throw new HarnessError(code, "Jev request did not complete", error);
    }
    if (!response.ok) throw new HarnessError(providerErrorCode(response.status), "Jev request was rejected", { status: response.status });
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new HarnessError("provider_response_invalid", "Jev returned invalid JSON", error);
    }
    if (!body || typeof body !== "object") throw new HarnessError("provider_response_invalid", "Jev returned an invalid response");
    const value = body as Record<string, unknown>;
    const usage = value.usage as Record<string, unknown> | undefined;
    if (typeof value.model !== "string" || !value.answers || typeof value.answers !== "object"
      || !usage || !Number.isInteger(usage.input_tokens) || !Number.isInteger(usage.output_tokens)) {
      throw new HarnessError("provider_response_invalid", "Jev response does not match the required schema");
    }
    return {
      model: value.model,
      answers: value.answers as Record<string, JevChoiceAnswer>,
      usage: { inputTokens: usage.input_tokens as number, outputTokens: usage.output_tokens as number },
    };
  }
}
