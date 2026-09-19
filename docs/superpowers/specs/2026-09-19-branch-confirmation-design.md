# Branch Confirmation and Mixed Confirmation State Design

## Intent

Allow a user to confirm one Task Tree branch without implicitly confirming sibling branches. Confirmed work becomes executable only when its current revision, dependencies, and workflow phase are valid. The design must preserve confirmation across unrelated edits while invalidating only the affected scope.

## Domain model

Confirmation is a revision-scoped projection, separate from Task Node execution status.

- `draft`: no current-revision confirmation covers the node.
- `pending_user_confirmation`: a current-revision prompt covers the node, or a previously confirmed node changed and must be confirmed again.
- `confirmed`: an accepted current-revision confirmation explicitly covers the node.
- `partial_confirmed`: the node is not itself confirmed as a complete scope, but at least one descendant is confirmed.

An immutable Scope Confirmation Record stores the accepted decision, tree revision, scope kind, optional branch root, covered node IDs, confirmation prompt, answer Trace Event, and timestamp. The mutable projection is derived from those records and is optimized for runtime queries and execution gates.

## Scope semantics

A confirmation scope is either:

- `tree`: every node in the current Task Tree revision; or
- `branch`: the selected node and its complete descendant closure.

Branch membership is computed from the current immutable Task Tree revision. A prompt and its readiness result are bound to the same revision and exact scope. A stale prompt or stale readiness result is rejected rather than reinterpreted against a newer tree.

Confirming a branch:

1. creates an immutable Scope Confirmation Record;
2. marks every covered node `confirmed`;
3. marks uncovered ancestors with confirmed descendants `partial_confirmed`;
4. leaves unrelated sibling branches `draft`;
5. changes executable covered leaves to `ready` when their dependencies are already confirmed;
6. changes covered nodes whose dependencies remain unconfirmed to `blocked_by_unconfirmed_dependency`.

Rejecting a prompt records the rejection but does not create a Scope Confirmation Record or change node confirmation projections.

## Readiness

Plan Readiness can target the complete tree or a branch. The deterministic scan validates:

- the whole document has a single, acyclic, internally consistent tree;
- every leaf inside the selected scope satisfies the Leaf Task Contract;
- every dependency names an existing node in the same Task Tree revision;
- task relations originating inside the selected scope have valid Artifact references where required.

Readiness does not require dependencies outside the branch to be confirmed. That is an execution concern and is represented by `blocked_by_unconfirmed_dependency` after confirmation.

## Revision changes

When a new Task Tree revision is created:

- unchanged nodes preserve their previous confirmation state;
- changed nodes that were confirmed or partially confirmed become `pending_user_confirmation`;
- newly added nodes start as `draft`;
- removed nodes receive no current-revision projection;
- ancestor `partial_confirmed` values are recomputed from the new structure;
- accepted records remain immutable historical facts and never become evidence for a different revision.

This is a conservative invalidation rule. It avoids silently executing changed work while retaining approval for unrelated branches.

## Runtime integration

`WorkflowService` owns prompts and accepted confirmation records. `TaskTreeService` owns scope calculation, readiness, and revision carry-forward. `NodeExecutionService` rejects attempts unless the current node revision has `confirmed` confirmation state. `RuntimeQueryService` exposes per-node state and aggregate confirmation counts.

The workflow advances from `branch_confirmation` to `skeleton_pass` only when every current node is confirmed. A partial branch confirmation keeps the workflow at `branch_confirmation`; this represents an intentionally mixed tree, not an error.

## Persistence

Migration version 3 adds:

- scope metadata to readiness results and confirmation prompts;
- `scope_confirmation_records` for immutable accepted decisions;
- `task_node_confirmation_states` for current and historical revision projections.

Existing confirmed trees are backfilled as confirmed for their current revision. Other existing nodes are backfilled as draft so migration never invents approval.

## Failure handling

- Unknown scope root: `not_found`.
- Readiness result for another revision or scope: `revision_conflict`.
- Prompt resolved twice: `not_found` for pending confirmation.
- Confirmation without a matching `UserPromptSubmit` Trace Event: `workflow_transition_rejected`.
- Attempt on an unconfirmed node: `attempt_not_executable`.

All multi-table state changes execute in one database transaction.

## Verification

Tests cover branch closure, mixed projection, cross-branch dependency blocking, whole-tree compatibility, stale revision rejection, selective invalidation after an edit, query visibility, migration backfill, and execution gating. The full repository check and Claude plugin contract validation remain required.
