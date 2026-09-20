# Trace Execution Context Design

**Status:** approved from SRS FR-009/013/014 and current Claude Code Hook contract

## Goal

Every recorded Trace Event carries a bounded snapshot of the runtime environment that produced it, without creating an Execution Session owner or copying model requests, responses, transcripts, or process environment secrets.

## Runtime semantics

- Execution Context is metadata owned by a Trace Event, not a task, lifecycle state, or independent business object.
- `runId` is the Agent runtime session ID already supplied by the Binding.
- The Claude Binding identifies itself as `claude-code-plugin`; `agentType` defaults to `claude-code` and uses the hook's explicit `agent_type` for named agents/subagents.
- `cwd` is taken from each hook event because Claude Code updates it after directory changes and worktree entry.
- `modelInfo` and `launchMethod` are learned from `SessionStart`; `PostModelSwitch` updates the current model. Later events inherit only the most recent persisted values from the same Project and run.
- Environment is an allowlisted summary: platform, architecture, Node version, permission mode, effort level, prompt ID, and optional agent ID. Arbitrary environment variables, transcript paths, scratchpad paths, API configuration, prompts, and model payloads are excluded.
- Missing optional Hook fields remain `null`; the Binding never invents a model identifier.

## Storage and query

Migration v12 adds `execution_context_json` to `trace_events`, defaulting legacy rows to `{}`. This keeps context immutable with the event and avoids a mutable session table.

Trace queries may filter by `runId` and return the decoded context on each item. Project scoping remains mandatory. Project Clone continues not to copy Trace Events, so Execution Context cannot be mistaken for a target Project run.

## Claude Hook compatibility

The mapper accepts current common fields (`prompt_id`, `permission_mode`, `effort`, `agent_id`, `agent_type`) plus `SessionStart` model/source and `PostModelSwitch` from/to/source. The plugin registers `PostModelSwitch` in addition to its existing lifecycle hooks. Unknown extra fields are ignored.

`PostModelSwitch` requires Claude Code 2.1.251 or later. The plugin therefore declares 2.1.251 as its minimum supported Claude Code version for this slice; older validators reject the event key rather than silently ignoring it.

## Failure and privacy rules

- Context participates in the existing Hook idempotency key, so a duplicate Hook cannot create a second fact.
- Context fields pass through the same recursive secret redaction used by Trace payloads.
- Invalid optional values are ignored rather than rejecting otherwise valid lifecycle evidence.
- No query can select another Project's context by run ID.
