# Runtime Foundation Vertical Slice Design

**Status:** Approved scope, implementation design pending final review

**Date:** 2026-09-18
**Source SRS:** `docs/Self-Evolving-Agent-Harness-需求文档.md` v0.29

## 1. Goal

Build the first runnable vertical slice of Self-Evolving Agent Harness as a self-contained Claude Code plugin. The slice must prove that an Agent can use Harness workflow guidance while lifecycle hooks persist project-scoped Task Tree, Trace, Artifact, and Runtime State facts in one global database.

The slice is successful when a user can load the local plugin, create or select a Task Tree for the current directory, persist a confirmed draft, execute tools in Claude Code, and query the resulting tree-centered runtime state after restarting Claude Code.

## 2. Scope

### 2.1 Included

- TypeScript runtime targeting Node.js 22.13 or later.
- A self-contained Claude Code plugin with Skills, Hooks, and a plugin MCP server.
- Global SQLite Runtime Database using the built-in `node:sqlite` module.
- Project path normalization and `.agent-harness-project.json` identity marker.
- Project-scoped Task Tree candidate lookup.
- Task Tree, immutable revisions, Task Nodes, Leaf Task Contracts, relation edges, and planned Artifacts.
- Deterministic Leaf Task Contract and relation-to-Artifact validation.
- Coding workflow state through planning, refinement, confirmation, skeleton, implementation, verification, and reporting stages.
- Append-only lifecycle Trace from Claude hook events.
- Structural Artifact projection for observed file and command activity.
- Snapshot, Summary, and Detail runtime queries.
- Skills for task-tree planning, task-root creation, branch execution, verification reporting, and drift handling.
- CLI commands for doctor, project resolution, task-root creation, and runtime queries.

### 2.2 Deferred

- Full Evaluation and Lifecycle Transition Policy execution.
- Experience mining, Skill generation, Skill validation, and promotion.
- Failure Case L0-L4 automation.
- Project Clone execution and reference rewriting.
- Task Node replacement and Effect disposal.
- Full Artifact drift classification and resolution.
- Codex and other Agent Runtime Bindings.
- Graphical UI.
- Full-project AST, symbol, or call-graph indexing.

Deferred domains may have narrow TypeScript ports where the first slice needs a boundary, but the implementation must not create unused services, empty tables, or placeholder behavior.

## 3. Technical Decisions

### 3.1 Runtime and packaging

- Use TypeScript with ECMAScript modules.
- Require Node.js `>=22.13.0` so the runtime can use `node:sqlite` without a native npm addon.
- Use `tsc --noEmit` for type checking and `esbuild` to create self-contained ESM entry bundles in `plugin/runtime/`.
- Keep the plugin self-contained: no hook command may reference files above `${CLAUDE_PLUGIN_ROOT}`.
- Keep production dependencies minimal. Runtime code should rely on Node built-ins and the official MCP SDK only.

Using `node:sqlite` avoids the WSL installation failure previously caused by downloading or compiling `better-sqlite3` native bindings.

### 3.2 Binding strategy

The Claude binding combines three mechanisms:

1. **Skills** describe when and how Claude should follow the Task Tree workflow.
2. **Hooks** observe lifecycle facts and validate stage behavior without acting as an external supervisor.
3. **Plugin MCP tools** expose typed Runtime Actions and Introspection operations to Claude.

MCP is only the structured tool surface of the Claude Runtime Binding. Domain rules, transactions, state transitions, and storage remain in the Harness Runtime Layer and are shared by CLI, hooks, and MCP entry points.

### 3.3 Runtime Native Command limitation

Claude Code plugin commands are prompt-expanded Skills rather than true built-in commands like `/model`. The first slice therefore provides:

- deterministic shell commands such as `harness taskroot <name>`;
- `/agent-harness:taskroot <name>` as a thin Skill that submits the explicit name to the same deterministic application service;
- no claim that the plugin Skill itself is a new Claude built-in command.

The persisted state change is always performed by validated code, never by free-form Skill output.

### 3.4 Persistence

The global data directory is resolved in this order:

1. `AGENT_HARNESS_DATA_HOME` when explicitly set;
2. `$XDG_DATA_HOME/agent-harness` on Linux or WSL;
3. `$HOME/.local/share/agent-harness` on Linux or WSL;
4. `%LOCALAPPDATA%/AgentHarness` on Windows.

The database file is `runtime.db`. SQLite must use foreign keys, WAL journal mode, and a busy timeout. Every schema change is represented by an ordered migration recorded in `schema_migrations`.

Project directories contain only `.agent-harness-project.json`. The marker is created on the first persisted Harness action or first observed mutation, not merely because the plugin was loaded for ordinary conversation.

## 4. Architecture

```text
Claude Code Runtime
├── Agent Core
└── Agent Harness Plugin
    ├── Skills
    ├── Lifecycle Hooks
    ├── MCP Runtime Tools
    └── Compiled Harness Runtime
        ├── Application Services
        ├── Domain Rules
        ├── SQLite Repositories
        └── Tree-centered Queries
```

The runtime uses a ports-and-adapters boundary:

- `domain/` contains pure types and deterministic rules.
- `application/` owns use cases and transaction boundaries.
- `storage/` implements global SQLite persistence.
- `bindings/claude/` maps Claude hook and MCP payloads into application commands.
- `cli/` maps shell arguments to the same application services.
- `plugin/` contains distributable Claude metadata and Skills.

No domain module imports Claude-specific schemas. No hook or MCP handler writes SQL directly.

## 5. Component Design

### 5.1 Project Identity

`ProjectIdentityService.resolve(cwd, mode)` normalizes the exact current working directory. It does not automatically replace it with a parent Git root.

Resolution modes:

- `inspect`: return an existing Project or an unpersisted `new_project` candidate without writing a marker;
- `persist`: create or validate the marker and persist the Project within one application transaction.

The first slice supports `same_project`, `new_project`, and `identity_conflict`. It recognizes registered Windows/WSL aliases. Full `moved_or_renamed` and `copy_detected` execution are deferred, but ambiguous marker reuse must return `identity_conflict` instead of silently sharing writable state.

### 5.2 Task Tree Planning

The planning service supports these application commands:

```ts
listTaskTreeCandidates(input): TaskTreeCandidate[]
createTaskRoot(input): TaskTreeRevisionView
saveDraftRevision(input): TaskTreeRevisionView
applyDraftChangeSet(input): TaskTreeRevisionView
scanPlanReadiness(input): PlanReadinessResult
createConfirmationPrompt(input): RuntimeConfirmationView
confirmScope(input): ConfirmationResult
```

`saveDraftRevision` accepts a complete proposed tree for initial creation and stores a new immutable revision. Later refinement uses `applyDraftChangeSet`, which requires `base_revision_id`, structured operations, affected references, and a decision summary. Neither path updates a previous revision in place. The service validates node identity, parent references, acyclic parentage, relation references, Leaf Task Contracts, and relation-to-Artifact requirements before committing.

Initial candidate lookup is deterministic and project-scoped. It ranks explicit tree ID, exact or partial title, Artifact path, status, and recency, and returns `matched_by`. Semantic new-versus-merge advice remains the Agent's responsibility; persistence waits for explicit user confirmation. Scope confirmation requires a pending Runtime Confirmation record plus a referenced user-message Trace Event; the application service commits both the confirmation answer and the state transition atomically.

### 5.3 Workflow State

The first slice implements one workflow, `coding-task-workflow`, with these stages:

```text
intake
task_affiliation_confirmation
draft_task_tree
task_tree_refinement
branch_confirmation
skeleton_pass
skeleton_gate
branch_implementation
branch_verification
root_verification
final_report
```

Transition rules are deterministic. A transition command carries the current workflow revision. Revision mismatch returns `revision_conflict`. Confirmation, skeleton gate, and execution-stage transitions require their declared evidence or confirmation reference.

The first slice records violations but does not broadly block Claude tools. In particular, a mutation before a confirmed executable scope creates a `workflow_violation` Trace Event. Claude Code's own permission system remains responsible for tool permission prompts.

### 5.4 Lifecycle Hooks and Trace

The plugin registers these initial events:

- `SessionStart`
- `UserPromptSubmit`
- `UserPromptExpansion`
- `PreToolUse`
- `PostToolUse`
- `PostToolUseFailure`
- `Stop`
- `StopFailure`
- `SessionEnd`

Each hook invocation sends JSON on stdin to one compiled hook entry point. The handler:

1. validates the minimum event envelope;
2. derives an idempotency key from session, event, tool-use identifier, and stable payload fields;
3. resolves the current Project in inspect or persist mode;
4. records only events relevant to an active Harness workflow, plus mutation violations that must not be lost;
5. redacts values whose keys indicate tokens, credentials, cookies, authorization, or API keys;
6. appends a Trace Event and updates the Artifact projection when applicable;
7. exits successfully without user-facing output unless a real hook error must be diagnosed.

Trace is append-only. Repeated delivery with the same idempotency key is ignored. Raw secrets are never persisted.

### 5.5 Artifact Projection

The first slice creates structural Artifacts for files and verification commands observed in Task planning or hooks. Contract Artifacts can be created from a draft Task Tree. Symbol Artifacts are accepted by the schema but are not inferred from source code.

Artifact projection stores current identity and status. Before/after details, command results, and failure output remain Trace evidence. `PostToolUse` and `PostToolUseFailure` update projections; `PreToolUse` records intent but does not claim an Artifact changed.

### 5.6 Runtime Introspection

The query service has three levels:

```ts
getRuntimeSnapshot(projectId): RuntimeSnapshot
getTaskTreeSummary(projectId, treeId): TaskTreeSummary
getTaskNodeDetail(projectId, nodeId, options): TaskNodeDetail
getTraceEvents(projectId, query): Page<TraceEventView>
```

Every query requires a Project derived from the caller's current working directory. IDs from another Project return `not_found` rather than revealing cross-project existence.

Snapshot returns the current workflow, selected Task Tree and node, pending confirmation, blocker counts, and available actions. Summary adds one-hop relations, planned versus observed Artifacts, and recent Trace counts. Detail is paginated and returns explicit evidence references.

### 5.7 Claude Skills

The plugin contains focused Skills:

- `task-tree-planning`
- `taskroot`
- `branch-execution`
- `verification-reporting`
- `drift-handling`

Skills describe trigger conditions and behavior. They do not duplicate database rules or invent current state. They query Snapshot first, then Summary or Detail only when required.

## 6. Initial Data Model

The first migration contains only tables used by this slice:

- `schema_migrations`
- `projects`
- `project_path_aliases`
- `task_trees`
- `task_tree_revisions`
- `draft_change_sets`
- `planning_decisions`
- `plan_readiness_results`
- `task_nodes`
- `task_node_revisions`
- `leaf_task_contracts`
- `skeleton_acceptance_criteria`
- `task_relation_edges`
- `artifacts`
- `artifact_relations`
- `workflow_states`
- `runtime_states`
- `runtime_actions`
- `runtime_confirmation_prompts`
- `trace_events`
- `hook_receipts`

JSON columns are stored as canonical JSON text. IDs are UUIDs created by the application layer. Timestamps use UTC ISO-8601 strings. Foreign keys are enforced. Immutable records have no update path other than status fields explicitly declared mutable by the domain.

## 7. MCP and CLI Surface

Initial MCP tools:

- `harness_get_runtime_snapshot`
- `harness_list_task_tree_candidates`
- `harness_create_task_root`
- `harness_save_draft_revision`
- `harness_apply_draft_change_set`
- `harness_scan_plan_readiness`
- `harness_create_confirmation_prompt`
- `harness_confirm_scope`
- `harness_get_task_tree_summary`
- `harness_get_task_node_detail`
- `harness_get_trace_events`

Initial CLI commands:

```text
harness doctor
harness project inspect [--cwd PATH]
harness taskroot NAME [--cwd PATH]
harness tree candidates [--cwd PATH]
harness tree snapshot [--cwd PATH]
harness tree summary TREE_ID [--cwd PATH]
harness tree readiness SCOPE_ID [--cwd PATH]
harness trace list [--limit N] [--cursor CURSOR] [--cwd PATH]
harness hook
harness mcp
```

CLI and MCP return stable JSON-compatible application results. Human-readable CLI output is a presenter layered over the same results.

## 8. Error Handling

Application errors use stable codes:

- `invalid_input`
- `project_identity_conflict`
- `project_not_registered`
- `not_found`
- `revision_conflict`
- `invalid_tree_structure`
- `leaf_contract_invalid`
- `relation_artifact_required`
- `workflow_transition_rejected`
- `database_busy`
- `storage_failure`

Expected domain errors are returned as structured results. Unexpected hook errors are written to stderr with secrets redacted and a non-zero exit code. A failed hook must not fabricate a successful Trace record.

## 9. Testing Strategy

Implementation follows test-driven development.

### 9.1 Unit tests

- Windows, WSL, and POSIX path normalization.
- Leaf Task Contract validation.
- Tree parent-cycle and reference validation.
- Relation-to-Artifact matrix validation.
- Workflow transition rules.
- secret redaction and hook idempotency keys.

### 9.2 Integration tests

- migrations and repository transactions against a temporary SQLite database;
- immutable Task Tree revisions;
- Project isolation for every query;
- hook event ingestion and Artifact projection;
- workflow violation recording without tool blocking;
- runtime Snapshot, Summary, and Detail results.

### 9.3 Plugin contract tests

- plugin manifest and hook JSON are parseable;
- every Skill has valid frontmatter and referenced tools;
- every hook command resolves inside `${CLAUDE_PLUGIN_ROOT}`;
- compiled runtime starts under Bash/WSL paths containing spaces and non-ASCII characters;
- MCP server advertises exactly the intended tool surface.

### 9.4 Manual smoke test

```bash
npm ci
npm run build
npm test
claude --plugin-dir ./plugin
```

Inside Claude Code, create a task root, persist a small draft tree, execute a harmless file change in a temporary fixture, and verify that Snapshot and Trace survive a restarted session.

## 10. Planned Repository Layout

```text
src/
├── domain/
│   ├── project.ts
│   ├── task-tree.ts
│   ├── workflow.ts
│   ├── trace.ts
│   └── artifact.ts
├── application/
│   ├── project-identity-service.ts
│   ├── task-tree-service.ts
│   ├── workflow-service.ts
│   ├── hook-ingestion-service.ts
│   └── runtime-query-service.ts
├── storage/
│   ├── database.ts
│   ├── migrations.ts
│   └── repositories.ts
├── bindings/claude/
│   ├── hook-entry.ts
│   ├── hook-mapper.ts
│   └── mcp-server.ts
└── cli/
    ├── main.ts
    └── presenter.ts
plugin/
├── .claude-plugin/plugin.json
├── .mcp.json
├── package.json
├── hooks/hooks.json
├── runtime/
└── skills/
    ├── task-tree-planning/SKILL.md
    ├── taskroot/SKILL.md
    ├── branch-execution/SKILL.md
    ├── verification-reporting/SKILL.md
    └── drift-handling/SKILL.md
tests/
├── unit/
├── integration/
└── plugin/
```

## 11. Slice Acceptance Criteria

The vertical slice is complete only when all of the following are demonstrated:

1. Loading the plugin does not create project Runtime Records during ordinary conversation.
2. The first persisted Harness action creates one marker and one Project record.
3. Task Tree candidates never cross the current Project boundary.
4. Saving an initial draft or applying a Draft Change Set creates a new immutable revision and validates every Leaf Task Contract.
5. Required Task Relation Edges cannot pass Plan Readiness without a valid Artifact reference.
6. Confirming a scope requires a pending confirmation plus the user's recorded answer, moves its draft Artifacts to planned, and advances Workflow State atomically.
7. Claude hook events are idempotently stored as redacted append-only Trace facts.
8. Successful and failed tool events update Trace without claiming unobserved success.
9. Snapshot, Summary, and Detail return progressively richer tree-centered results.
10. Runtime state and Trace remain available after Claude Code restarts.
11. All automated tests, type checking, build, plugin contract validation, and the manual smoke flow pass.

## 12. Known First-Slice Limitations

- Claude plugin Skills are namespaced and prompt-expanded; they are not indistinguishable from Claude built-in slash commands.
- Hook observations depend on events exposed by the installed Claude Code version.
- The first slice records workflow violations but does not enforce every Coding Constraint by blocking tools.
- Artifact projection is event-driven and scoped, not a complete model of the repository.
- Evaluation and Evolution conclusions are not produced until their later vertical slices.
