# Runtime Foundation Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a runnable Claude Code plugin that persists project-scoped Task Trees, workflow state, Trace facts, and Artifact projections in a global SQLite database.

**Architecture:** Domain rules remain pure; application services own use cases and transactions; SQLite repositories persist state; Claude hooks, MCP, and the CLI are thin bindings over the same services. The current working directory determines project isolation, while a marker preserves identity across moves.

**Tech Stack:** TypeScript ESM, Node.js 22.13+, built-in `node:sqlite`, Zod, MCP TypeScript SDK, Vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-09-18-runtime-foundation-design.md`

## Global Constraints

- Preserve the intentional deletion of the previous implementation; add only the new slice.
- Use tests before functional implementation and observe each new test fail for the expected reason.
- Never persist secrets or reveal records belonging to another project.
- Keep hook, MCP, and CLI code free of SQL and domain policy.
- Stage explicit paths only; never stage the unrelated deleted files with `git add -A`.

---

### Task 1: Toolchain and executable skeleton

**Files:** `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `scripts/build.ts`, `.gitignore`

- [ ] Create the Node 22 ESM package, TypeScript/Vitest configuration, and scripts for `typecheck`, `test`, `build`, `check`, and plugin validation.
- [ ] Bundle `src/cli/main.ts`, `src/bindings/claude/hook-entry.ts`, and `src/bindings/claude/mcp-server.ts` into `plugin/runtime/*.mjs` with esbuild.
- [ ] Verify dependency installation and an initially empty test run/build pipeline.

### Task 2: Deterministic domain contracts

**Files:** `src/domain/{errors,ids,project,task-tree,workflow,trace,artifact}.ts`, `tests/unit/{project,task-tree,workflow,trace}.test.ts`

- [ ] RED: test Windows/WSL/POSIX path normalization, leaf contracts, tree cycles/references, relation Artifact requirements, workflow transitions, redaction, and hook idempotency.
- [ ] GREEN: implement only the pure rules required by those tests.
- [ ] REFACTOR: centralize stable error codes and immutable view types; run unit tests and typecheck.

### Task 3: SQLite schema and transaction boundary

**Files:** `src/storage/{database,migrations,repositories}.ts`, `tests/integration/database.test.ts`

- [ ] RED: test migration idempotency, foreign keys, persisted/reopened state, immutable revision insertion, and rollback on failure.
- [ ] GREEN: implement the first migration and typed repository methods used by this slice.
- [ ] REFACTOR: canonicalize JSON and map SQLite busy/storage errors to stable application errors.

### Task 4: Project identity and isolation

**Files:** `src/application/project-identity-service.ts`, `tests/integration/project-identity.test.ts`

- [ ] RED: test inspect-without-write, first persisted marker/project, path alias reuse, ambiguous marker conflict, and exact-directory isolation.
- [ ] GREEN: implement `resolve(cwd, inspect|persist)` transactionally.
- [ ] REFACTOR: isolate filesystem marker I/O behind a narrow port and verify Windows/WSL aliases.

### Task 5: Task Tree revisions and readiness

**Files:** `src/application/task-tree-service.ts`, `tests/integration/task-tree-service.test.ts`

- [ ] RED: test project-scoped candidate ranking, initial complete draft, immutable change-set revision, stale base conflict, invalid leaf rejection, and relation Artifact readiness failure.
- [ ] GREEN: implement `listTaskTreeCandidates`, `createTaskRoot`, `saveDraftRevision`, `applyDraftChangeSet`, and `scanPlanReadiness`.
- [ ] REFACTOR: make revision writes atomic and return stable revision views.

### Task 6: Workflow and confirmation

**Files:** `src/application/workflow-service.ts`, `tests/integration/workflow-service.test.ts`

- [ ] RED: test stage ordering, optimistic revision conflicts, pending confirmation requirements, recorded user-answer evidence, atomic confirmation, and planned Artifact promotion.
- [ ] GREEN: implement workflow creation/transition, `createConfirmationPrompt`, and `confirmScope`.
- [ ] REFACTOR: keep evidence requirements in deterministic transition rules.

### Task 7: Hook ingestion and Artifact projection

**Files:** `src/bindings/claude/hook-mapper.ts`, `src/application/hook-ingestion-service.ts`, `tests/integration/hook-ingestion.test.ts`

- [ ] RED: test malformed envelopes, duplicate delivery, inactive ordinary events, mutation violations, secret redaction, successful/failed tool Trace, and file/command projections.
- [ ] GREEN: implement event mapping, relevance rules, append-only ingestion, and post-event projection.
- [ ] REFACTOR: ensure PreToolUse records intent without claiming success.

### Task 8: Tree-centered runtime queries

**Files:** `src/application/runtime-query-service.ts`, `tests/integration/runtime-query.test.ts`

- [ ] RED: test Snapshot/Summary/Detail richness, pagination, blockers/actions, and cross-project `not_found` behavior.
- [ ] GREEN: implement the four approved query APIs.
- [ ] REFACTOR: use explicit evidence IDs and stable cursors.

### Task 9: CLI binding

**Files:** `src/cli/{main,presenter}.ts`, `tests/integration/cli.test.ts`

- [ ] RED: invoke the real CLI against a temporary data home and assert JSON/human output, exit codes, and persistence.
- [ ] GREEN: implement `doctor`, project, taskroot, tree, trace, hook, and mcp dispatch over application services.
- [ ] REFACTOR: centralize argument parsing and structured error presentation.

### Task 10: MCP binding

**Files:** `src/bindings/claude/mcp-server.ts`, `tests/plugin/mcp.test.ts`

- [ ] RED: start the real stdio server and assert the exact approved tool list plus one create/query round trip.
- [ ] GREEN: register Zod schemas and map every tool to the shared application services.
- [ ] REFACTOR: ensure all calls derive project scope from the supplied/current cwd.

### Task 11: Claude plugin, hooks, and workflow Skills

**Files:** `plugin/.claude-plugin/plugin.json`, `plugin/.mcp.json`, `plugin/package.json`, `plugin/hooks/hooks.json`, `plugin/skills/*/SKILL.md`, `tests/plugin/plugin-contract.test.ts`

- [ ] RED: run baseline pressure scenarios without each Skill and record missing workflow behavior; add behavioral contract tests for plugin loading, hook execution, and MCP discovery.
- [ ] GREEN: add the five focused Skills one at a time, re-run each scenario, and add a self-contained plugin manifest/hook configuration.
- [ ] REFACTOR: keep Skills focused on judgment while deterministic rules remain code; verify all commands stay beneath `${CLAUDE_PLUGIN_ROOT}`.

### Task 12: End-to-end vertical slice

**Files:** `tests/e2e/runtime-foundation.test.ts`, `README.md`, `docs/acceptance.md`

- [ ] RED: specify a restart-persistent flow covering project registration, draft, readiness, confirmation, hook mutation, Artifact projection, and runtime queries.
- [ ] GREEN: connect any missing composition/root wiring and make the flow pass.
- [ ] REFACTOR: document exact Bash/WSL setup and Claude `--plugin-dir` smoke steps.
- [ ] Run `npm run check`, inspect `git diff --check`, and record any manual-only acceptance item honestly.
