# Skeleton Gate Evaluation Implementation Plan

1. Add a pure deterministic Gate evaluator with explicit blocker codes and
   structured/legacy policy versions.
2. Add an immutable `skeleton_gate_results` migration.
3. Build current-revision observations from Task Nodes, Attempts, Evidence,
   Trace, Artifact Graph, Contracts, confirmations, and Plan Drift.
4. Persist every Gate result and advance the Workflow atomically only on pass.
5. Expose evaluation/history through MCP and Runtime Snapshot.
6. Update the branch-execution Skill, README, SRS, and manual acceptance plan.
7. Add unit, integration, end-to-end, restart, project-isolation, and MCP tests;
   then run the full repository check.

