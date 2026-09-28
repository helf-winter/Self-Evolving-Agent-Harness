# Task Affiliation Confirmation — Design

## Goal

Make the mandatory “new Task Tree or merge into an existing Task Tree” choice a durable Runtime flow instead of a transient chat convention.

## Flow

1. The Agent identifies a coding request and calls the affiliation proposal tool with a concise request title, deterministic candidate query, recommendation, and optional recommended tree.
2. Runtime creates the Project when necessary, computes the candidate snapshot itself, records an affiliation-request Trace and a high-risk Runtime Action, and creates exactly one pending confirmation.
3. No Task Tree is created or selected yet.
4. While the confirmation is pending, the next `UserPromptSubmit` is recorded even though no Workflow exists yet.
5. The Agent resolves the explicit choice as `new_tree`, `merge`, or `pause`, binding the answer Trace.
6. `new_tree` creates and selects a new root; `merge` selects a current non-archived tree in the same Project; `pause` changes no Task Tree state.

## Rules

- A Project may have at most one pending affiliation decision, preventing short replies from binding ambiguously.
- Candidate snapshots are code-computed and bounded; Agent recommendations do not alter them.
- A merge target is revalidated at resolution time and must still belong to the same Project and be non-archived.
- Answer Trace must be a later `UserPromptSubmit` in the same Project.
- Resolution is idempotent and survives restart.
- The request record stores a concise user-visible summary, not hidden reasoning or a model transcript.

