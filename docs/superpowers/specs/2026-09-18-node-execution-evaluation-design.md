# Node Execution and Evaluation Vertical Slice Design

## 1. Purpose

This vertical slice extends the existing Runtime Foundation from planning and
confirmation into evidence-backed execution. It implements the smallest complete
loop in which a confirmed Task Node can start an Execution Attempt, accumulate
Trace evidence, receive an immutable Evaluation, and have its current lifecycle
status advanced by deterministic policy.

The slice implements SRS FR-011 and the execution-state prerequisites of FR-016.
It intentionally does not implement Task Node Replacement, Plan Drift detection,
Evolution, Failure Case promotion, or Skill generation. Those later capabilities
consume the attempt and evaluation history produced here.

## 2. Design corrections to the current foundation

### 2.1 Required evidence is not completion evidence

The current `TaskNodeInput.completionEvidence` field is populated during planning,
which conflicts with the SRS distinction:

- `required_evidence` declares what proof will be needed before execution.
- completion evidence is observed during execution and references real Trace facts.

The domain model will rename the planning field to `requiredEvidence`. Existing
unreleased Runtime Foundation data does not require a compatibility migration.
Evidence produced during execution is never embedded back into a Task Tree
Revision; it is linked to an Execution Attempt.

### 2.2 Evaluation is a fact, not a state mutation request

An Evaluation records a verdict about one exact Task Node Revision and one exact
Execution Attempt. It is immutable. A separate lifecycle policy decides whether
that fact is applicable to the current Task Node and whether a status transition
is legal.

```text
Trace evidence
  -> Evaluation Result
  -> Lifecycle Transition Decision
  -> current Task Node status
```

An Evaluation cannot be edited to change a failed result into a successful one.
A retry creates a new Execution Attempt and a new Evaluation.

## 3. Scope

### 3.1 Included

- Start an Execution Attempt for the current revision of a confirmed Task Node.
- Allocate a monotonically increasing attempt number per Task Node Revision.
- Move an attempt from `running` to `verifying`, then to a terminal status.
- Link existing project-scoped Trace Events to an attempt as evidence.
- Evaluate required-evidence coverage without asking the LLM to judge identifiers.
- Persist immutable Evaluation Results.
- Apply deterministic lifecycle transition rules.
- Reject stale-revision Evaluations.
- Preserve sequences such as `failed -> failed -> succeeded`.
- Require an explicit parent/root Evaluation instead of deriving parent success
  solely from child status.
- Expose attempt and evaluation history through Task Node Detail.
- Advance workflow stages only from applicable evidence-backed transitions.

### 3.2 Excluded

- Automatic semantic grading of arbitrary natural-language acceptance criteria.
- Automatic Plan Drift creation or resolution.
- Contract compatibility and dependency impact closure for Replacement.
- Effect disposal or file rollback.
- Experience, Skill, and Failure Case generation.
- Cross-Agent Runtime Bindings other than the existing Claude binding.

## 4. Domain model

### 4.1 Task Node execution status

The current status stored on `task_nodes` is the mutable projection of immutable
facts. This slice recognizes:

```text
draft
pending_user_confirmation
ready
running
verifying
succeeded
failed
blocked
needs_revalidation
cancelled
```

Only confirmed scope can become `ready`. Starting an attempt changes `ready`,
`failed`, or `needs_revalidation` to `running`. Beginning verification changes
`running` to `verifying`. Evaluation policy controls transitions from `verifying`.

### 4.2 Execution Attempt

```ts
type ExecutionAttemptStatus =
  | "running"
  | "verifying"
  | "succeeded"
  | "failed"
  | "blocked"
  | "aborted";

interface ExecutionAttemptView {
  attemptId: string;
  projectId: string;
  treeId: string;
  nodeId: string;
  nodeRevisionId: string;
  attemptNumber: number;
  status: ExecutionAttemptStatus;
  startedAt: string;
  completedAt: string | null;
}
```

The attempt is always bound to the concrete `task_node_revision_id` selected when
it starts. Later Task Tree revisions do not rewrite this association.

Only one non-terminal attempt may exist for a Task Node at a time. Starting an
attempt requires:

- the node belongs to the current Project;
- its revision belongs to the current Task Tree Revision;
- its branch is confirmed;
- its execution status is executable;
- its `execution_phase` matches the current Workflow stage;
- every `depends_on` node is `succeeded`;
- no other attempt for the node is `running` or `verifying`.

### 4.3 Evidence link

Each evidence link binds one required-evidence key to one existing Trace Event:

```ts
interface AttemptEvidenceInput {
  requiredEvidenceKey: string;
  traceEventId: string;
}
```

The application layer validates that the Trace Event belongs to the same Project,
Task Tree, and Task Node, and occurred no earlier than the attempt start. A Trace
Event may support more than one declared evidence key only through separate links.

Required evidence uses stable keys rather than natural-language equality:

```ts
interface RequiredEvidence {
  key: string;
  description: string;
}
```

Leaf hard validation requires at least one unique, non-empty evidence key.

### 4.4 Evaluation Result

```ts
type EvaluationVerdict = "succeeded" | "failed" | "blocked" | "uncertain";

interface EvaluationResultView {
  evaluationId: string;
  projectId: string;
  nodeId: string;
  nodeRevisionId: string;
  attemptId: string;
  verdict: EvaluationVerdict;
  evidenceRefs: string[];
  coveredRequiredEvidence: string[];
  missingRequiredEvidence: string[];
  riskSummary: string | null;
  createdAt: string;
}
```

The Agent or verification workflow proposes a verdict, but code computes evidence
coverage and applicability. A proposed `succeeded` verdict with missing required
evidence is persisted as `uncertain`; it cannot be used to mark the node succeeded.
References to absent or cross-project Trace Events reject the command instead of
being silently omitted.

### 4.5 Lifecycle Transition Decision

```ts
interface LifecycleTransitionDecision {
  evaluationId: string;
  policyVersion: "task-node-lifecycle/v1";
  fromStatus: TaskNodeExecutionStatus;
  targetStatus: TaskNodeExecutionStatus;
  applied: boolean;
  rejectionCode: string | null;
}
```

The policy is a pure function over persisted facts. Version 1 applies these rules:

| Condition | Result |
| --- | --- |
| Evaluation revision is not current | Do not apply; current node becomes or remains `needs_revalidation` |
| Verdict `succeeded`, full evidence, dependencies succeeded, all children succeeded | `verifying -> succeeded` |
| Verdict `succeeded` but evidence or parent integration conditions are incomplete | Persist as `uncertain`; remain `verifying` |
| Verdict `failed` for current attempt | `verifying -> failed` |
| Verdict `blocked` | `verifying -> blocked` |
| Verdict `uncertain` | Remain `verifying` |

For a non-leaf node, `all children succeeded` is necessary but not sufficient. The
parent must have its own attempt, required evidence, and Evaluation.

## 5. Persistence

Migration 2 adds:

- `execution_attempts`
- `execution_attempt_evidence`
- `evaluations`
- `lifecycle_transition_records`

`execution_attempts` has a unique `(task_node_revision_id, attempt_number)` key and
a partial unique index that allows only one `running` or `verifying` attempt per
Task Node.

`execution_attempt_evidence` has a unique `(attempt_id, required_evidence_key,
trace_event_id)` key. It references existing append-only Trace Events.

`evaluations` and `lifecycle_transition_records` are append-only. No application
service exposes update or delete operations for them.

## 6. Application services

### 6.1 NodeExecutionService

```ts
startAttempt(input): ExecutionAttemptView
beginVerification(input): ExecutionAttemptView
attachEvidence(input): AttemptEvidenceView
abortAttempt(input): ExecutionAttemptView
```

Every mutation accepts the expected Task Tree Revision or expected attempt status.
Revision/status mismatches return `revision_conflict`.

### 6.2 EvaluationService

```ts
evaluateAttempt(input): {
  evaluation: EvaluationResultView;
  transition: LifecycleTransitionDecision;
}
```

Evaluation persistence and an applicable node/attempt state transition occur in
one database transaction. If persistence fails, neither the Evaluation nor the
state transition is committed.

## 7. Workflow integration

- Confirming an entire tree marks confirmed nodes `ready` while preserving nodes
  that are structurally invalid or explicitly outside the confirmed scope.
- `skeleton_pass` permits only `skeleton` attempts.
- Skeleton Gate evidence must reference succeeded skeleton attempts; an arbitrary
  string is no longer accepted as gate evidence.
- `branch_implementation` permits only `implementation` attempts.
- `branch_verification` and `root_verification` permit only `verification`
  attempts.
- Workflow progression never treats a model statement such as "done" as evidence.

Branch-scoped confirmation remains limited by the current foundation's scope
representation. This slice supports whole-tree confirmation consistently and does
not claim complete partial-branch scheduling until branch membership is persisted
explicitly in a later slice.

## 8. Bindings and queries

The CLI and MCP expose thin commands/tools for attempt start, verification,
evidence attachment, evaluation, and detail lookup. They do not accept a caller-
supplied Project ID; Project scope continues to derive from `cwd`.

Task Node Detail adds paginated attempt and Evaluation history. Snapshot and
Summary add counts only, preserving the three-level introspection contract.

Hooks continue to create Trace Events. They do not automatically declare a node
successful. The Agent explicitly links relevant events to its current attempt,
after which deterministic Evaluation policy can consume them.

## 9. Error handling

The slice adds stable errors:

- `attempt_already_active`
- `attempt_not_executable`
- `attempt_state_conflict`
- `evidence_not_found`
- `evidence_scope_mismatch`
- `evaluation_not_applicable`

Expected domain errors return structured results through CLI and MCP. Failed
commands do not leave partial attempt, Evaluation, or lifecycle records.

## 10. Verification

Automated verification must demonstrate:

1. Attempt numbers increase monotonically and history survives restart.
2. Two active attempts for one node are rejected.
3. Cross-project and pre-attempt Trace evidence is rejected.
4. Missing required evidence turns proposed success into `uncertain`.
5. A failed, failed, succeeded sequence remains fully queryable.
6. An Evaluation for a stale revision cannot mark the current node succeeded.
7. A parent cannot succeed solely because all children succeeded.
8. Evaluation persistence and state transition are atomic.
9. Skeleton Gate cannot advance from an arbitrary evidence identifier.
10. CLI, MCP, plugin contract, type checking, and the existing Runtime Foundation
    regression suite remain green.
