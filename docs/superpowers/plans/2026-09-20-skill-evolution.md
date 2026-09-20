# Experience and Skill Evolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task. Subagent delegation remains disabled for this session.

**Goal:** Turn an evidence-backed failed → failed → succeeded Task Node history into a frozen Skill Candidate, validate it against quality-gated replay/variation/holdout/negative cases with baseline comparisons, and automatically promote only when every hard gate passes.

**Architecture:** `EvolutionService` owns deterministic eligibility, immutable Experience and Skill Candidate revisions, test-case quality state, validation runs/reports, and promotion. Agent-authored summaries, instructions, and test definitions are proposals; code verifies source history, split coverage, freeze-time holdout separation, evidence scope, repetitions, stability, risk, and comparison outcomes. Promotion updates only Skill lifecycle state and never rewrites source Evaluation/Trace/Failure facts.

**Spec:** SRS sections 4.5, 5.12, 7 Experience/Skill entities, 8.12, and Evolution acceptance criteria in section 10.

## Hard constraints

- Eligibility requires at least two applied failed Evaluations followed by one applied succeeded Evaluation on the same Task Node revision.
- One success may produce at most one Experience; source failures and success remain immutable links.
- A frozen candidate instruction cannot be edited. Changes create a new candidate revision.
- Holdout cases must be created after freeze through an API that does not receive the instruction snapshot.
- Test definition and test quality validation are separate operations with Project-scoped Trace evidence.
- Every candidate requires accepted `real_failure_replay`, `variation`, `holdout`, and `negative_applicability` cases.
- Baseline and skill-enabled runs are append-only, evidence-backed, and repeated at least three times per required case.
- Promotion fails if replay/holdout/negative/stability/discrimination gates fail or any enabled run reports a high-risk side effect.
- Passing reports promote automatically, per the approved SRS policy.

### Task 1: Evolution eligibility policy

Create `src/domain/evolution.ts` and `tests/unit/evolution.test.ts`. Define eligibility, test types, quality states, run modes/verdicts, risk levels, promotion verdict, and deterministic report policy. Test two-failure minimum, required splits, three repetitions, baseline discrimination, holdout/negative results, stability, and high-risk rejection. Commit `feat: define skill evolution policy`.

### Task 2: Evolution persistence

Add migration v7 and database tests for `experiences`, `skills`, `skill_candidate_revisions`, `skill_test_cases`, `skill_test_quality_results`, `skill_validation_runs`, and `skill_validation_reports`. Enforce immutable revision numbering, one Experience per success Evaluation, split/status enums, unique run repetition, and one current promoted revision per Skill. Commit `feat: persist skill evolution records`.

### Task 3: Experience and frozen candidate lifecycle

Create `EvolutionService`, register it in Runtime, and integrate successful Evaluation capture transactionally. Automatically create an eligible Experience only after two prior applied failures. Add `freezeSkillCandidate` for Agent-proposed trigger/instruction content backed by an eligible Experience. Test no single-success candidate, Project isolation, idempotence, immutable frozen revisions, and failed→failed→succeeded capture. Commit `feat: create eligible skill candidates`.

### Task 4: Test quality and validation runs

Add test-case proposal, independent quality validation, and evidence-backed run recording. Holdout creation must not accept candidate instruction and must occur after freeze. Quality requires schema, isolation, reproduction, Oracle, discrimination, stability, and correct split classification. Runs require accepted cases, explicit mode/repetition, Trace evidence after case acceptance, resource metrics, and side-effect risk. Commit `feat: record skill validation evidence`.

### Task 5: Reports, automatic promotion, queries, and MCP

Aggregate a deterministic report from stored tests/runs; compare no-skill baseline with skill-enabled outcomes; enforce all hard gates and promote automatically only on pass. Add Tree-centered Experience/Skill queries and MCP tools for eligibility, candidate freeze, test proposal/quality validation, run recording, report generation, and detail. Commit `feat: promote validated skill candidates`.

### Task 6: Restart E2E, Skill guidance, and docs

Add an E2E covering failed→failed→succeeded, Experience, frozen candidate, four splits, three baseline/enabled repetitions, automatic promotion, and restart recovery. Update verification Skill, README, and acceptance docs. Run `npm run check` and `claude plugin validate ./plugin`, review atomicity/leakage/project isolation, and commit `docs: complete skill evolution workflow`.
