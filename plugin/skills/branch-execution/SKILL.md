---
name: branch-execution
description: Use when a confirmed Task Tree is ready to execute through skeleton and branch implementation stages.
---

# Branch Execution

Query Snapshot and Task Tree Summary before execution. Execute only the confirmed scope.

1. Complete the breadth-oriented skeleton pass first: module boundaries, public interfaces, shared data shapes, wiring, and contract tests.
2. Verify every skeleton acceptance criterion before detailed branch work.
3. Then implement one branch depth-first, following dependency and relation evidence rather than assuming sibling independence.
4. Query Node Detail only when the current branch needs its contract or evidence.
5. After each material tool outcome, let lifecycle hooks record the fact; do not fabricate Trace evidence.
6. When a material outcome creates an externally meaningful or replacement-relevant Effect, register it against the exact active Task Node revision and reference the Hook Trace that proves it.
7. If implementation requires changing confirmed scope, return that branch to local refinement and obtain confirmation again. If only the implementation revision is being swapped while identity and topology stay stable, use the evidence-backed Task Node Replacement workflow.

Do not start leaf implementation while the shared skeleton is incomplete.
