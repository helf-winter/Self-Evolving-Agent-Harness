# Node Execution and Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add evidence-backed Task Node attempts, immutable evaluations, and deterministic lifecycle transitions to the existing Runtime Foundation.

**Architecture:** Pure domain functions define attempt/evaluation status and lifecycle policy. Application services validate project scope and own atomic transactions. SQLite stores append-only attempts, evidence, evaluations, and transition decisions; CLI/MCP/query layers remain thin bindings.

**Tech Stack:** TypeScript ESM, Node.js 22.13+ built-in `node:sqlite`, Zod 4, MCP TypeScript SDK, Vitest 5, esbuild.

**Spec:** `docs/superpowers/specs/2026-09-18-node-execution-evaluation-design.md`

## Global Constraints

- Preserve all existing Runtime Foundation behavior and Project isolation.
- Write and run each failing test before production implementation.
- Do not add Replacement, Evolution, Skill, Failure Case, or experiment infrastructure.
- Evaluation facts and lifecycle transition records are append-only.
- Evidence must be a real same-Project, same-Tree, same-Node Trace Event produced after attempt start.
- Keep SQL out of CLI, MCP, hooks, and pure domain modules.
- The inherited Runtime Foundation rewrite is intentionally uncommitted; use test checkpoints and do not create partial commits that omit its dependencies.

---

### Task 1: Required evidence contract and lifecycle policy

**Files:**
- Modify: `src/domain/task-tree.ts`
- Create: `src/domain/execution.ts`
- Create: `tests/unit/execution.test.ts`
- Modify: Task Tree fixtures under `tests/`

**Interfaces:**
- Produces: `RequiredEvidence`, `ExecutionAttemptStatus`, `EvaluationVerdict`, `TaskNodeExecutionStatus`, `decideLifecycleTransition(input)`.
- Consumes: current Task Node revision identity, evidence coverage, dependency/child readiness.

- [x] **Step 1: Write failing unit tests**

```ts
it("rejects duplicate required evidence keys", () => {
  expect(validateTaskTree(treeWithEvidence(["test", "test"])).ok).toBe(false);
});

it("keeps uncertain evaluations in verifying", () => {
  expect(decideLifecycleTransition({
    currentRevision: true, fromStatus: "verifying", verdict: "uncertain",
    evidenceComplete: false, dependenciesSucceeded: true, childrenSucceeded: true,
  })).toMatchObject({ applied: false, targetStatus: "verifying" });
});
```

- [x] **Step 2: Run the focused tests and observe missing API/behavior failures**

Run: `npx vitest run tests/unit/task-tree.test.ts tests/unit/execution.test.ts`

- [x] **Step 3: Implement the minimal pure domain model**

Replace planning-time `completionEvidence?: string[]` with:

```ts
export interface RequiredEvidence {
  key: string;
  description: string;
}

requiredEvidence?: RequiredEvidence[];
```

Implement `decideLifecycleTransition` with policy version
`task-node-lifecycle/v1`, including stale-revision, success, failure, blocked,
and uncertain behavior from the design.

- [x] **Step 4: Update existing fixtures and verify unit tests/typecheck**

Run: `npx vitest run tests/unit && npm run typecheck`

---

### Task 2: Persistence migration for execution facts

**Files:**
- Modify: `src/storage/migrations.ts`
- Modify: `tests/integration/database.test.ts`

**Interfaces:**
- Produces tables `execution_attempts`, `execution_attempt_evidence`, `evaluations`, and `lifecycle_transition_records`.
- Consumes migration runner semantics from `RuntimeDatabase`.

- [x] **Step 1: Write a failing migration test**

```ts
expect(database.all<{ version: number }>(
  "SELECT version FROM schema_migrations ORDER BY version",
)).toEqual([{ version: 1 }, { version: 2 }]);

expect(() => insertSecondActiveAttemptForSameNode(database)).toThrow();
```

- [x] **Step 2: Run the database test and observe migration/table failures**

Run: `npx vitest run tests/integration/database.test.ts`

- [x] **Step 3: Add migration 2**

Create foreign-keyed append-only fact tables, a unique attempt-number key, and
a partial unique active-attempt index on `task_node_id` for statuses `running`
and `verifying`.

- [x] **Step 4: Verify migration idempotency and rollback behavior**

Run: `npx vitest run tests/integration/database.test.ts`

---

### Task 3: Node execution application service

**Files:**
- Create: `src/application/node-execution-service.ts`
- Create: `tests/integration/node-execution-service.test.ts`
- Modify: `src/application/runtime.ts`
- Modify: `src/application/workflow-service.ts`

**Interfaces:**
- Produces: `startAttempt`, `beginVerification`, `attachEvidence`, `abortAttempt`.
- Consumes: active workflow stage, current node revision, Task Node dependency states, Trace Events.

- [x] **Step 1: Write failing attempt lifecycle tests**

```ts
const attempt = service.startAttempt({
  projectId: "p1", nodeId: "skeleton-node", expectedTreeRevisionId: "tr1",
});
expect(attempt).toMatchObject({ attemptNumber: 1, status: "running" });
expect(() => service.startAttempt({
  projectId: "p1", nodeId: "skeleton-node", expectedTreeRevisionId: "tr1",
})).toThrow(expect.objectContaining({ code: "attempt_already_active" }));
```

Add tests for wrong phase, unsatisfied dependency, second-attempt numbering,
cross-project evidence, pre-attempt evidence, and abort.

- [x] **Step 2: Run the focused test and observe missing service failures**

Run: `npx vitest run tests/integration/node-execution-service.test.ts`

- [x] **Step 3: Implement attempt start and phase/dependency checks**

Resolve the exact current `task_node_revision_id` by joining the Task Tree's
`current_revision_id`. Perform attempt insertion and node status mutation in one
transaction.

- [x] **Step 4: Implement verification, evidence linking, and abort**

Validate evidence ownership and timestamp before inserting a link. Use expected
attempt status to reject stale commands.

- [x] **Step 5: Make whole-tree confirmation mark current nodes ready**

Within the existing confirmation transaction, update current tree nodes from
`draft`/`pending_user_confirmation` to `ready`.

- [x] **Step 6: Verify integration tests and typecheck**

Run: `npx vitest run tests/integration/node-execution-service.test.ts tests/integration/workflow-service.test.ts && npm run typecheck`

---

### Task 4: Immutable evaluation and atomic lifecycle transition

**Files:**
- Create: `src/application/evaluation-service.ts`
- Create: `tests/integration/evaluation-service.test.ts`
- Modify: `src/application/runtime.ts`

**Interfaces:**
- Produces: `evaluateAttempt(input): { evaluation, transition }`.
- Consumes: `decideLifecycleTransition`, attempt evidence, current node revision, dependency/child state.

- [x] **Step 1: Write failing evaluation tests**

```ts
const result = service.evaluateAttempt({
  projectId: "p1", attemptId, proposedVerdict: "succeeded", riskSummary: null,
});
expect(result.evaluation.verdict).toBe("uncertain");
expect(result.transition).toMatchObject({ applied: false, targetStatus: "verifying" });
```

Add tests for failed/failed/succeeded history, stale revision rejection,
successful evidence coverage, parent explicit evaluation, and transaction rollback.

- [x] **Step 2: Run the focused tests and observe missing service failures**

Run: `npx vitest run tests/integration/evaluation-service.test.ts`

- [x] **Step 3: Implement evidence coverage and immutable Evaluation creation**

Load required evidence keys from the exact node revision, compare them with valid
attempt evidence links, and normalize incomplete proposed success to `uncertain`.

- [x] **Step 4: Apply lifecycle policy transactionally**

Insert Evaluation and transition record, then update attempt/node status only when
the policy decision applies. Preserve stale Evaluation history without succeeding
the current revision.

- [x] **Step 5: Verify integration tests and typecheck**

Run: `npx vitest run tests/integration/evaluation-service.test.ts && npm run typecheck`

---

### Task 5: Tree-centered query, CLI, and MCP surfaces

**Files:**
- Modify: `src/application/runtime-query-service.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/bindings/claude/mcp-server.ts`
- Modify: `tests/integration/runtime-query.test.ts`
- Modify: `tests/integration/cli.test.ts`
- Modify: `tests/plugin/mcp.test.ts`

**Interfaces:**
- Produces Task Node Detail fields `attempts` and `evaluations`, plus thin execution/evaluation commands and tools.
- Consumes `runtime.executions` and `runtime.evaluations` application services.

- [x] **Step 1: Write failing query and binding tests**

Assert that detail returns ordered attempt/evaluation history, CLI can start an
attempt with `--cwd`, and MCP advertises exactly the new execution tools.

- [x] **Step 2: Run focused tests and observe missing surface failures**

Run: `npx vitest run tests/integration/runtime-query.test.ts tests/integration/cli.test.ts tests/plugin/mcp.test.ts`

- [x] **Step 3: Implement paginated detail history**

Return compact immutable views without embedding complete Trace payloads into
attempt rows.

- [x] **Step 4: Add thin CLI and MCP bindings**

Expose:

```text
harness node attempt-start NODE_ID TREE_REVISION_ID
harness node verify ATTEMPT_ID
harness node evidence ATTEMPT_ID REQUIRED_KEY TRACE_EVENT_ID
harness node evaluate ATTEMPT_ID VERDICT
```

and equivalent `harness_*` MCP tools, all deriving Project from `cwd`.

- [x] **Step 5: Verify binding tests and typecheck**

Run: `npx vitest run tests/integration/runtime-query.test.ts tests/integration/cli.test.ts tests/plugin/mcp.test.ts && npm run typecheck`

---

### Task 6: End-to-end execution/evaluation restart flow

**Files:**
- Create: `tests/e2e/node-execution-evaluation.test.ts`
- Modify: `README.md`
- Modify: `docs/acceptance.md`

**Interfaces:**
- Consumes the public application composition and query APIs.
- Produces one restart-persistent acceptance path and updated manual smoke instructions.

- [x] **Step 1: Write the failing restart-persistent E2E test**

Build and confirm a tree, run an implementation node through two failed attempts
and one successful attempt with real Trace evidence, close/reopen the runtime, and
assert that all attempts, evaluations, final node status, and evidence remain.

- [x] **Step 2: Run the E2E test and observe missing wiring failures**

Run: `npx vitest run tests/e2e/node-execution-evaluation.test.ts`

- [x] **Step 3: Connect missing composition and document the flow**

Update user-facing command examples and make explicit that Evaluation is not an
LLM success declaration.

- [x] **Step 4: Run full verification**

Run: `npm run check`

- [x] **Step 5: Inspect workspace integrity**

Run: `git diff --check` and `git status --short`.
