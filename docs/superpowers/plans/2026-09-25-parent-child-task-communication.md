# Parent–Child Task Communication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and superpowers:test-driven-development task-by-task. Subagent delegation remains disabled for this session.

**Goal:** Complete FR-005 with deterministic current-revision Child Task Reports and a parent verification gate that preserves independent parent Evaluation.

**Architecture:** Extend the existing tree-centered query projection rather than persisting duplicate reports. Add one deterministic execution guard for non-leaf verification nodes. Reuse the existing MCP node-detail tool and pagination conventions.

**Spec:** `docs/superpowers/specs/2026-09-25-parent-child-task-communication-design.md`

### Task 1: Child report projection

**Files:**
- Modify: `src/application/runtime-query-service.ts`
- Modify: `src/bindings/claude/mcp-server.ts`
- Modify: `tests/integration/runtime-query.test.ts`
- Modify: `tests/plugin/mcp.test.ts`

- [ ] Write failing tests for current-revision child reports, latest applicable Evaluation and policy result, evidence coverage, Artifact/Trace/Drift counts, deterministic summary, pagination, and Project isolation.
- [ ] Add `childLimit` / `childCursor` to Task Node Detail and MCP schema.
- [ ] Implement a one-hop derived projection with no new persistence table.
- [ ] Run focused tests and typecheck.
- [ ] Commit as `feat: derive child task reports`.

### Task 2: Parent verification execution gate

**Files:**
- Modify: `src/application/node-execution-service.ts`
- Modify: `tests/integration/node-execution-service.test.ts`

- [ ] Write failing tests proving a non-leaf verification node cannot start before every current-revision direct child succeeds, while a leaf and skeleton-phase node remain unaffected.
- [ ] Implement the deterministic current-revision child gate before any Attempt or Runtime mutation.
- [ ] Run focused tests and typecheck.
- [ ] Commit as `feat: gate parent verification on child results`.

### Task 3: Restart acceptance and documentation

**Files:**
- Create: `tests/e2e/parent-child-task-communication.test.ts`
- Modify: `README.md`
- Modify: `docs/acceptance.md`

- [ ] Add an E2E covering child completion, restart, derived reports, parent Attempt, parent evidence, and independent parent Evaluation.
- [ ] Document the derived-report boundary and parent verification workflow.
- [ ] Run `npm run check`, `git diff --check`, and the supported Claude plugin validator when Claude Code 2.1.251+ is available.
- [ ] Commit as `docs: complete parent child task communication`.
