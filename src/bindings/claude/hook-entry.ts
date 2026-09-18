import { openRuntime } from "../../application/runtime.js";
import { HarnessError } from "../../domain/errors.js";
import { mapClaudeHook } from "./hook-mapper.js";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const runtime = openRuntime();
try {
  const raw = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  await runtime.hooks.ingest(mapClaudeHook(raw));
} catch (error) {
  const normalized = error instanceof HarnessError ? error : new HarnessError("storage_failure", error instanceof Error ? error.message : String(error));
  process.stderr.write(`${JSON.stringify({ error: { code: normalized.code, message: normalized.message } })}\n`);
  process.exitCode = 1;
} finally {
  runtime.close();
}
