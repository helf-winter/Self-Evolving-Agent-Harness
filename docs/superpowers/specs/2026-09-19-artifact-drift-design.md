# Artifact Graph and Plan Drift Foundation Design

## Intent

Make Artifact Graph the revisioned engineering-state projection described by the SRS: planning revisions declare relevant structural, contract, and symbol assets; lifecycle Hooks attach factual changes to Trace Events; Plan Drift records meaningful differences from the confirmed baseline. This slice is the shared substrate for User Change, Task Node Replacement, Evaluation, and Evolution.

## Planning model

`TaskTreeDocument` gains optional `artifactLinks`, `artifactRelations`, and `artifactContracts` collections. Defaults are empty for backward compatibility.

- An Artifact has stable identity, adaptive granularity, lifecycle status, locator, identity strategy, provenance, and optional parent hierarchy.
- A Task/Artifact link is revision-scoped and records `plans`, `implements`, `consumes`, `creates`, `modifies`, `reads`, `deletes`, or `verifies`.
- An Artifact relation connects two artifacts with engineering semantics such as `imports`, `calls`, `uses_schema`, `returns_schema`, or `verified_by`.
- An Artifact Contract is carried by a `contract` Artifact and names its compatibility policy, schema/signature, provider nodes, consumer nodes, and validation references.

Plan validation rejects missing node/artifact references, a contract whose carrier is not contract-granularity, missing providers or consumers, and strong cross-node relations without an Artifact carrier. Saving a Task Tree revision projects the complete planning collections with `source_planning_revision_id` and maps node IDs to the new immutable Task Node Revision IDs.

## Branch confirmation baseline

When a branch is confirmed, only draft Artifacts linked to covered Task Nodes are promoted to `planned`. Their `planned_by_task_node_id`, `plan_baseline_at`, and source planning revision are retained. Whole-tree confirmation naturally covers every linked Artifact. Unlinked draft Artifacts remain draft and cannot silently become an execution baseline.

## Hook projection

Every successful or failed tool outcome remains a Trace Event. A relevant file or command also updates the Artifact projection and writes its ID into the Trace payload. Artifact rows store only current state and provenance; raw tool inputs, output summaries, and timing stay in Trace.

Deterministic projection rules:

- successful mutation of an existing planned/created/modified file -> `modified`;
- successful mutation of a new file -> `created`;
- successful verification command -> `verified` for the command Artifact;
- a failed command remains `failed` for compatibility and links to the failure Trace;
- read-only access records an observed Artifact without claiming modification.

## Plan Drift

`PlanDriftService` creates immutable Drift records and a paired `plan_drift` Trace Event in one transaction. Drift type and severity are validated code values.

- `info`: recorded only; execution continues.
- `warning`: recorded and surfaced in verification/reporting; execution continues.
- `blocking`: requires explanation and recommendation, moves the current node to `blocked`, closes any active attempt as `blocked`, and sets resolution to `pending_user_confirmation`.

Hooks automatically identify one deterministic case: a mutating file event during an active node that does not match any planned Artifact linked to that node. It is `warning` by default; if the same Artifact is planned by another currently unconfirmed branch it is `blocking`. More semantic cases such as responsibility changes and equivalent replacements are submitted explicitly by the Agent through Runtime Tools, because filename heuristics are not semantic truth.

## Resolution and Evaluation

Accepting, rejecting, or cancelling a blocking Drift is a high-risk state change and therefore requires a Runtime Confirmation Prompt; the resolution flow itself is implemented in the later Runtime Action/User Change slice. This slice records the pending state and exposes it.

Evaluation cannot transition a current Task Node to `succeeded` while an unresolved blocking Drift exists for that node and tree. It records an `uncertain` Evaluation and a non-applied lifecycle transition with a `blocking_drift` rejection code.

## Queries

- Runtime Snapshot adds pending warning/blocking Drift counts.
- Task Tree Summary includes Artifact counts and Drift counts.
- Artifact Graph Summary returns bounded Artifacts, relations, contracts, Task links, and pagination metadata.
- Artifact Detail returns current state, provenance, related tasks, relations, contracts, related Trace IDs, and Drift records.
- Plan Drift Summary supports severity and resolution filters.

## Persistence and compatibility

Migration version 4 enriches `artifacts` without removing existing columns, creates revision-scoped link/contract/relation tables, and creates `plan_drift_records`. Existing Artifacts are backfilled to structural or inferred granularity with observed confidence. Existing tests and callers that provide only `id`, `kind`, and `locator` remain valid.

## Verification

Tests cover validation, revision projection, branch-local promotion, Trace/Artifact provenance, automatic unexpected-Artifact Drift, blocking pause behavior, Evaluation blocking, query navigation, restart persistence, and unchanged legacy behavior. Full repository and Claude plugin validation are required.
