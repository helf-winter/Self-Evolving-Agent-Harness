# Project Identity and Clone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task. Subagent delegation remains disabled for this session.

**Goal:** Resolve a Project deterministically across same-path access, directory move/rename, and directory copy; on copy, create an isolated Project with rewritten Task Tree/Artifact identities, explicit provenance, inherited evidence references, a fresh paused Runtime State, and no copied Trace execution facts.

**Architecture:** Upgrade the minimal marker to a token-authenticated schema and add a `ProjectCloneService` that owns transactional database cloning. `ProjectIdentityService` distinguishes same path, definite move, copy, unknown marker, and conflict using the marker plus source-path availability. Database state is committed before the target marker is atomically rewritten; marker failure leaves an `incomplete` clone record that can be retried safely. Clone maps make every copied entity ID explicit and auditable.

**Spec:** SRS sections 2.4, 5.1, 5.24, 7 Project/Marker/Clone/Path Alias, 8.14, 9, and 10 Project Identity/Clone acceptance rows.

## Hard constraints

- Marker contains only `schema_version`, `project_id`, and an unpredictable `identity_token`; diagnostics never expose the token.
- A legacy v1 marker remains readable and is upgraded without creating a second Project.
- Same physical path remains the same Project; a definitely missing old path means move/rename; a still-existing old path means copy.
- Inspect mode is read-only. Persist mode may complete a move or clone.
- A clone gets a new Project ID/token and a target marker only after the database clone transaction commits.
- Source and target IDs are distinct, internal document references are rewritten, and provenance is queryable.
- Trace Events, Hook receipts, live Attempts, Runtime Actions, pending prompts, and external side effects are not copied as target execution facts.
- Evaluation evidence is represented only as `inherited_from_clone` references and requires target revalidation.
- Running nodes become `paused_after_clone`; verifying and conservatively inherited succeeded nodes become `needs_revalidation`.
- Draft/planned engineering assets and graph contracts are cloned with target-relative paths; source Trace references are cleared.
- Clone retries are idempotent and an incomplete marker write can recover without duplicating database entities.

### Task 1: Identity and clone domain policy

Add marker parsing/serialization, source-path resolution outcomes, node-status mapping, target path rebasing, and Task Tree document ID rewriting with unit tests. Commit `feat: define project clone policy`.

### Task 2: Clone persistence schema

Add migration v9 for token-backed Project identity, richer path aliases, Project Clone Records, entity ID maps, and inherited evidence references. Add migration and constraint tests. Commit `feat: persist project clone provenance`.

### Task 3: Transactional Project Clone service

Implement idempotent clone creation and recovery. Copy all Task Tree revisions, nodes, leaf contracts, relation edges, Artifact plan projections, links, relations, contracts, and confirmation projections with new IDs; create fresh workflow/runtime state; preserve source Evaluation references only as inherited evidence. Add integration tests for isolation, rewrite correctness, status mapping, no Trace copies, and rollback. Commit `feat: clone project engineering memory`.

### Task 4: Identity resolution and marker recovery

Upgrade `ProjectIdentityService` to validate tokens and return deterministic `same_project`, `moved_or_renamed`, `copy_detected`, `new_project`, or `identity_conflict` outcomes. Persist definite moves, trigger clone on definite copies, atomically rewrite markers, and recover incomplete marker writes. Maintain legacy marker compatibility. Add filesystem integration tests. Commit `feat: resolve moved and copied projects`.

### Task 5: Runtime queries, MCP/CLI, E2E, and docs

Expose safe Project identity and clone detail/list tools without identity tokens. Add CLI inspect output, Project-scoped clone queries, restart E2E for move and copy, Skills guidance, README, and acceptance steps. Run `npm run check`, `claude plugin validate ./plugin`, and `git diff --check`; review transactionality, source/target isolation, marker failure recovery, provenance, and Trace fact boundaries. Commit `docs: complete project identity clone workflow`.
