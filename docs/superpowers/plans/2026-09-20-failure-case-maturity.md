# Failure Case Reproduction Maturity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Subagent delegation is intentionally disabled for this repository session.

**Goal:** Persist failed Execution Attempts as traceable L0 Failure Cases and support immutable, evidence-backed reproduction revisions that deterministically mature through L1 manual, L2 assisted, L3 automated, and L4 regression.

**Architecture:** `FailureCaseService` owns Failure Case identity, immutable reproduction revisions, validation facts, availability, and maturity policy. `EvaluationService` invokes a transaction-aware capture path only for an applied failed Evaluation. Reproduction authors describe how to reproduce; a distinct validation operation records externally observed RED/GREEN, Oracle, stability, and isolation evidence. Runtime code computes the highest permitted maturity and never trusts a prose assertion alone.

**Tech Stack:** TypeScript, Node.js built-in SQLite, Vitest, existing Claude MCP/Hook binding.

**Spec:** `docs/Self-Evolving-Agent-Harness-需求文档.md` sections 4.5, 5.12, 5.28, 7 Failure Case entities, 8.12, 8.18, and 10 acceptance criteria.

## Global Constraints

- Only an applied `failed` Evaluation may automatically create or update an L0 Failure Case.
- Failure Case deduplication is Project-scoped and based on a deterministic structured failure signature; every occurrence remains linked to its Attempt and Evaluation.
- Reproduction revisions and validation results are append-only.
- Manual completeness, automation, RED/GREEN, Oracle discrimination, repetition stability, and isolation are separate facts.
- L4 requires stable pre-fix RED, post-fix GREEN, a discriminative Oracle, repeat stability, sufficient isolation, and evidence references.
- `availability_status` is independent of maturity and may not silently lower or raise L0-L4.
- No API executes an arbitrary reproduction command in this slice. Commands are declarative; observed results must reference Trace or other persisted evidence.
- Every read and write is Project-scoped.

---

### Task 1: Failure maturity policy

**Files:**
- Create: `src/domain/failure-case.ts`
- Modify: `src/domain/errors.ts`
- Test: `tests/unit/failure-case.test.ts`

- [ ] Define maturity, availability, reproduction mode, validation verdict, isolation strategy, and quality input types.
- [ ] Write RED tests for structured reproduction completeness and the highest permitted L0-L4 maturity.
- [ ] Implement deterministic policy: observed → L0; complete manual → L1; assisted with sufficient executable coverage → L2; automated stable RED → L3; automated stable RED/GREEN plus all hard gates → L4.
- [ ] Reject missing evidence, impossible mode/field combinations, secret-like environment values, and maturity downgrade inputs.
- [ ] Run unit tests and typecheck; commit `feat: define failure reproduction maturity policy`.

### Task 2: Failure Case persistence

**Files:**
- Modify: `src/storage/migrations.ts`
- Modify: `tests/integration/database.test.ts`

- [ ] Write RED migration/restart tests for schema version 6.
- [ ] Add `failure_cases`, `failure_case_occurrences`, `failure_reproduction_revisions`, and `reproduction_validation_results` with Project/Task/Attempt/Evaluation foreign keys, immutable revision numbering, JSON evidence fields, status checks, and indexes.
- [ ] Ensure one Project-scoped structured signature maps to one Failure Case while multiple occurrences remain append-only.
- [ ] Run database tests and typecheck; commit `feat: persist failure case maturity records`.

### Task 3: Automatic L0 capture from Evaluation

**Files:**
- Create: `src/application/failure-case-service.ts`
- Modify: `src/application/evaluation-service.ts`
- Modify: `src/application/runtime.ts`
- Test: `tests/integration/failure-case-service.test.ts`
- Modify: `tests/integration/evaluation-service.test.ts`

- [ ] Write RED tests proving applied failed Evaluations create/reuse an L0 case and occurrence, while uncertain, stale, blocked, or unapplied conclusions do not.
- [ ] Implement `captureFailedEvaluationWithinTransaction` using node revision, normalized risk/failure summary, evidence, Artifact links, Attempt, and Evaluation.
- [ ] Create an immutable observed reproduction revision for the first occurrence and retain later occurrence links without overwriting the first source.
- [ ] Keep Evaluation write, lifecycle transition, and failure capture atomic.
- [ ] Run service/evaluation tests and typecheck; commit `feat: capture failure cases from evaluations`.

### Task 4: Reproduction revision and validation lifecycle

**Files:**
- Modify: `src/application/failure-case-service.ts`
- Test: `tests/integration/failure-reproduction.test.ts`

- [ ] Write RED tests for manual, assisted, and automated revisions; immutable numbering; malformed contracts; cross-Project references; evidence scoping; availability changes; no maturity downgrade; and duplicate validation idempotence.
- [ ] Implement append-only `addReproductionRevision`, requiring structured preconditions, environment manifest, fixture/setup/reproduction/cleanup steps, expected/actual result, Oracle, isolation, repeat policy, baseline references, and evidence appropriate to mode.
- [ ] Implement `validateReproduction`, which accepts structured observed verdicts and evidence refs, stores an immutable result, and applies the deterministic maturity policy.
- [ ] Keep maturity monotonic; keep flaky/environment-blocked/quarantined/obsolete separate via `setAvailability`.
- [ ] Run lifecycle tests and typecheck; commit `feat: validate failure reproduction maturity`.

### Task 5: Tree-centered queries and Claude tools

**Files:**
- Modify: `src/application/runtime-query-service.ts`
- Modify: `src/bindings/claude/mcp-server.ts`
- Modify: `tests/integration/runtime-query.test.ts`
- Modify: `tests/plugin/mcp.test.ts`

- [ ] Write RED tests for paginated Project/Tree/Node/maturity/availability filters and Failure Case detail navigation back to source Task Node, Attempt, Evaluation, revisions, validations, Artifact and Trace evidence.
- [ ] Add query methods `getFailureCases` and `getFailureCaseDetail`.
- [ ] Add MCP tools `harness_get_failure_cases`, `harness_get_failure_case_detail`, `harness_add_failure_reproduction`, and `harness_validate_failure_reproduction`.
- [ ] Require explicit evidence references and never execute `entry_command` through these tools.
- [ ] Run query/plugin tests and typecheck; commit `feat: expose failure case maturity workflow`.

### Task 6: Restart E2E, Skill guidance, and documentation

**Files:**
- Create: `tests/e2e/failure-case-maturity.test.ts`
- Modify: `plugin/skills/verification-reporting/SKILL.md`
- Modify: `README.md`
- Modify: `docs/acceptance.md`

- [ ] Write a restart E2E: fail an Attempt, observe automatic L0, add/validate manual L1, add/validate automated L3, record a later successful Attempt and post-fix evidence, validate L4, restart, and navigate all sources.
- [ ] Document that Agent-generated reproduction contracts require separate evidence-backed validation; L3/L4 are not prose judgments and containers are optional.
- [ ] Run `npm run check` and `claude plugin validate ./plugin`.
- [ ] Commit `docs: complete failure case maturity workflow` and review atomicity, deduplication, monotonic maturity, evidence scope, and Project isolation.
