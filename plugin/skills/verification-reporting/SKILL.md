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
