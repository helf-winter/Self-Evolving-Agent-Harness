import { createHash } from "node:crypto";

const secretKey = /(authorization|api[-_]?key|token|credential|cookie|password|secret)/i;

function redactInlineSecrets(value: string): string {
  return value
    .replace(/((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/((?:--?)?(?:api[-_]?key|token|password|secret)(?:\s+|\s*[:=]\s*)["']?)[^\s"';&]+/gi, "$1[REDACTED]");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function redactSecrets(value: unknown, key = ""): unknown {
  if (secretKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactInlineSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, item]) => [entryKey, redactSecrets(item, entryKey)]));
  }
  return value;
}

export function createHookIdempotencyKey(input: { sessionId: string; eventName: string; toolUseId?: string; payload: unknown }): string {
  return createHash("sha256").update(canonical(redactSecrets(input))).digest("hex");
}

export { canonical as canonicalJson };
