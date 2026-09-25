# Tree-centered Runtime View — Implementation Plan

> Execute with test-driven development and verify each task before committing.

## Task 1: Align Task Relation contracts

- Add failing domain tests for the five canonical relation kinds and conditional Artifact rules.
- Add relation metadata and legacy-alias normalization.
- Persist canonical relations in new Task Tree revisions and keep old revisions readable.
- Run focused Task Tree and refinement tests.

## Task 2: Derive compact node and relation projections

- Add failing RuntimeQuery tests for current-revision node summaries.
- Derive latest applicable Evaluation, evidence coverage, Drift, Artifact, and relation counts.
- Derive one-hop relation state, risk, cycle, branch, and stable references.
- Verify Project isolation.

## Task 3: Expose progressive Tree-centered views

- Add failing tests for snapshot, summary, detail, explicit global overlay, and filters.
- Implement `getTreeView` and register `harness_get_tree_view`.
- Ensure snapshot does not return the full graph and detail never enables global overlay implicitly.
- Add MCP contract tests.

## Task 4: Close the vertical slice

- Add an end-to-end test that survives Runtime restart.
- Update README and acceptance steps.
- Run `npm run check` and `git diff --check`.

