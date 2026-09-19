# Branch Confirmation and Mixed Confirmation State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make branch-scoped confirmation revision-safe, queryable, and mandatory before Task Node execution.

**Architecture:** Add a pure scope/projection domain module, persist immutable decisions plus revision-scoped projections, and integrate those projections into readiness, workflow, execution, and query services. Preserve the current whole-tree API as a compatibility path while allowing a branch root to define a smaller scope.

**Tech Stack:** TypeScript, Node.js built-in SQLite, Vitest, existing Claude plugin/MCP binding.

**Spec:** `docs/superpowers/specs/2026-09-19-branch-confirmation-design.md`

## Global Constraints

- Bash remains the priority execution environment, while tests must continue to run on the current Windows host.
- Confirmation is evidence-backed and revision-bound; it must never be inferred from an old prompt.
- Execution status and confirmation state remain separate concepts.
- Existing whole-tree confirmation callers remain supported.
- No new third-party runtime dependency is introduced.

## Review Focus

- A branch root that does not exist must fail without creating readiness or confirmation rows.
- A scope result or prompt from an older tree revision must not confirm a newer revision.
- A confirmed node with a dependency outside its confirmed scope must remain non-executable.
- Editing one confirmed branch must not invalidate an unrelated confirmed sibling.
- Whole-tree confirmation must still advance the workflow and plan draft Artifacts.

---

### Task 1: Scope and projection domain rules

**Files:**
- Create: `src/domain/confirmation.ts`
- Create: `tests/unit/confirmation.test.ts`

**Interfaces:**
- Consumes: `TaskTreeDocument` and node IDs.
- Produces: `ConfirmationState`, `resolveConfirmationScope(document, rootNodeId?)`, and `deriveConfirmationStates(document, confirmedNodeIds, pendingNodeIds)`.

- [ ] **Step 1: Write failing tests** for tree scope, descendant branch closure, unknown roots, ancestor partial state, and pending-over-draft precedence.
- [ ] **Step 2: Run** `npx vitest run tests/unit/confirmation.test.ts` and verify missing-module failure.
- [ ] **Step 3: Implement** the pure domain functions with cycle-safe traversal and deterministic node-order output.
- [ ] **Step 4: Run** `npx vitest run tests/unit/confirmation.test.ts` and verify all cases pass.
- [ ] **Step 5: Commit** domain rules and tests.

### Task 2: Revision-scoped confirmation persistence

**Files:**
- Modify: `src/storage/migrations.ts`
- Modify: `tests/integration/database.test.ts`

**Interfaces:**
- Consumes: migration runner in `RuntimeDatabase`.
- Produces: scope columns, `scope_confirmation_records`, and `task_node_confirmation_states`.

- [ ] **Step 1: Write failing migration assertions** for new tables, indexes, constraints, and backfilled current nodes.
- [ ] **Step 2: Run** `npx vitest run tests/integration/database.test.ts` and verify missing-schema failure.
- [ ] **Step 3: Add migration version 3** with nullable compatibility columns, immutable record table, projection table, indexes, and conservative backfill.
- [ ] **Step 4: Run** the database test and verify it passes.
- [ ] **Step 5: Commit** the schema change.

### Task 3: Scoped readiness and revision carry-forward

**Files:**
- Modify: `src/application/task-tree-service.ts`
- Modify: `tests/integration/task-tree-service.test.ts`

**Interfaces:**
- Consumes: `resolveConfirmationScope` and `deriveConfirmationStates`.
- Produces: `scanPlanReadiness({ projectId, treeId, scopeRootNodeId? })` with persisted scope metadata and revision-aware projection carry-forward.

- [ ] **Step 1: Write failing tests** for branch readiness, unknown roots, and preserving an unchanged sibling while invalidating a changed confirmed branch.
- [ ] **Step 2: Run** the targeted test and confirm failures reflect missing scoped behavior.
- [ ] **Step 3: Implement** scoped readiness plus projection copy/recompute inside the existing revision transaction.
- [ ] **Step 4: Run** the targeted tests and then all Task Tree unit/integration tests.
- [ ] **Step 5: Commit** readiness and revision behavior.

### Task 4: Branch prompt and acceptance workflow

**Files:**
- Modify: `src/application/workflow-service.ts`
- Modify: `tests/integration/workflow-service.test.ts`

**Interfaces:**
- Consumes: a current ready result and exact scope.
- Produces: revision-bound prompts, immutable accepted records, mixed confirmation projections, dependency blocking, and whole-tree workflow advancement.

- [ ] **Step 1: Write failing tests** for partial branch confirmation, external unconfirmed dependency blocking, stale readiness/prompt rejection, rejection behavior, and whole-tree compatibility.
- [ ] **Step 2: Run** the workflow tests and verify the new cases fail for missing behavior.
- [ ] **Step 3: Implement** prompt binding, transactional acceptance, projection derivation, node execution-status synchronization, and full-tree transition detection.
- [ ] **Step 4: Run** workflow tests and verify every case passes.
- [ ] **Step 5: Commit** workflow behavior.

### Task 5: Execution gate and runtime queries

**Files:**
- Modify: `src/application/node-execution-service.ts`
- Modify: `src/application/runtime-query-service.ts`
- Modify: `tests/integration/node-execution-service.test.ts`
- Modify: `tests/integration/runtime-query.test.ts`

**Interfaces:**
- Consumes: `task_node_confirmation_states` for the current tree revision.
- Produces: hard execution gating, per-node confirmation state, and aggregate counts in the runtime snapshot/summary.

- [ ] **Step 1: Write failing tests** proving unconfirmed ready nodes cannot start, confirmed nodes can start, and query responses expose mixed state.
- [ ] **Step 2: Run** both targeted test files and verify failures arise from missing confirmation behavior.
- [ ] **Step 3: Join current confirmation state** into executable-node lookup and query projections; preserve compatibility for legacy databases through migration backfill.
- [ ] **Step 4: Run** targeted tests and verify them green.
- [ ] **Step 5: Commit** execution and query integration.

### Task 6: Binding compatibility and end-to-end verification

**Files:**
- Modify: `src/bindings/claude/mcp-server.ts`
- Modify: `tests/plugin/mcp.test.ts`
- Create: `tests/e2e/branch-confirmation.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: extended readiness and prompt service inputs.
- Produces: optional `scopeRootNodeId`/`readinessResultId` MCP fields and a documented branch-confirmation flow.

- [ ] **Step 1: Write failing MCP and end-to-end tests** that confirm one branch, observe sibling isolation after restart, and reject execution outside the confirmed branch.
- [ ] **Step 2: Run** the new tests and verify they fail for the absent binding support.
- [ ] **Step 3: Extend MCP schemas/handlers and document the flow** while retaining existing whole-tree parameters.
- [ ] **Step 4: Run** `npm run check` and `claude plugin validate ./plugin`; inspect zero failures.
- [ ] **Step 5: Commit** the completed vertical slice.
