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
