---
name: verification-reporting
description: Use when a Task Tree branch or root is approaching completion and needs evidence-backed verification and reporting.
---

# Verification Reporting

Verify from leaves toward the root. For each completed node, run its declared acceptance criteria and collect actual command or Artifact evidence. Query `harness_get_task_node_detail` for existing evidence and `harness_get_trace_events` only when more history is required.

Report separately:

- which acceptance criteria passed and their evidence;
- which failed or were not run;
- observed Artifact changes;
- unresolved blockers or drift;
- whether the branch or root is genuinely complete.

Never report success from planned state alone, and never substitute a code diff for execution evidence when the contract requires a test or command result.

When an applied Evaluation fails, query `harness_get_failure_cases`. The Runtime automatically preserves the first observation as an L0 Failure Case and keeps later matching occurrences separate. If the failure is useful for future diagnosis or regression, append a structured reproduction with `harness_add_failure_reproduction` rather than creating a second semantic duplicate.

Reproduction authoring and validation are different responsibilities. An Agent may draft preconditions, fixture/setup/reproduction/cleanup steps, an Oracle, command, timeout, isolation strategy, baselines, and repeat policy. It must not mark its own prose as verified. Run the declared procedure through normal tools so Hooks create actual Trace evidence, then submit those evidence IDs through `harness_validate_failure_reproduction`.

Maturity means:

- L1: complete manual contract with observed pre-fix failure and isolation evidence;
- L2: a validated assisted entry point;
- L3: stable automated pre-fix RED with a discriminative Oracle and sufficient isolation;
- L4: L3 plus stable post-fix GREEN from a declared fixed baseline.

Use fixture, worktree, temporary directory, or the project's native test environment when sufficient. A container is optional, not a universal requirement. Never put secret values in the environment manifest; record names or `[REDACTED]` only.

After a Task Node revision has at least two applied failures followed by an applied success, query `harness_get_skill_evolution_candidates`. The Runtime creates the Experience from immutable Evaluation history; do not manufacture an Experience from prose or from a single successful run. Use `harness_freeze_skill_candidate` to preserve a reusable instruction as a new immutable candidate revision.

Skill generation and Skill validation are separate responsibilities. Propose replay, variation, holdout, and negative-applicability definitions with `harness_propose_skill_test_case`. A holdout author must not receive the candidate instruction snapshot and must state its leakage policy. Execute each definition through normal tools so Hooks record actual Trace evidence, then submit the quality observations through `harness_validate_skill_test_quality`.

Only accepted tests may produce `harness_record_skill_validation_run` facts. Record three no-Skill baseline and three Skill-enabled repetitions for every required split, including tokens, tool calls, side-effect risk, and Trace IDs. Finish with `harness_generate_skill_validation_report`; Runtime code, not Agent judgment, decides promotion from split coverage, replay discrimination, stability, enabled outcomes, negative applicability, and risk. Use `harness_get_skill_candidate_detail` to report the persisted decision after restart.
