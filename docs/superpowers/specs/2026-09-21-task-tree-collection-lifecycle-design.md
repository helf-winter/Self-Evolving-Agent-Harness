# Task Tree Collection Lifecycle Design

**Status:** derived from approved SRS FR-002/003/004 and the existing one-active-workflow invariant

## Goal

A Project can retain multiple independent Task Trees, deterministically discover the relevant tree, select exactly one tree for active Runtime work, archive inactive work without deleting evidence, and restore it later.

## Collection semantics

- Task Collection is Project-owned and independent of a Claude session or Execution Context.
- Every Task Tree remains addressable by stable ID and retains all revisions, nodes, Trace, Artifact, Evaluation, Failure, and Evolution references.
- At most one workflow is active per Project. `runtime_states.selected_tree_id` and the active `workflow_states` row must agree after every collection transition.
- Creating a new root selects the new tree and deactivates the previously selected workflow in the same transaction.
- Selecting an existing tree deactivates the prior workflow, activates the target workflow, and selects the target root node. It does not create a new revision or revive an old Attempt.
- Switching away from a tree with a `running` or `verifying` Attempt is rejected. The Agent must finish or abort that Attempt explicitly first.

## Archive and restore

- Archive is a reversible collection transition, not deletion. The tree status becomes `archived`; `archived_from_status` and `archived_at` preserve restoration state.
- An archived tree is excluded from default candidates and cannot be selected, edited, confirmed, or executed.
- Archiving the selected tree deactivates its workflow and clears the Project Runtime selection. It is rejected while that tree has a running/verifying Attempt.
- Restoring an archived tree reinstates its exact pre-archive status (falling back to `draft` only for migrated malformed data), clears archive metadata, and makes it discoverable. Restore does not select or activate it automatically.
- Archive and restore are idempotent only for an identical terminal state: archiving an already archived tree and restoring a non-archived tree return `transition_rejected` rather than inventing duplicate transitions.

## Storage and audit

Migration v13 adds `archived_at` and `archived_from_status` to `task_trees` plus immutable `task_tree_collection_transitions` rows containing Project, Tree, action (`selected`, `archived`, `restored`), before/after status, before/after selected Tree, and timestamp.

Collection transitions do not rewrite Task Tree revisions. They update only collection projection state (`task_trees`, `workflow_states`, `runtime_states`) and append the transition record atomically.

## Candidate retrieval

- Candidate lookup is always scoped by `project_id` resolved from the current path.
- Default lookup excludes archived trees. `includeArchived` exposes them for explicit audit/restore flows.
- An exact Tree ID, title substring, Artifact locator, or no-query recency match remains explainable through `matchedBy`.
- If a Project has at most five eligible trees, an empty query returns all minimal summaries. Above five, or for a textual query, at most three deterministic candidates are returned.
- Each summary exposes whether the tree is currently selected and its archive timestamp.

## Binding and acceptance surface

Claude MCP adds `harness_select_task_tree`, `harness_archive_task_tree`, and `harness_restore_task_tree`; `harness_list_task_tree_candidates` gains `includeArchived`. CLI gains `tree select`, `tree archive`, and `tree restore` for Bash-first manual operation.

Acceptance must prove multiple roots in one Project, safe switching, running-attempt rejection, archive invisibility, explicit archived lookup, restoration without activation, immutable history preservation, restart persistence, and cross-Project rejection.
