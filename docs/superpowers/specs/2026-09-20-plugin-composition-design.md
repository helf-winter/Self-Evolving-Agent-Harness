# Plugin Composition Contract Design

**Date:** 2026-09-20  
**Status:** approved from SRS FR-026; implementation-ready

## Goal

Turn the Harness plugin internals from an implicit static directory layout into a
framework-neutral, auditable composition runtime. A stable Plugin can publish and
consume contracts, own dynamic registrations and effects, wait for missing
providers, replace one immutable revision with another, and recover from a failed
activation without executing stored callback text as code.

## Scope and ownership

Plugin composition is installation-scoped rather than Project-scoped. Skills,
Workflows, Hooks, Bindings, and Runtime extensions are runtime capabilities shared
by all Projects in one Harness data home. Project records may reference those
capabilities, but copying or deleting a Project never clones or deletes Plugin
composition state.

This slice models composition facts. It does not install npm packages, copy plugin
files, dynamically import untrusted code, or replace Claude Code's own plugin
loader. Agent Runtime Bindings translate their native registration lifecycle into
this contract.

## Stable identity and immutable revisions

A Plugin has a stable caller-supplied `pluginId`. Every proposed implementation is
an immutable Plugin Revision with a caller-supplied semantic revision label and a
normalized manifest:

- `provides`: unique `contractId + version` pairs;
- `requires`: unique exact contract requirements;
- `registrations`: unique registration keys for Skill, Workflow, Hook, Binding,
  or Runtime extension, each with a mandatory disposer declaration;
- `effects`: uniquely keyed reversible, version-reversible, compensatable, or
  irreversible effects using the same framework-neutral disposal policy as Task
  Node effects;
- `metadata`: diagnostic data only, with no executable callback bodies.

The database stores the manifest and normalized child rows. Old revisions are
never overwritten.

## Dependency resolution

Only an active Plugin Revision provides contracts. Requirements are satisfied by
an exact `contractId + version` match from another active revision. Resolution is
deterministic:

1. a first revision is registered as `pending_dependency`;
2. reconciliation activates every revision whose requirements are satisfied;
3. activation may unlock additional pending revisions, so reconciliation repeats
   to a fixed point;
4. if an active provider disappears or is replaced incompatibly, consumers move
   to `pending_dependency` and record missing requirements;
5. when providers return, consumers become active again.

Cycles with no external active provider remain pending. No LLM judgment is used.

## Registration and effect lifecycle

Every dynamic registration declares a disposer kind and reference. Harness records
that declaration and evidence-backed disposal results; it never invokes the
reference as shell, JavaScript, MCP, or callback code.

Plugin effects reuse the four effect classes and disposal capabilities already used
by Task Node Replacement. Version-reversible effects additionally require baseline
match and no other active Plugin Revision owning the same target. Compensation is
a new fact, not rollback. Irreversible effects can only be retained and must remain
visible as residual impact.

## Replacement

Replacement is explicit and revision-bound:

1. **preview** persists a candidate revision, compares contracts, computes the
   reverse dependency closure, and creates a replacement record without changing
   the active revision;
2. **execute** validates disposal evidence for every active old registration and
   effect, then records candidate activation success or failure;
3. on success, the old revision becomes replaced, the candidate becomes current,
   and all plugins are reconciled;
4. on failure, the old revision remains current when every completed disposal is
   safely recoverable; otherwise the Plugin enters `needs_recovery`;
5. **recover** records evidence that registrations/effects were restored and
   reactivates the old revision, or records a permanent recovery failure.

Compatibility is exact in this slice. Removed provides make the replacement
incompatible for affected consumers; missing candidate requirements make it
pending. The preview must show both conditions, but an explicit execute can still
activate a candidate and deterministically pause affected dependents.

## Persistence model

Migration v10 adds:

- `runtime_plugins`;
- `runtime_plugin_revisions`;
- `runtime_plugin_contracts`;
- `runtime_plugin_registrations`;
- `runtime_plugin_effects`;
- `runtime_plugin_dependency_edges`;
- `runtime_plugin_composition_transitions`;
- `runtime_plugin_replacement_records`;
- `runtime_plugin_registration_disposals`;
- `runtime_plugin_effect_disposals`.

All state changes and replacement execution use one database transaction.

## Runtime surface

The Runtime exposes:

- register an immutable Plugin Revision;
- reconcile dependency state;
- list Plugins and inspect one Plugin;
- preview, execute, and recover a replacement;
- dispose an active Plugin Revision with evidence-backed registration/effect
  dispositions.

Claude MCP tools expose the same data contract but do not install or execute
plugins. CLI diagnostic commands are optional; MCP plus query APIs are the
acceptance surface for this slice.

## Acceptance

The slice is complete when tests prove:

- stable IDs and immutable revision uniqueness;
- a consumer waits for a missing provider, activates when it appears, pauses when
  it disappears, and reactivates when it returns;
- every registration requires a disposer;
- stored disposer and effect operation strings are never executed;
- compatible replacement changes the current revision atomically;
- removed contracts pause the complete reverse dependency closure;
- baseline conflict, shared ownership, missing evidence, and irreversible
  auto-disposal cannot produce partial activation;
- failed activation preserves or evidence-restores the old revision;
- restart retains manifests, dependency edges, transitions, disposal attempts, and
  replacement records;
- the domain types contain no Cordis-specific dependency.

