---
name: branch-execution
description: Use when a confirmed Task Tree is ready to execute through skeleton and branch implementation stages.
---

# Branch Execution

Query Snapshot and Task Tree Summary before execution. Execute only the confirmed scope.

1. Complete the breadth-oriented skeleton pass first: module boundaries, public interfaces, shared data shapes, wiring, and contract tests.
2. After every current Skeleton Task Node has an evidence-backed successful Evaluation, call `harness_evaluate_skeleton_gate` with the current Workflow revision. Inspect its per-branch blockers when it fails or is uncertain; complete the missing Skeleton work and evaluate again. Never infer Gate success from prose or manually advance the stage.
3. Then implement only the Runtime's `activeBranchNodeId`, following dependency and relation evidence rather than assuming sibling independence. After its implementation nodes succeed, call `harness_evaluate_workflow_phase`; execute its verification nodes and call the same gate again. The Runtime activates the next branch or enters root verification.
4. Query Node Detail only when the current branch needs its contract or evidence.
5. After each material tool outcome, let lifecycle hooks record the fact; do not fabricate Trace evidence.
6. When a material outcome creates an externally meaningful or replacement-relevant Effect, register it against the exact active Task Node revision and reference the Hook Trace that proves it.
7. If implementation requires changing confirmed scope, return that branch to local refinement and obtain confirmation again. If only the implementation revision is being swapped while identity and topology stay stable, use the evidence-backed Task Node Replacement workflow.

Do not start leaf implementation while the shared skeleton is incomplete.
