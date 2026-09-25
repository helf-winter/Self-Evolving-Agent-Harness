# Tree-centered Runtime View — Design

## Goal

Complete FR-014 and the query-facing part of FR-017 with one project-scoped view model that keeps Task Tree structure primary and reveals runtime evidence progressively.

## Decisions

1. Add `RuntimeQueryService.getTreeView` with `snapshot`, `summary`, and `detail` depths.
2. Snapshot returns every current node as a compact runtime projection and only relation edges requiring attention.
3. Summary returns the compact tree plus the selected node's one-hop relations and context summaries.
4. Detail may return a global Relation Overlay only when `includeRelationOverlay` is explicitly true. It supports relation kind, direction, branch, status, risk, and Artifact filters.
5. Node summaries are derived from current-revision facts: node and confirmation state, execution phase, warning/blocking Drift, current Artifact links, latest applicable Evaluation, evidence coverage, and relation counts. They do not create a second mutable status store.
6. Relation state is also derived. Missing mandatory Artifacts, dependency cycles, unfinished dependencies, and unconfirmed dependencies become explicit issues and risk levels.
7. Stable references use persisted Task Node, relation-edge, Artifact, Attempt, Evaluation, Trace, and Failure Case IDs so callers can navigate to existing detail tools.
8. All entry points resolve the current Project first. A tree or selected node from another Project returns `not_found`.

## Task Relation vocabulary

The persisted vocabulary is aligned with the SRS: `depends_on`, `calls`, `exchanges_data_with`, `shares_artifact_with`, and `coordinates_with`. The historical input aliases `data_exchange` and `shares_contract` remain readable and are normalized when a new revision is saved.

`depends_on` carries an optional `dependencyKind`; `coordinates_with` carries an optional `coordinationKind`; all relations may carry a description. Artifact requirements remain deterministic:

- `calls`, `exchanges_data_with`, and `shares_artifact_with` always require an Artifact;
- `depends_on` may omit it only for `execution_order`;
- `coordinates_with` may omit it only for `schedule_only`.

## Non-goals

- No graph UI.
- No full-project AST or symbol graph.
- No duplicate relation or node-summary tables.
- No unbounded Trace, Artifact, Attempt, or Evaluation payload in the tree view.

