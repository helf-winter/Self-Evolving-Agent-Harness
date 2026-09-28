# Branch Phase Orchestration Design

## Goal

Preserve the documented execution order after Skeleton Gate: select one
confirmed top-level branch, complete its implementation, verify that branch,
then continue with the next branch before root verification.

## State

The active Workflow stores `active_branch_node_id`. Immutable-revision branch
state rows store the ordered top-level branches as `pending`, `active`,
`implemented`, or `verified`. Skeleton Gate initializes these rows when it
passes. Legacy trees use the root as one compatibility branch.

## Deterministic phase gates

`evaluateWorkflowPhase` supports:

- `branch_implementation`: all current, confirmed implementation nodes in the
  active branch must succeed, with no unresolved blocking Drift in scope;
- `branch_verification`: the branch must contain at least one current,
  confirmed verification node and all such nodes must succeed; pass marks the
  branch verified and either activates the next branch or enters
  `root_verification`;
- `root_verification`: the root Task Node must declare verification phase and
  succeed on the current revision; pass enters `final_report`.

Every result is immutable. A failed or uncertain result leaves stage, revision,
and active branch unchanged. Node Attempt creation enforces active-branch scope
and prevents branch verification nodes from running in root verification or
vice versa.

