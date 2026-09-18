export function present(value: unknown, json: boolean): string {
  if (json) return JSON.stringify(value);
  if (Array.isArray(value)) return value.length ? value.map((item) => JSON.stringify(item)).join("\n") : "No results.";
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}
