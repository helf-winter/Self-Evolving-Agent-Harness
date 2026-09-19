# Artifact Graph and Plan Drift Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the revisioned Artifact Graph and evidence-backed Plan Drift foundation required by the SRS.

**Architecture:** Extend the planning document and database projection first, then promote branch-local baselines, project Hook facts with provenance, add a dedicated Drift service, and integrate Drift into Evaluation and Runtime queries. Semantic drift remains an explicit Runtime action; Hooks automate only deterministic locator/scope cases.

**Tech Stack:** TypeScript, Node.js built-in SQLite, Vitest, existing Claude MCP/Hook binding.

**Spec:** `docs/superpowers/specs/2026-09-19-artifact-drift-design.md`

## Global Constraints

- Artifact Graph stores current engineering state; Trace stores append-only event facts.
- Every Artifact state/relation change has a source Trace Event or planning revision.
- No full-project AST or symbol scan is introduced.
- Blocking Drift pauses execution but is not itself a failed Evaluation.
- Legacy Artifact inputs and the existing 15 MCP tools remain compatible.

## Review Focus

- A branch confirmation must not promote sibling-only or unlinked draft Artifacts.
- Replaying a Hook delivery must not duplicate Trace, Artifact relations, or Drift records.
- A mutation matching the node's planned Artifact must not be classified as unexpected Drift.
- Blocking Drift must prevent success even when all required evidence is attached.
- Project-scoped queries must never expose another project's Artifact or Drift IDs.

---

### Task 1: Artifact planning domain contracts

**Files:** Create `src/domain/artifact-graph.ts`, modify `src/domain/artifact.ts`, `src/domain/task-tree.ts`, and tests under `tests/unit/`.

**Produces:** extended Artifact inputs, link/relation/contract inputs, normalization helpers, and deterministic validation errors.

- [ ] Write failing tests for adaptive granularity defaults, invalid references, contract carrier/provider/consumer rules, and strong Task Relation Artifact binding.
- [ ] Run targeted tests and verify the new contracts are absent.
- [ ] Implement minimal types, normalization, and validation integration.
- [ ] Run domain tests and verify green.
- [ ] Commit.

### Task 2: Artifact Graph persistence and revision projection

**Files:** Modify `src/storage/migrations.ts`, `src/application/task-tree-service.ts`, and database/Task Tree integration tests.

**Produces:** migration v4 plus revision-scoped Artifact links, relations, and contracts with planning provenance.

- [ ] Write failing migration and projection tests, including legacy backfill and restart persistence.
- [ ] Run targeted tests and confirm missing schema/projection failures.
- [ ] Implement migration and Task Tree revision projection transactionally.
- [ ] Run database and Task Tree tests.
- [ ] Commit.

### Task 3: Branch-local Artifact baseline promotion

**Files:** Modify `src/application/workflow-service.ts` and workflow integration tests.

**Produces:** confirmation promotion limited to Artifacts linked to covered nodes.

- [ ] Write failing tests for branch-local, whole-tree, and unlinked Artifact promotion.
- [ ] Run workflow tests and verify current all-or-nothing behavior fails.
- [ ] Implement link-scoped promotion with baseline metadata.
- [ ] Run workflow tests.
- [ ] Commit.

### Task 4: Trace-backed Artifact projection

**Files:** Modify `src/application/hook-ingestion-service.ts`, `src/domain/trace.ts` if needed, and Hook integration tests.

**Produces:** Artifact IDs in Trace payload, current status/provenance projection, idempotent facts, and verification-command status.

- [ ] Write failing tests for created/modified/verified/failed states, source Trace IDs, and duplicate delivery.
- [ ] Run Hook tests and verify projection gaps.
- [ ] Implement projection before Trace insert within the existing transaction.
- [ ] Run Hook tests.
- [ ] Commit.

### Task 5: Plan Drift records and execution pause

**Files:** Create `src/application/plan-drift-service.ts`, modify `src/application/runtime.ts`, `src/application/hook-ingestion-service.ts`, and add integration tests.

**Produces:** explicit Drift recording, deterministic automatic unexpected-Artifact detection, paired Trace, and blocking pause behavior.

- [ ] Write failing tests for info/warning/blocking records, required recommendation, planned-locator non-drift, sibling-plan blocking drift, and active-attempt pause.
- [ ] Run targeted tests and verify missing service/behavior.
- [ ] Implement the service and Hook integration.
- [ ] Run targeted tests.
- [ ] Commit.

### Task 6: Evaluation and introspection integration

**Files:** Modify `src/application/evaluation-service.ts`, `src/application/runtime-query-service.ts`, `src/bindings/claude/mcp-server.ts`, related tests, and `README.md`.

**Produces:** blocking-Drift Evaluation gate, Artifact/Drift Summary and Detail tools, MCP exposure, and documented runtime flow.

- [ ] Write failing Evaluation, query, MCP, and restart E2E tests.
- [ ] Run tests and verify absent gates/tools.
- [ ] Implement query services, MCP tools, Evaluation check, and documentation.
- [ ] Run `npm run check` and `claude plugin validate ./plugin`.
- [ ] Commit and complete final review.
