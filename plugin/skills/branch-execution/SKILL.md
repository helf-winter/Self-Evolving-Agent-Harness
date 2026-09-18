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
6. If implementation requires changing a confirmed branch, return that branch to local refinement and obtain confirmation again.

Do not start leaf implementation while the shared skeleton is incomplete.
