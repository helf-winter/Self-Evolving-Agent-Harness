# Task Tree Refinement Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task. Subagent delegation remains disabled for this session.

**Goal:** Implement SRS FR-027 as an evidence-linked, question-driven refinement loop with incomplete draft persistence, scoped deterministic readiness, structured Skeleton criteria, local/cross-branch impact handling, Decision Records, and planning Trace.

**Architecture:** Split structural validity from executable readiness in pure domain code. Extend `TaskTreeDocument` with planning context and Skeleton criteria. Migration v11 persists preview/impact/decision/readiness facts. `TaskTreeService` owns preview/apply/scan transactions; Runtime Query and Claude MCP expose bounded history.

**Spec:** `docs/superpowers/specs/2026-09-20-task-tree-refinement-design.md`; SRS sections 5.15, 5.16, 5.27, 7 Draft Change Set/Decision/Readiness/Skeleton, 8.17, and matching acceptance rows.

## Hard constraints

- Incomplete is valid draft state; broken topology/reference identity is not.
- Readiness is scoped; unrelated sibling-only issues do not block branch readiness.
- Priority is deterministic code policy, not LLM ranking.
- Semantic heuristics are warnings only.
- Every applied change binds a current base revision and a same-scope user message Trace.
- Cross-branch changes require a matching persisted preview.
- No-op discussion creates no Task Tree revision.
- Decision Records contain user-visible summaries, never hidden reasoning.
- Apply is atomic across Change Set, Decision Record, planning Trace, revision, and Skeleton projections.
- Existing confirmation/revision invalidation semantics remain intact.

### Task 1: Refinement and readiness domain policy

Add planning context/Skeleton types, structural validation, scoped issue generation,
deterministic priority, semantic warnings, and document impact diff with unit tests.
Commit `feat: define task refinement policy`.

### Task 2: Refinement persistence

Add migration v11 for previews, enriched Change Sets/Decision Records/Readiness
Results, and structured branch Skeleton criteria. Extend migration tests. Commit
`feat: persist task refinement decisions`.

### Task 3: TaskTreeService refinement loop

Allow incomplete structural drafts; persist structured Skeleton criteria; implement
preview, strict evidence-linked apply, no-op/stale/mismatch rejection, Decision
Record/planning Trace transaction, scoped readiness, and history/detail queries.
Add integration tests. Commit `feat: implement task refinement loop`.

### Task 4: Runtime/MCP/E2E/Skills/docs

Expose preview/apply/scan/history tools, update Task Tree Planning Skill, add
cross-restart E2E, README and acceptance instructions, then run `npm run check`,
`claude plugin validate ./plugin`, and `git diff --check`. Commit
`docs: complete task refinement workflow`.

