# Task Node Replacement and Effect Disposal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task. Subagent delegation remains disabled for this session.

**Goal:** Make a stable Task Node replaceable through immutable candidate revisions, dependency-impact preview, explicit user confirmation, evidence-backed Effect disposal, candidate activation, dependent re-evaluation, and recoverable failure without overwriting prior facts.

**Architecture:** `ReplacementService` owns candidate/replacement lifecycle and coordinates existing Task Tree, Runtime Confirmation, Trace, Artifact Graph, and execution-state projections. Framework-neutral domain policy computes contract diffs, reverse dependency closure, disposal capability, and legal transitions. Agent-authored candidate content and disposal actions are proposals/observations; Runtime code validates Project scope, current revision, Effect ownership, baseline/version, shared targets, Trace timing, confirmation, and transactional activation. No Runtime tool executes arbitrary shell or external rollback operations.

**Spec:** SRS sections 2.4, 5.25, 7 Task Node Effect/Replacement Record, 8.15-8.16, 10 acceptance criteria, and 12.9.

## Hard constraints

- `task_node_id` remains stable; old Task Tree/Node revisions, Attempts, Evaluations, Trace, and Effect facts are immutable.
- Candidate creation does not change the active Task Tree revision.
- Preview deterministically returns contract diff, reverse dependency impact closure, Effect risk, and disposal capabilities.
- Replacement always requires a revision-bound Runtime Confirmation Prompt and explicit user-answer Trace.
- Affected dependents suspend in reverse dependency order; active attempts in the closure are blocked before disposal.
- `reversible`, `version_reversible`, `compensatable`, and `irreversible` Effects have distinct validated disposition rules.
- Version-reversible disposal requires unique ownership, matching target baseline/version, no conflicting active Effect, and post-confirmation Trace evidence.
- Compensation is never reported as rollback; irreversible Effects expose no automatic disposal path.
- Activation requires post-confirmation evidence. Missing requirements yield `pending_dependency`; removed/incompatible provided contracts yield dependent `needs_replanning`; compatible dependents enter revalidation.
- Activation failure preserves the old active revision and supports evidence-backed recovery; unrecoverable cases remain `replacement_failed`.
- All mutation sequences are transactional and Project-scoped.

### Task 1: Composition and disposal domain policy

Create `src/domain/composition.ts` and unit tests. Define contract diff/compatibility, reverse dependency closure ordering, composition states, Effect types/capabilities, disposition observations, replacement statuses, and deterministic disposal decisions. Commit `feat: define replacement composition policy`.

### Task 2: Replacement persistence

Add migration v8 and database tests for candidate revisions, revision contract bindings, composition-state records/history, Task Node Effects, immutable disposal results, and Replacement Records. Extend prompt/action enums only where required while retaining `high_risk_action` as the confirmation type. Commit `feat: persist task node replacement records`.

### Task 3: Effect registry and capability inspection

Create `ReplacementService`, register it in Runtime, and implement Project/revision-scoped Effect registration and disposal-capability queries. Require structured target/operation, type-specific inverse or compensation metadata, baseline data for version-reversible Effects, and Trace evidence after owner revision creation. Commit `feat: register revision owned effects`.

### Task 4: Candidate preview and confirmation

Implement immutable candidate creation, current contract derivation, contract binding validation, reverse impact closure from Task Relation Edges and Artifact Contract consumers, risk summary, Runtime Action, and revision-bound confirmation. On yes, atomically mark the replacement suspending, suspend dependents in reverse order, and block active Attempts; no/pause must not activate the candidate. Commit `feat: preview and confirm node replacement`.

### Task 5: Disposal, activation, dependency re-evaluation, and recovery

Implement evidence-backed disposition validation, activation evidence, atomic Task Tree revision creation, candidate contract projection, affected-node re-evaluation, immutable disposal results, and completed Replacement records. Implement failed activation and recover APIs that restore the old revision only with recovery evidence and otherwise preserve `replacement_failed`. Commit `feat: execute recoverable node replacement`.

### Task 6: Queries, MCP, E2E, Skill, and docs

Add Project/Tree/Node/status replacement queries and detail, Effect queries/capabilities, MCP tools for register/preview/confirm/execute/recover/detail, and a restart E2E proving version-safe completion plus failed activation recovery. Update drift/execution Skills, README, and acceptance docs. Run `npm run check`, `claude plugin validate ./plugin`, and `git diff --check`; review atomicity, Project isolation, confirmation binding, shared-target conflict handling, and compensation wording. Commit `docs: complete task node replacement workflow`.
