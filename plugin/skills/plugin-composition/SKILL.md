---
name: plugin-composition
description: Use when registering, replacing, disposing, recovering, or diagnosing a Harness Runtime Plugin revision.
---

# Plugin Composition

Treat Plugin manifests, registrations, Effects, and lifecycle records as declarative Runtime facts. Never execute a stored disposer, inverse, or compensation string as a command.

1. Inspect current composition with `harness_get_plugins` and `harness_get_plugin_detail`.
2. Register a first immutable revision with `harness_register_plugin_revision`. If requirements are missing, report `pending_dependency`; do not claim activation.
3. For an existing Plugin, use `harness_preview_plugin_replacement`. Show contract diff, affected Plugins, reverse suspension order, and Effect risk before any Binding-side mutation.
4. Use the target Agent Runtime Binding's normal tools to unregister registrations and apply inverse or compensation operations. Capture concrete result references.
5. Submit exactly one disposition for every old registration and Effect to `harness_execute_plugin_replacement`. Harness validates facts and never runs the declared operation text.
6. If activation fails and Runtime reports `needs_recovery`, restore only reversible state with fresh evidence and call `harness_recover_plugin_replacement`. Never describe compensation or retained irreversible effects as rollback.
7. Dispose through `harness_dispose_plugin`; reactivation requires actual Binding reload evidence through `harness_reactivate_plugin`.
8. Use `harness_get_plugin_replacement_detail` to report every disposal attempt and final state.

Exact contract versions are required in v1. A missing provider deterministically pauses consumers; provider restoration is followed by fixed-point reconciliation.

