# Task Tree Refinement Loop and Readiness Design

**Date:** 2026-09-20  
**Status:** approved from SRS FR-015/016/027; implementation-ready

## Goal

Make a draft Task Tree a real discussion workbench rather than a document that
must already be executable. Persist incomplete but structurally sound plans,
deterministically rank the next blocking issue for a tree or branch, apply
evidence-linked local refinements, preview cross-branch changes, and preserve
user-visible Planning Decision Records without storing hidden reasoning.

## Draft validity versus Plan Readiness

Draft persistence and execution readiness are distinct gates.

The draft structural gate rejects only facts that cannot be represented safely:
duplicate/missing node identities, broken parent/child topology, cycles, invalid
node/artifact references, and malformed object identity. It allows incomplete leaf
contracts, unresolved questions/decisions, missing relation contracts, and missing
Skeleton Acceptance Criteria because those are the inputs to refinement.

The Plan Readiness gate is stricter and produces blocking issues and warnings. It
checks only the requested tree/branch/subtree scope plus shared dependencies and
contracts that cross that scope. An unrelated sibling's local issue cannot block a
branch confirmation.

## Planning data in TaskTreeDocument

The document gains optional planning fields:

- `planningContext`: goal, scope boundaries, explicit exclusions, and root-level
  unresolved questions/decisions;
- `skeletonCriteria`: one record per top-level functional branch, containing
  expected artifacts, required contracts, verification commands, and readiness
  conditions.

Omission means unresolved. An explicit empty exclusions array means exclusions were
considered and none were declared.

## Readiness issues and priority

A readiness issue has a stable code, category, severity, affected references,
human-readable summary, and deterministic priority score. Category order follows
the SRS:

1. root goal/scope/exclusions;
2. cross-branch architecture decisions;
3. cross-branch contracts/data exchange;
4. high-risk planned effects;
5. branch boundaries/dependencies;
6. acceptance/evidence/Skeleton criteria;
7. local leaf detail.

Impact count, cross-branch reach, blocking count, risk, and stable reference
tie-breakers produce a deterministic ordering. The first blocking issue is
`recommendedNextIssue`. Semantic conjunction or vague evidence creates warnings,
not hard semantic truth.

## Change Set preview and application

A preview compares the current revision with one proposed complete document and
returns affected nodes, branches, artifacts, relations/contracts, and impact level.

- one-branch/local changes may be applied directly;
- root topology or multiple top-level branch changes are `cross_branch` and
  require a persisted preview ID;
- previews bind exact base revision and proposed document hash;
- stale or mismatched previews are rejected.

Applying a real structural change requires a same-Project, same-Tree
`UserPromptSubmit` Trace Event produced after the base revision. It atomically
creates:

- Draft Change Set with source message, affected references, apply mode, preview,
  and result revision;
- Planning Decision Record with discussion topic, current understanding, displayed
  options, recommendation, user decision, and affected refs;
- a redacted `PlanningDecisionApplied` Trace Event;
- the immutable Task Tree revision and structured Skeleton criteria projections.

A proposed document identical to the current document is rejected as
`no_structural_change`; explanation-only conversation should remain Trace only.

## Persistence

Migration v11 enriches Draft Change Set, Planning Decision, and Plan Readiness
records, adds persisted refinement previews, and upgrades Skeleton Acceptance
Criteria to branch-scoped structured data.

## Runtime surface

Runtime and Claude MCP expose:

- preview Draft Change Set;
- apply evidence-linked Draft Change Set;
- scan scoped readiness with ordered issues, warnings, priority explanation, and
  recommended next issue;
- query refinement history and one decision/change-set detail.

The Task Tree Planning Skill follows this loop one issue at a time and lets the user
redirect scope.

## Acceptance

Tests must prove incomplete drafts persist, invalid topology does not; unrelated
sibling issues do not block a ready branch; issue ranking is deterministic;
structured Skeleton criteria gate readiness; local change applies directly;
cross-branch change requires matching preview; stale/mismatched preview and
cross-Project/early/non-user source Trace are rejected; no-op does not create a
revision; successful apply atomically creates revision, Change Set, Decision Record,
planning Trace, and queryable history across restart.

