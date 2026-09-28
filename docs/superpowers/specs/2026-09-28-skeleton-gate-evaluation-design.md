# Skeleton Gate Evaluation Design

## Goal

Make the Skeleton Gate an executable Runtime boundary instead of a documented
convention. The Agent must be able to ask the Runtime to evaluate the current
Task Tree revision, receive precise blockers, and advance to branch
implementation only when the persisted facts satisfy the plan.

## Runtime contract

`evaluateSkeletonGate(projectId, treeId, workflowRevision)` is valid only while
the active Workflow is at `skeleton_pass`. The operation reads one immutable
snapshot of the current tree revision and persists one immutable Gate result.

For a structured (`planningVersion: 1`) plan, the evaluator checks:

- every confirmed top-level branch has one Skeleton Acceptance Criterion;
- every current Skeleton Task Node in each branch has a succeeded Attempt for
  its current Task Node revision;
- each expected Artifact has an observed creation/modification/verification
  fact from a Skeleton node in that branch;
- each required Contract exists in the current Artifact Graph revision and its
  carrier Artifact has such a Skeleton fact;
- each declared verification command has a successful Hook Trace attached as
  evidence to a succeeded Skeleton Attempt in that branch;
- readiness conditions are backed by at least one succeeded current Skeleton
  Attempt in that branch;
- no unresolved blocking Plan Drift exists in the tree.

Legacy Task Trees without `planningVersion: 1` retain the earlier compatibility
rule: at least one current Skeleton Task Node exists and all current Skeleton
Task Nodes have succeeded. The result explicitly records the legacy policy.

## Result and transition

The result status is `passed`, `failed`, or `uncertain`. It stores the exact
tree revision, input Workflow revision, policy version, per-branch observations,
blocker codes, Attempt references, Trace references, and creation time. Results
are append-only.

Only `passed` atomically advances the Workflow from `skeleton_pass` to
`branch_implementation`. A failed or uncertain evaluation leaves the Workflow
at `skeleton_pass`, so missing Skeleton work can be completed and the Gate can
be evaluated again. Optimistic Workflow revision checks prevent stale callers
from advancing a newer plan.

## Agent entry points

- `harness_evaluate_skeleton_gate` evaluates and, on success, advances.
- `harness_get_skeleton_gate_results` restores the immutable history.
- Runtime Snapshot exposes `evaluate_skeleton_gate` at `skeleton_pass` and the
  latest result summary.

The branch-execution Skill instructs the Agent to use the Gate tool. It must not
infer Gate success from prose or manually move the Workflow stage.

