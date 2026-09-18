import { describe, expect, it } from "vitest";
import { createHookIdempotencyKey, redactSecrets } from "../../src/domain/trace.js";

describe("Trace facts", () => {
  it("deeply redacts secret-bearing keys while preserving useful evidence", () => {
    expect(redactSecrets({ command: "npm test", authorization: "Bearer secret", nested: { apiKey: "abc", exitCode: 1 } })).toEqual({
      command: "npm test",
      authorization: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", exitCode: 1 },
    });
  });

  it("redacts credentials embedded in command strings", () => {
    const redacted = redactSecrets({ command: "curl -H 'Authorization: Bearer top-secret' --api-key abc123 https://example.test" });
    expect(JSON.stringify(redacted)).not.toContain("top-secret");
    expect(JSON.stringify(redacted)).not.toContain("abc123");
    expect(redacted).toEqual({ command: "curl -H 'Authorization: Bearer [REDACTED]' --api-key [REDACTED] https://example.test" });
  });

  it("produces the same receipt key for equivalent object key order", () => {
    const first = createHookIdempotencyKey({ sessionId: "s", eventName: "PostToolUse", toolUseId: "t", payload: { b: 2, a: 1 } });
    const second = createHookIdempotencyKey({ sessionId: "s", eventName: "PostToolUse", toolUseId: "t", payload: { a: 1, b: 2 } });
    expect(first).toBe(second);
  });
});
