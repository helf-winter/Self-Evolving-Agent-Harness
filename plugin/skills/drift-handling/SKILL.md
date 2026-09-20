---
name: drift-handling
description: Use when execution reveals that a confirmed Task Tree, relation, contract, or planned Artifact no longer matches project reality.
---

# Drift Handling

Start with `harness_get_runtime_snapshot`, then use `harness_get_plan_drift_summary` and Artifact queries to identify the smallest affected branch. Explain the observed fact, the confirmed assumption it contradicts, the affected Task Nodes and Artifacts, and the recommended local response.

For a blocking Drift, first ensure the user's instruction has been recorded as a `UserPromptSubmit` Trace. Call `harness_propose_plan_drift_resolution` with the exact Drift ID, current Tree revision, proposed decision, reason, and source-message Trace ID. Present the Runtime Confirmation Prompt to the user. After the answer is recorded as another `UserPromptSubmit` Trace, call `harness_resolve_runtime_confirmation` with the explicit confirmation ID and answer Trace ID. Never infer which pending prompt a short answer belongs to.

Classify later user instructions before changing state:

- `minor_change` records a local factual adjustment and does not rewrite confirmed scope;
- `priority_change` changes the selected next node only;
- `scope_change` includes a complete proposed Task Tree document and always waits for confirmation.

Use `harness_propose_user_change` for all three classes. Minor and priority changes commit without a second prompt. A confirmed scope change creates a new draft revision and returns the workflow to Task Tree refinement; it does not authorize code execution. Re-scan readiness and re-confirm the affected branch before resuming work.

Safe evidence collection may continue while a decision is pending. On `revision_conflict`, reload the current Tree and reconcile instead of replaying the stale action. Preserve all prior revisions and Trace facts.

When a confirmed Task Node implementation must be replaced without changing its identity or tree topology, use the replacement workflow instead of rewriting history:

1. Record every material Effect against the exact active Task Node revision with `harness_register_task_node_effect` as soon as normal tools produce it.
2. Use `harness_preview_task_node_replacement` with the current Tree revision, complete candidate body, contract bindings, reason, and source user-message Trace. Present the returned impact closure, contract diff, Effect risk, and exact Runtime Confirmation Prompt.
3. After the user's answer is recorded, call `harness_confirm_task_node_replacement` with the explicit replacement ID and answer Trace. Only `yes` suspends the affected closure.
4. Perform each approved inverse or compensation with ordinary Agent tools. The Runtime never executes the stored operation text. Record the resulting Trace and pass one evidence-backed disposition per active owned Effect to `harness_execute_task_node_replacement`.
5. If activation fails, collect new validation evidence and call `harness_recover_task_node_replacement`. Do not describe compensation as rollback: compensation creates a new fact and may leave residual impact.

Never automatically dispose an irreversible Effect. A baseline mismatch, shared active owner, missing evidence, or ownership mismatch is a conflict that must remain visible until explicitly resolved.
