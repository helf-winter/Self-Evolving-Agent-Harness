import { HarnessError } from "../domain/errors.js";
import { openRuntime } from "../application/runtime.js";
import { mapClaudeHook } from "../bindings/claude/hook-mapper.js";
import { present } from "./presenter.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--json") continue;
    if (args[index] === "--cwd" || args[index] === "--limit" || args[index] === "--cursor") { index += 1; continue; }
    result.push(args[index]!);
  }
  return result;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  const json = args.includes("--json");
  const cwd = option(args, "--cwd") ?? process.cwd();
  const words = positional(args);

  if (words[0] === "doctor") {
    const [major, minor] = process.versions.node.split(".").map(Number);
    const supported = (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 13);
    const result = {
      node: { ok: supported, version: process.versions.node, minimum: "22.13.0" },
      sqlite: { ok: true, implementation: "node:sqlite" },
    };
    process.stdout.write(`${present(result, json)}\n`);
    return 0;
  }

  const runtime = openRuntime();
  try {
    let result: unknown;
    if (words[0] === "project" && words[1] === "inspect") {
      result = await runtime.projects.resolve(cwd, "inspect");
    } else if (words[0] === "taskroot") {
      const title = words.slice(1).join(" ").trim();
      const project = await runtime.projects.resolve(cwd, "persist");
      if (project.status === "identity_conflict") throw new HarnessError("project_identity_conflict", "project marker conflicts with this path");
      result = await runtime.taskTrees.createTaskRoot({ projectId: project.projectId, title });
    } else if (words[0] === "tree" && words[1] === "candidates") {
      const project = await requireProject(runtime, cwd);
      const query = words.slice(2).join(" ");
      result = runtime.taskTrees.listTaskTreeCandidates({ projectId: project.projectId, ...(query ? { query } : {}) });
    } else if (words[0] === "tree" && words[1] === "snapshot") {
      const project = await requireProject(runtime, cwd);
      result = runtime.queries.getRuntimeSnapshot(project.projectId);
    } else if (words[0] === "tree" && words[1] === "summary") {
      const project = await requireProject(runtime, cwd);
      result = runtime.queries.getTaskTreeSummary(project.projectId, words[2] ?? "");
    } else if (words[0] === "tree" && words[1] === "readiness") {
      const project = await requireProject(runtime, cwd);
      result = runtime.taskTrees.scanPlanReadiness({ projectId: project.projectId, treeId: words[2] ?? "" });
    } else if (words[0] === "trace" && words[1] === "list") {
      const project = await requireProject(runtime, cwd);
      const cursor = option(args, "--cursor");
      result = runtime.queries.getTraceEvents(project.projectId, { limit: Number(option(args, "--limit") ?? 50), ...(cursor ? { cursor } : {}) });
    } else if (words[0] === "node" && words[1] === "attempt-start") {
      const project = await requireProject(runtime, cwd);
      result = runtime.executions.startAttempt({ projectId: project.projectId, nodeId: words[2] ?? "", expectedTreeRevisionId: words[3] ?? "" });
    } else if (words[0] === "node" && words[1] === "verify") {
      const project = await requireProject(runtime, cwd);
      result = runtime.executions.beginVerification({ projectId: project.projectId, attemptId: words[2] ?? "", expectedStatus: "running" });
    } else if (words[0] === "node" && words[1] === "evidence") {
      const project = await requireProject(runtime, cwd);
      result = runtime.executions.attachEvidence({ projectId: project.projectId, attemptId: words[2] ?? "", requiredEvidenceKey: words[3] ?? "", traceEventId: words[4] ?? "" });
    } else if (words[0] === "node" && words[1] === "evaluate") {
      const project = await requireProject(runtime, cwd);
      const proposedVerdict = words[3];
      if (!proposedVerdict || !["succeeded", "failed", "blocked", "uncertain"].includes(proposedVerdict)) throw new HarnessError("invalid_input", "evaluation verdict is required");
      result = runtime.evaluations.evaluateAttempt({
        projectId: project.projectId,
        attemptId: words[2] ?? "",
        proposedVerdict: proposedVerdict as "succeeded" | "failed" | "blocked" | "uncertain",
        riskSummary: words.slice(4).join(" ") || null,
      });
    } else if (words[0] === "hook") {
      result = await runtime.hooks.ingest(mapClaudeHook(JSON.parse(await readStdin()) as unknown));
    } else if (words[0] === "mcp") {
      runtime.close();
      const { startMcpServer } = await import("../bindings/claude/mcp-server.js");
      await startMcpServer();
      return 0;
    } else {
      throw new HarnessError("invalid_input", "unknown command");
    }
    process.stdout.write(`${present(result, json)}\n`);
    return 0;
  } catch (error) {
    const harnessError = error instanceof HarnessError ? error : new HarnessError("storage_failure", error instanceof Error ? error.message : String(error));
    const output = { error: { code: harnessError.code, message: harnessError.message, details: harnessError.details ?? null } };
    process.stderr.write(`${present(output, true)}\n`);
    return 1;
  } finally {
    try { runtime.close(); } catch { /* MCP owns its runtime after dispatch. */ }
  }
}

async function requireProject(runtime: ReturnType<typeof openRuntime>, cwd: string) {
  const project = await runtime.projects.resolve(cwd, "inspect");
  if (project.status === "new_project") throw new HarnessError("project_not_registered", "current directory has no Harness project");
  if (project.status === "identity_conflict") throw new HarnessError("project_identity_conflict", "project marker conflicts with this path");
  return project;
}
