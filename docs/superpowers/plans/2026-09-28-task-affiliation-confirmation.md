# Task Affiliation Confirmation — Implementation Plan

## Task 1: Persist affiliation facts

- Add migration and constrained domain types.
- Store proposal, deterministic candidate snapshot, Runtime Action, confirmation reference, answer evidence, and result.
- Test one-pending-decision and Project isolation rules.

## Task 2: Execute confirmed choices

- Add service operations to propose and resolve affiliation.
- Keep proposal side-effect free with respect to Task Tree creation/selection.
- Execute `new_tree`, `merge`, or `pause` only after valid answer evidence.

## Task 3: Bind Hooks and MCP

- Record `UserPromptSubmit` while an affiliation confirmation is pending even before a Workflow exists.
- Expose propose, resolve, list, and detail tools.
- Update the planning Skill to use the Runtime flow.

## Task 4: Verify the vertical slice

- Add restart E2E coverage for new, merge, pause, stale/foreign target, and ambiguous pending decisions.
- Update README and acceptance instructions.
- Run the complete quality gate.

