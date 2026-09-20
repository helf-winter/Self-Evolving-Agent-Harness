# Task Tree Collection Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagent delegation remains disabled for this session.

**Goal:** Complete SRS FR-002 so one Project can safely create, discover, select, archive, restore, and resume multiple Task Trees without deleting lifecycle evidence.

**Architecture:** Add immutable collection transitions and reversible archive metadata to the global SQLite schema. `TaskTreeService` owns atomic selection/archive/restore projection changes while existing workflow and execution services continue to require the one active workflow. Expose the same Project-scoped semantics through CLI and Claude MCP.

**Tech Stack:** TypeScript, Node.js `node:sqlite`, Vitest, MCP SDK/Zod, Claude plugin Hooks/Skills

**Spec:** `docs/superpowers/specs/2026-09-21-task-tree-collection-lifecycle-design.md`

## Global Constraints

- Task Collection belongs to Project, never to a session.
- Runtime Records stay in the shared global database; project directories receive no `.harness` data.
- Archive is reversible metadata, never entity deletion or revision rewriting.
- Exactly one workflow may be active per Project; Runtime selection and active workflow must agree.
- A running/verifying Attempt must be explicitly completed or aborted before switching or archiving its tree.
- All APIs resolve and enforce current `project_id`; cross-Project IDs return `not_found`.

## Review Focus

- A second root in one Project must not violate the partial unique active-workflow index.
- An empty or textual candidate query must obey the five/all and three/ranked deterministic limits without leaking archived or foreign trees.
- Archiving or switching away from a tree with an active Attempt must leave every projection unchanged.
- Restoring a tree must recover its exact prior status but must not reactivate it or revive Attempts.
- Project Clone must retain archive metadata while creating a fresh, non-running Runtime selection.

---

### Task 1: Collection schema and policy

**Files:**
- Create: `src/domain/task-collection.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `tests/integration/database.test.ts`
- Create: `tests/unit/task-collection.test.ts`

**Interfaces:**
- Produces: `TaskTreeCollectionAction`, `TaskTreeCollectionTransitionView`, `restoredTaskTreeStatus(archivedFromStatus)` and migration v13 fields/table.

- [ ] **Step 1: Write failing tests** for migration v13 defaults, transition constraints, and fallback restoration (`null`, empty, or `archived` restores as `draft`; valid values restore unchanged).
- [ ] **Step 2: Run tests to verify RED:** `npm test -- --run tests/integration/database.test.ts tests/unit/task-collection.test.ts` must fail because v13 and the domain policy do not exist.
- [ ] **Step 3: Implement migration v13** with `task_trees.archived_at`, `task_trees.archived_from_status`, and immutable `task_tree_collection_transitions` whose action is `selected | archived | restored`.
- [ ] **Step 4: Implement the domain policy** with literal action/status result types and a pure restoration function; no database access belongs in this file.
- [ ] **Step 5: Verify GREEN** with the same test command and `npm run typecheck`.
- [ ] **Step 6: Commit** as `feat: define task tree collection lifecycle`.

### Task 2: Atomic collection service

**Files:**
- Modify: `src/application/task-tree-service.ts`
- Modify: `src/application/project-clone-service.ts`
- Modify: `tests/integration/task-tree-service.test.ts`
- Modify: `tests/integration/project-clone-service.test.ts`

**Interfaces:**
- Consumes: migration v13 and `TaskTreeCollectionTransitionView`.
- Produces:
  - `listTaskTreeCandidates({ projectId, query?, includeArchived? })`
  - `selectTaskTree({ projectId, treeId })`
  - `archiveTaskTree({ projectId, treeId })`
  - `restoreTaskTree({ projectId, treeId })`

- [ ] **Step 1: Write failing integration tests** proving two roots coexist, the new root is selected, old workflow is inactive, candidate limits are deterministic, archived trees are hidden by default, and explicit archived lookup works.
- [ ] **Step 2: Add failing transition tests** proving select/archive are atomic, active Attempts reject the operation, restore keeps the tree inactive, repeated/foreign transitions reject, revisions remain unchanged, and archived trees reject draft/refinement/readiness mutation.
- [ ] **Step 3: Run tests to verify RED:** `npm test -- --run tests/integration/task-tree-service.test.ts tests/integration/project-clone-service.test.ts`.
- [ ] **Step 4: Implement collection methods** in one database transaction: validate ownership/status, guard active Attempts, update workflow activity and runtime selection, append a transition, and return the resulting projection.
- [ ] **Step 5: Update `createTaskRoot`** to guard the selected tree's active Attempt, deactivate its workflow, create/select the new tree, and append a `selected` transition without violating the unique index.
- [ ] **Step 6: Apply archive guards** to draft save, change-set preview/apply, refinement apply, and readiness scan while keeping historical `getRevision` readable.
- [ ] **Step 7: Preserve archive metadata in Project Clone** and keep cloned Runtime state fresh/paused according to existing clone policy.
- [ ] **Step 8: Verify GREEN** with the same integration tests and `npm run typecheck`.
- [ ] **Step 9: Commit** as `feat: manage task tree collections`.

### Task 3: CLI and Claude MCP binding

**Files:**
- Modify: `src/cli/main.ts`
- Modify: `src/bindings/claude/mcp-server.ts`
- Modify: `tests/integration/cli.test.ts`
- Modify: `tests/plugin/mcp.test.ts`

**Interfaces:**
- Consumes: the four TaskTreeService collection APIs.
- Produces: `tree candidates --include-archived`, `tree select TREE_ID`, `tree archive TREE_ID`, `tree restore TREE_ID`, plus `harness_select_task_tree`, `harness_archive_task_tree`, and `harness_restore_task_tree`.

- [ ] **Step 1: Write failing CLI and MCP tests** that invoke all three transitions, inspect `includeArchived`, assert schemas, and verify foreign/archived selection errors are structured.
- [ ] **Step 2: Run tests to verify RED:** `npm test -- --run tests/integration/cli.test.ts tests/plugin/mcp.test.ts`.
- [ ] **Step 3: Implement CLI parsing and handlers** without introducing a separate collection store or session-owned state.
- [ ] **Step 4: Register the three MCP tools** and extend candidates with `includeArchived`; resolve Project exclusively from `cwd`.
- [ ] **Step 5: Verify GREEN** with the same tests and `npm run typecheck`.
- [ ] **Step 6: Commit** as `feat: expose task tree collection controls`.

### Task 4: Restart acceptance and documentation

**Files:**
- Create: `tests/e2e/task-tree-collection-lifecycle.test.ts`
- Modify: `README.md`
- Modify: `docs/acceptance.md`

**Interfaces:**
- Consumes: service, CLI, and MCP collection controls.
- Produces: the executable FR-002 acceptance path and user-facing operational guidance.

- [ ] **Step 1: Write a failing E2E** that creates two trees, switches, archives one, restarts Runtime, restores it, verifies old revisions/Trace remain, and confirms restoration did not select or reactivate the tree.
- [ ] **Step 2: Run the E2E to verify RED:** `npm test -- --run tests/e2e/task-tree-collection-lifecycle.test.ts`.
- [ ] **Step 3: Complete any missing persistence behavior** required by the E2E, with the smallest production change.
- [ ] **Step 4: Update README and acceptance** with collection semantics, commands/tools, active-Attempt gate, and restart steps; update the vertical-slice and MCP tool counts.
- [ ] **Step 5: Run full verification:** `npm run check`, `git diff --check`, and `claude plugin validate ./plugin` on Claude Code 2.1.251+; record the known local 2.1.220 validator limitation if the host remains old.
- [ ] **Step 6: Commit** as `docs: complete task tree collection lifecycle`.
