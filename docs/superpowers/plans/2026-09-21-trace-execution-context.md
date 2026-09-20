# Trace Execution Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task. Subagent delegation remains disabled for this session.

**Goal:** Implement SRS FR-013 as immutable, privacy-bounded Execution Context metadata on every recorded Trace Event.

**Architecture:** Extend the Claude Hook mapper with documented runtime fields. Build a normalized context snapshot in `HookIngestionService`, inheriting session-level model/launch facts from the latest event in the same Project/run. Persist the snapshot in Trace migration v12 and expose project-scoped run filtering through Runtime Query and MCP.

**Spec:** `docs/superpowers/specs/2026-09-21-trace-execution-context-design.md`.

### Task 1: Domain mapping and migration

Add Execution Context types/normalization, map current Claude Hook fields, add migration v12, and cover legacy migration plus mapper normalization with failing-first tests. Commit `feat: define trace execution context`.

### Task 2: Hook persistence and model continuity

Persist redacted context snapshots, carry SessionStart model/launch facts forward, update them on PostModelSwitch, and verify idempotency/project isolation. Commit `feat: persist trace execution context`.

### Task 3: Query, Binding, E2E, and docs

Add run-scoped Trace query, MCP schema, PostModelSwitch hook registration, cross-restart E2E, README/acceptance documentation, then run `npm run check`, `claude plugin validate ./plugin`, and `git diff --check`. Commit `docs: complete trace execution context`.

