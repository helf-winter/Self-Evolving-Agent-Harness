---
name: task-tree-planning
description: Use when a coding request may modify project assets and needs a new or existing Task Tree plan before execution.
---

# Task Tree Planning

Treat Task Tree planning as the Agent's native planning workflow, with Harness runtime tools providing durable facts.

1. Do not create a Task Tree for explanation-only conversation.
2. For a coding request, query `harness_get_runtime_snapshot` and `harness_list_task_tree_candidates`.
3. Present the relevant existing-tree candidates and ask the user to choose merge or new tree. Never decide this silently.
4. For a new tree, persist the user-provided goal with `harness_create_task_root`.
5. Build the full goal-level tree. A leaf has exactly one objective, explicit output, acceptance criteria, no unresolved question or decision, valid dependencies, completion evidence, an execution phase, and a stop-decomposition reason.
6. Refine only the highest-impact unresolved branch at a time. Let the user redirect the discussion.
7. Model calls, data exchange, and shared contracts as Task relation edges backed by planned Artifacts.
8. Save a complete initial draft with `harness_save_draft_revision`; later edits use `harness_apply_draft_change_set` against the current revision.
9. Run `harness_scan_plan_readiness`, show the complete tree, and request confirmation through `harness_create_confirmation_prompt` before project mutation.

If a revision conflict occurs, query current state and reconcile; never overwrite it.
