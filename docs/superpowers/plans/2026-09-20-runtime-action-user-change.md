# Runtime Action, Drift Resolution, and User Change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the structured Runtime Action boundary that resolves blocking Plan Drift and records minor, scope, and priority User Change Requests without allowing natural-language intent to mutate Runtime State directly.

**Architecture:** A new `RuntimeActionService` validates Agent-proposed actions against the current Task Tree revision and deterministic safety policy. Low-risk user changes commit atomically; drift resolution and scope changes create typed Runtime Confirmation Prompts, then a recorded user-answer Trace atomically commits, rejects, or pauses the action. Existing branch confirmation remains owned by `WorkflowService`; generic action confirmation is a separate compatible path over the same prompt table.

**Tech Stack:** TypeScript, Node.js built-in SQLite, Vitest, existing Claude MCP/Hook binding.

**Spec:** `docs/Self-Evolving-Agent-Harness-需求文档.md` sections 5.18, 5.19, 7 (Runtime Action/User Change entities), 8.8-8.10, and 10 (acceptance criteria).

## Global Constraints

- Natural language may only propose a structured Runtime Action; code owns validation and state mutation.
- `resolve_plan_drift` and `scope_change` always require explicit confirmation.
- A confirmation answer must be a same-Project `UserPromptSubmit` Trace created after its prompt.
- A stale `expectedTreeRevisionId` returns `revision_conflict` without partial writes.
- Branch confirmation behavior and the existing MCP tools remain backward compatible.
- `minor_change` records a fact without changing the confirmed scope; `priority_change` changes selection only; `scope_change` stores a proposed document and does not activate it before confirmation.
- Rejecting a scope change preserves the old Task Tree revision and returns the affected node to a retryable state; an already-closed Attempt is never reopened.
- Accepting a scope change creates a new draft revision and returns the workflow to `task_tree_refinement`; execution still requires readiness and branch confirmation.

## Review Focus

- Multiple pending confirmations must never let a short answer authorize the wrong action; resolution always names a confirmation ID and validates its source Trace.
- A Project must not resolve another Project's action, Drift, User Change, prompt, node, or source-message Trace.
- Replaying the same answer must not create a second revision or a second resolution Trace.
- A stale scope-change proposal must become `revision_conflict` while leaving the newer tree untouched.
- Rejecting or pausing a high-risk action must not silently mark the affected Task Node as succeeded or restore a closed Attempt.

---

### Task 1: Runtime Action domain policy

**Files:**
- Create: `src/domain/runtime-action.ts`
- Modify: `src/domain/errors.ts`
- Test: `tests/unit/runtime-action.test.ts`

**Interfaces:**
- Produces: `RuntimeActionType`, `RuntimeActionRiskLevel`, `RuntimeActionStatus`, `RuntimeConfirmationAnswer`, `UserChangeType`, and `evaluateRuntimeActionSafety(input)`.
- `evaluateRuntimeActionSafety` returns `{ confirmationRequirement: "none" | "required"; promptType: "drift_resolution" | "change_confirmation" | null }`.

- [ ] **Step 1: Write failing policy tests**

  Cover `resolve_plan_drift` and `scope_change` as required confirmation, `minor_change` and `priority_change` as no confirmation, unsupported combinations as `invalid_input`, and empty reason/source Trace references as invalid.

- [ ] **Step 2: Run the domain test and confirm RED**

  Run: `npx vitest run tests/unit/runtime-action.test.ts`
  Expected: FAIL because `runtime-action.ts` does not exist.

- [ ] **Step 3: Implement deterministic enums and safety policy**

  Define exact values:

  ```ts
  export type RuntimeActionType = "resolve_plan_drift" | "record_user_change";
  export type UserChangeType = "minor_change" | "scope_change" | "priority_change";
  export type RuntimeConfirmationAnswer = "yes" | "no" | "pause";
  ```

  `resolve_plan_drift` always requires `drift_resolution`; `record_user_change` requires `change_confirmation` only for `scope_change`.

- [ ] **Step 4: Run domain tests and typecheck**

  Run: `npx vitest run tests/unit/runtime-action.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/domain/runtime-action.ts src/domain/errors.ts tests/unit/runtime-action.test.ts
  git commit -m "feat: define runtime action safety policy"
  ```

### Task 2: Runtime Action and User Change persistence

**Files:**
- Modify: `src/storage/migrations.ts`
- Modify: `tests/integration/database.test.ts`

**Interfaces:**
- Consumes: Task 1 enum values.
- Produces: migration v5 columns on `runtime_actions` and `runtime_confirmation_prompts`, plus `user_change_requests` and supporting indexes.

- [ ] **Step 1: Write failing migration and restart tests**

  Assert schema versions 1-5, legacy `runtime_actions` backfill to `status='committed'`, typed prompt metadata, User Change constraints, and persistence after reopen.

- [ ] **Step 2: Run database tests and confirm RED**

  Run: `npx vitest run tests/integration/database.test.ts`
  Expected: FAIL because migration v5 and `user_change_requests` are absent.

- [ ] **Step 3: Add migration v5**

  Extend `runtime_actions` with `action_type`, `target_type`, `target_id`, `expected_revision`, `reason`, `source_message_ref`, `risk_level`, `confirmation_requirement`, `confirmation_prompt_id`, `status`, and `committed_at`. Backfill legacy rows from `kind` and mark them committed.

  Extend `runtime_confirmation_prompts` with `prompt_type`, `related_task_node_id`, `related_artifact_ids_json`, `options_json`, and `runtime_action_id`. Preserve `branch_confirmation` as the default.

  Create `user_change_requests` with Project/Tree/Node scope, change type, source Trace, expected revision, summary, impact JSON, optional proposed document, optional priority target, prior node status, status, Runtime Action reference, timestamps, and indexes.

- [ ] **Step 4: Run database tests and typecheck**

  Run: `npx vitest run tests/integration/database.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/storage/migrations.ts tests/integration/database.test.ts
  git commit -m "feat: persist runtime actions and user changes"
  ```

### Task 3: Blocking Drift resolution flow

**Files:**
- Create: `src/application/runtime-action-service.ts`
- Modify: `src/application/runtime.ts`
- Modify: `src/application/plan-drift-service.ts`
- Test: `tests/integration/runtime-action-service.test.ts`

**Interfaces:**
- Produces: `RuntimeActionService.proposePlanDriftResolution(input)` and `RuntimeActionService.resolveConfirmation(input)`.
- `proposePlanDriftResolution` input includes `projectId`, `driftId`, `expectedTreeRevisionId`, `decision: "accepted" | "rejected" | "branch_cancelled"`, `reason`, and `sourceMessageTraceEventId`.
- `resolveConfirmation` input includes `projectId`, `confirmationId`, `answer`, and `answerTraceEventId`.

- [ ] **Step 1: Write failing Drift resolution tests**

  Cover proposal persistence, typed prompt creation, invalid/non-blocking Drift rejection, stale revision rejection, foreign Project rejection, early answer Trace rejection, pause preserving pending state, no rejecting without mutation, yes committing exactly once, and duplicate answer idempotence.

- [ ] **Step 2: Run the service test and confirm RED**

  Run: `npx vitest run tests/integration/runtime-action-service.test.ts`
  Expected: FAIL because `RuntimeActionService` does not exist.

- [ ] **Step 3: Implement proposal and confirmation transactions**

  Proposal validates the source `UserPromptSubmit` Trace, current Tree revision, blocking pending Drift, decision, and recommendation context. It writes `runtime_actions(status='pending_confirmation')`, a `drift_resolution` prompt with `yes/no/pause`, and Runtime State waiting metadata in one transaction.

  Resolution validates prompt/action/Trace scope and time. `pause` keeps action and Drift pending while setting Runtime State to paused. `no` rejects the action and leaves Drift pending. `yes` updates Drift resolution and user decision, writes a `plan_drift_resolved` Trace, commits the action, clears waiting state, and moves the node to `needs_revalidation`, `ready`, or `cancelled` for accepted, rejected, or branch-cancelled decisions respectively.

- [ ] **Step 4: Run service tests and typecheck**

  Run: `npx vitest run tests/integration/runtime-action-service.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/application/runtime-action-service.ts src/application/runtime.ts src/application/plan-drift-service.ts tests/integration/runtime-action-service.test.ts
  git commit -m "feat: resolve blocking plan drift"
  ```

### Task 4: User Change Request lifecycle

**Files:**
- Modify: `src/application/runtime-action-service.ts`
- Modify: `src/application/task-tree-service.ts`
- Test: `tests/integration/user-change-service.test.ts`

**Interfaces:**
- Produces: `RuntimeActionService.proposeUserChange(input)`.
- Input includes `projectId`, `treeId`, optional `nodeId`, `expectedTreeRevisionId`, `changeType`, `summary`, structured `changeImpact`, `sourceMessageTraceEventId`, optional `proposedDocument`, and optional `priorityTargetNodeId`.
- Produces: `TaskTreeService.applyDraftChangeSetWithinTransaction(input)` for atomic scope-change confirmation.

- [ ] **Step 1: Write failing User Change tests**

  Cover: minor change commits a record/Trace without changing Tree revision; priority change changes only `runtime_states.selected_node_id`; scope change requires a valid proposed document and node, aborts an active Attempt, creates one prompt, and leaves the current revision unchanged; no restores the old revision and makes the node retryable; yes applies exactly one new revision and returns workflow to `task_tree_refinement`; stale yes marks the action `revision_conflict`; all paths enforce Project isolation.

- [ ] **Step 2: Run User Change tests and confirm RED**

  Run: `npx vitest run tests/integration/user-change-service.test.ts`
  Expected: FAIL because User Change methods are absent.

- [ ] **Step 3: Add transaction-aware draft application**

  Refactor `TaskTreeService.applyDraftChangeSet` so the public method retains its transaction and a new `applyDraftChangeSetWithinTransaction` reuses validation/persistence without nesting SQLite transactions.

- [ ] **Step 4: Implement each User Change path**

  `minor_change` writes a committed action, applied User Change, and paired `user_change_request` Trace. `priority_change` additionally selects the validated target node without modifying node status. `scope_change` stores the proposed document and impact, aborts active work without reopening it later, sets the affected node to `pending_user_confirmation`, creates a typed prompt, and waits. Yes applies the proposed document and transitions the workflow to refinement; no keeps the original revision and moves the node to `ready` for a new Attempt.

- [ ] **Step 5: Run User Change, Task Tree, and Workflow tests**

  Run: `npx vitest run tests/integration/user-change-service.test.ts tests/integration/task-tree-service.test.ts tests/integration/workflow-service.test.ts`
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add src/application/runtime-action-service.ts src/application/task-tree-service.ts tests/integration/user-change-service.test.ts
  git commit -m "feat: apply structured user change requests"
  ```

### Task 5: Introspection and Claude MCP surface

**Files:**
- Modify: `src/application/runtime-query-service.ts`
- Modify: `src/bindings/claude/mcp-server.ts`
- Modify: `tests/integration/runtime-query.test.ts`
- Modify: `tests/plugin/mcp.test.ts`

**Interfaces:**
- Produces: `getWaitingItems(projectId, query)`, `getUserChangeRequests(projectId, query)`, and `getRuntimeActionDetail(projectId, actionId)`.
- Adds MCP tools `harness_get_waiting_items`, `harness_get_user_change_requests`, `harness_get_runtime_action_detail`, `harness_propose_plan_drift_resolution`, `harness_propose_user_change`, and `harness_resolve_runtime_confirmation`.

- [ ] **Step 1: Write failing query and MCP tests**

  Assert pagination and filters, pending confirmation count in Snapshot, typed waiting items, User Change summary, Runtime Action detail, exact 25-tool MCP surface, schema enums, create/resolve round trips, and no cross-Project IDs.

- [ ] **Step 2: Run query/plugin tests and confirm RED**

  Run: `npx vitest run tests/integration/runtime-query.test.ts tests/plugin/mcp.test.ts`
  Expected: FAIL because the methods and six tools are absent.

- [ ] **Step 3: Implement bounded project-scoped queries**

  Waiting items return prompt type, target, options, action status, and cursor. User Change queries filter by Tree, node, type, and status. Runtime Action detail includes its prompt and associated Drift/User Change but never raw data from another Project.

- [ ] **Step 4: Register the six MCP tools**

  Every tool resolves `cwd` through the existing Project binding. Proposal tools require `sourceMessageTraceEventId` and expected revision. Confirmation resolution requires explicit `confirmationId`; no tool infers a prompt from a short answer.

- [ ] **Step 5: Run query/plugin tests and typecheck**

  Run: `npx vitest run tests/integration/runtime-query.test.ts tests/plugin/mcp.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add src/application/runtime-query-service.ts src/bindings/claude/mcp-server.ts tests/integration/runtime-query.test.ts tests/plugin/mcp.test.ts
  git commit -m "feat: expose runtime actions and user changes"
  ```

### Task 6: Restart E2E, Skill guidance, and documentation

**Files:**
- Create: `tests/e2e/runtime-action-user-change.test.ts`
- Modify: `plugin/skills/drift-handling/SKILL.md`
- Modify: `README.md`
- Modify: `docs/acceptance.md`

**Interfaces:**
- Consumes: all Task 1-5 APIs.
- Produces: restart-persistent vertical-slice proof and Agent-facing usage guidance.

- [ ] **Step 1: Write the failing restart E2E test**

  Build and confirm a Tree, create a blocking Drift, propose/confirm resolution using two UserPromptSubmit Trace Events, record all three User Change types, restart Runtime, and assert action history, User Change history, final Tree revision, selected node, and waiting-state cleanup persist.

- [ ] **Step 2: Run E2E and confirm RED or missing guidance**

  Run: `npx vitest run tests/e2e/runtime-action-user-change.test.ts`
  Expected before final integration: FAIL until all persistence/query paths are complete.

- [ ] **Step 3: Update Skill and documentation**

  Explain that the Agent first queries Snapshot/Drift, then proposes a typed Runtime Action; `scope_change` and Drift resolution require confirmation; `minor_change` and `priority_change` commit without a second prompt; a scope-change yes returns to planning/refinement and never authorizes code execution directly.

- [ ] **Step 4: Run full verification**

  Run: `npm run check`
  Expected: all typechecks, tests, builds, and plugin contract checks pass.

  Run: `claude plugin validate ./plugin`
  Expected: `Validation passed`.

- [ ] **Step 5: Commit and review**

  ```bash
  git add tests/e2e/runtime-action-user-change.test.ts plugin README.md docs/acceptance.md
  git commit -m "docs: complete runtime action workflow"
  ```

  Review the entire slice for atomicity, project isolation, idempotent confirmation answers, stale revision behavior, and backward-compatible branch confirmation before declaring completion.
