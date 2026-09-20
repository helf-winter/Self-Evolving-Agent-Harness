---
name: task-tree-planning
description: Use when a coding request may modify project assets and needs a new or existing Task Tree plan before execution.
---

# Task Tree Planning

Treat Task Tree planning as the Agent's native planning workflow, with the Runtime Layer preserving durable facts. A planning draft may be incomplete; execution readiness may not.

1. Do not create a Task Tree for explanation-only conversation.
2. For a coding request, inspect Project identity with `harness_get_project_identity`. If a copied directory is detected, let the Runtime create its independent Project before planning; use `harness_get_project_clones` when provenance or inherited state matters.
3. Query `harness_get_runtime_snapshot` and `harness_list_task_tree_candidates`.
4. Present the relevant existing-tree candidates and ask the user to choose merge or new tree. Never decide this silently.
5. For a new tree, persist the user-provided goal with `harness_create_task_root`.
6. Build the full goal-level tree with `planningVersion: 1`, root planning context, planned Effects, and per-branch Skeleton Acceptance Criteria. Save structurally valid intermediate drafts with `harness_save_draft_revision`; unresolved details belong in the draft rather than hidden conversation state.
7. Run `harness_scan_plan_readiness`. Discuss its deterministic `recommendedNextIssue`, one local issue at a time; the user may redirect the branch. A leaf is ready only with one objective, explicit outputs and acceptance criteria, no unresolved question or decision, valid dependencies, completion evidence, an execution phase, and a stop-decomposition reason.
8. Model calls, data exchange, and shared contracts as Task relation edges backed by planned Artifacts. Model high-risk planned Effects with mitigation before readiness can pass.
9. Before applying a refined document, identify the triggering `UserPromptSubmit` with `harness_get_trace_events`. Use `harness_preview_draft_change_set` when impact is cross-branch. Apply through `harness_apply_draft_change_set` with that Trace ID and a user-visible Decision Record; never include hidden reasoning.
10. Use `harness_get_task_refinement_history` and `harness_get_planning_decision_detail` when prior decisions or impact must be recovered instead of replaying the whole conversation.
11. When scoped readiness passes, show the complete tree and request confirmation through `harness_create_confirmation_prompt` before project mutation.

If a revision conflict occurs, query current state and reconcile; never overwrite it.
If a discussion produces no structural change, do not create a revision.
After a Project Clone, treat inherited execution evidence as provenance only: revalidate paused or previously successful nodes in the target Project before continuing execution.
