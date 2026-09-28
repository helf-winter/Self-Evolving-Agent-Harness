# Jev Evidence Semantic Evaluation Implementation Plan

1. Add the semantic snapshot, Jev answer, threshold, and provider-status domain contracts with deterministic aggregation tests.
2. Add migration v15 for immutable Semantic Evaluation Results and an optional Evaluation link.
3. Implement a bounded snapshot builder and a fetch-injected Jev provider with timeout, strict response validation, sanitized error mapping, and no secret persistence.
4. Implement the Semantic Evaluation service and expose configuration/readiness through the Runtime.
5. Gate proposed successful Evaluation on a current passed result only when Jev is explicitly enabled; preserve all existing deterministic gates.
6. Add MCP evaluate/query tools and update the verification Skill to invoke them before success evaluation when enabled.
7. Add unit, integration, MCP, restart, unavailable-provider, stale-snapshot, and default-disabled regression coverage.
8. Update README, SRS, and acceptance documentation; run `npm run check`, commit, fast-forward D:\code\创业\Agent-Harness, and push `origin/main`.
