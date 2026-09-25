# Parent–Child Task Communication Design

## Scope

Close SRS FR-005 without introducing a second mutable source of Task execution truth. Parent-to-child requirements already live in the immutable current `TaskNodeRevision`; child-to-parent results will be a bounded, current-revision projection derived from Attempt, Evaluation, Trace, Artifact, Drift, confirmation, and lifecycle-transition records.

## Decisions

1. **No persisted report copy.** A Child Task Report is a query projection. Persisting a JSON report would duplicate facts and could become stale after a new Evaluation, Drift, or Task Tree revision.
2. **Current revision only.** Default parent coordination reads direct children from the current Task Tree revision. Historical facts remain available through existing revision, Attempt, Evaluation, and Trace queries.
3. **One-hop and bounded.** `getTaskNodeDetail` adds paginated direct `childReports` with a default limit of 50 and maximum of 200. It does not recursively expand the subtree.
4. **Evidence-backed fields.** Each report includes current node/revision identity, status, confirmation, execution phase, latest current-revision Attempt and Evaluation, lifecycle-policy result, evidence coverage, Artifact counts, Trace count, and unresolved blocking Drift count.
5. **Parent summary is deterministic.** The response aggregates status counts, total children, whether every direct child succeeded, and whether parent integration evaluation is ready. The Agent may explain this result but cannot override it.
6. **Independent parent Evaluation remains mandatory.** Child success never marks the parent succeeded. An executable non-leaf verification node cannot start until all of its current-revision direct children have succeeded; the parent must then collect its own required evidence and receive its own Evaluation.
7. **Skeleton ordering remains valid.** The child-success start gate applies to non-leaf `verification` nodes. It does not block structural or skeleton work that must precede branch implementation.
8. **Project isolation.** Parent and child IDs are resolved through the current Project. Foreign IDs return `not_found`; no report contains another Project's facts.

## Projection Shape

```ts
interface ChildTaskReport {
  nodeId: string;
  nodeRevisionId: string;
  title: string;
  status: string;
  confirmationState: string;
  executionPhase: string | null;
  latestAttempt: null | { attemptId: string; status: string; attemptNumber: number };
  latestEvaluation: null | {
    evaluationId: string;
    attemptId: string;
    verdict: string;
    transitionApplied: boolean;
    targetStatus: string;
    coveredRequiredEvidence: string[];
    missingRequiredEvidence: string[];
  };
  artifactCounts: { total: number; planned: number; actual: number };
  traceCount: number;
  blockingDriftCount: number;
}
```

The parent detail also returns:

```ts
{
  childReports: ChildTaskReport[];
  childNextCursor: string | null;
  childSummary: {
    total: number;
    statusCounts: Record<string, number>;
    allChildrenSucceeded: boolean;
    readyForParentEvaluation: boolean;
  };
}
```

`readyForParentEvaluation` is true only when the node has at least one direct child and every direct child is `succeeded`. Starting the parent Attempt still requires current revision, confirmation, workflow phase, dependencies, and required evidence declarations.

## Failure Semantics

- A child from an older tree revision is excluded from the current report.
- A stale Evaluation is not presented as the latest applicable Evaluation.
- Missing Evaluation, Attempt, Artifact, or Trace facts are represented by null/zero values, never invented summaries.
- A parent verification Attempt rejected for incomplete children creates no Attempt and changes no node or Runtime state.

