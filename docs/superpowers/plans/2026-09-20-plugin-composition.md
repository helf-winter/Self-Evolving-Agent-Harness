# Plugin Composition Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task. Subagent delegation remains disabled for this session.

**Goal:** Implement SRS FR-026 as a framework-neutral, installation-scoped Plugin composition runtime with stable identity, immutable revisions, deterministic provides/requires resolution, lifecycle-owned registrations/effects, and evidence-backed replacement/recovery.

**Architecture:** Add pure Plugin manifest/contract validation and dependency-closure policy beside the existing Task Node composition policy. Migration v10 persists normalized global Plugin composition facts. A single `PluginCompositionService` owns registration, fixed-point reconciliation, replacement, disposal, and recovery transactions. Runtime queries and Claude MCP expose auditable state but never load code or execute stored operations.

**Spec:** `docs/superpowers/specs/2026-09-20-plugin-composition-design.md`; SRS sections 5.26, 8.15, 8.16, 9, and the Plugin spatial/temporal composition acceptance rows.

## Hard constraints

- Plugin IDs are stable; revisions are immutable and unique per Plugin.
- Plugin composition is installation-scoped and is not cloned with a Project.
- Provides/requires resolution is deterministic exact matching in v1.
- Only active revisions provide contracts.
- Every dynamic registration declares a disposer.
- Stored operation/disposer strings are declarative and are never executed.
- Effect disposal uses the existing four effect classes and baseline/ownership rules.
- Preview never changes the active revision.
- Execute is atomic: no partial current-revision switch.
- Failed activation preserves the old revision when safe; unsafe recovery is explicit.
- Missing providers pause consumers and provider restoration deterministically reactivates them.
- Core code and schema expose no Cordis-specific type.

### Task 1: Plugin composition domain policy

Add manifest normalization/validation, contract diff, deterministic dependency closure, registration disposition, and Plugin lifecycle types with unit tests. Commit `feat: define plugin composition contract`.

### Task 2: Plugin composition persistence

Add migration v10 with Plugin, immutable revision, contracts, registrations, effects, dependency edges, transitions, replacements, and disposal results. Extend migration tests for constraints, uniqueness, and upgrades. Commit `feat: persist plugin composition lifecycle`.

### Task 3: Registration and fixed-point reconciliation

Implement Plugin revision registration, exact provides/requires resolution, activation, pending dependency, provider-loss suspension, provider restoration, transition facts, and list/detail queries. Add integration tests. Commit `feat: reconcile plugin dependencies`.

### Task 4: Replacement, disposal, and recovery

Implement preview, reverse impact closure, evidence-backed registration/effect disposal, atomic activation, baseline/shared-owner conflicts, activation failure, safe old-revision preservation, explicit recovery, and Plugin disposal. Add integration tests. Commit `feat: replace composed plugin revisions`.

### Task 5: Runtime binding, E2E, Skills, and docs

Wire the service into `openRuntime`, add Claude MCP tools and contract tests, add restart E2E, update Skills/README/acceptance, and run `npm run check`, `claude plugin validate ./plugin`, and `git diff --check`. Commit `docs: complete plugin composition workflow`.

