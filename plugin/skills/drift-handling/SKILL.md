---
name: drift-handling
description: Use when execution reveals that a confirmed Task Tree, relation, contract, or planned Artifact no longer matches project reality.
---

# Drift Handling

Use runtime queries to identify the smallest affected branch and its related Artifacts. Explain the observed fact, the confirmed assumption it contradicts, and the affected nodes. Propose a local Draft Change Set instead of rewriting unrelated branches.

Safe evidence collection may continue. Before changing confirmed scope or its contract, ask the user through the runtime confirmation flow. Apply the accepted change against the current revision; on conflict, reload and reconcile. Preserve prior revisions and Trace facts.
