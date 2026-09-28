# Jev Evidence Semantic Evaluation Design

## Goal

Add an optional TypeSafe Jev provider that judges whether the bounded evidence attached to an Execution Attempt semantically supports its required evidence and acceptance criteria. Jev augments Evaluation; it never writes Task Node state or replaces deterministic lifecycle policy.

## Runtime contract

1. Jev is enabled only when `HARNESS_JEV_ENABLED=true`; `TYPESAFE_API_KEY` alone does not activate external requests.
2. The provider uses the pinned `jev-1.13.0` model and `POST https://api.typesafe.ai/v1/systemone`.
3. The outbound snapshot contains Task/acceptance text plus bounded evidence metadata: event kind, tool kind, Artifact references, boolean outcome, exit code, and required-evidence association. It excludes source code, complete command output, transcripts, arbitrary environment variables, and secrets.
4. Each required-evidence item becomes one independent Choice question with `supported`, `unsupported`, and `insufficient_context` outcomes. Code applies configured probability and confidence thresholds.
5. Provider success, review, and unavailability are persisted as immutable Semantic Evaluation Results with model, probabilities, confidence, token usage, latency, snapshot hash, and sanitized error code.
6. When Jev is enabled, a proposed successful Evaluation requires a current `passed` semantic result for the same Attempt and evidence snapshot. Missing, stale, review, timeout, provider error, or malformed response deterministically downgrades the verdict to `uncertain`.
7. Failed or blocked evaluations do not require Jev. Jev never upgrades a deterministic failure or bypasses missing evidence, dependencies, children, revision, or blocking-drift gates.

## Configuration

- `HARNESS_JEV_ENABLED`: exact `true` enables the provider; default disabled.
- `TYPESAFE_API_KEY`: read only from the process environment and never persisted.
- `HARNESS_JEV_TIMEOUT_MS`: optional bounded timeout, default 10 seconds.
- `HARNESS_JEV_MIN_PROBABILITY`: optional threshold, default 0.7.
- `HARNESS_JEV_MIN_CONFIDENCE`: optional threshold, default 0.5.

The endpoint and model are code-pinned for reproducibility in this slice. A later version upgrade requires an explicit code/document change and regression run.

## Interfaces

- `harness_evaluate_attempt_semantics`: build the safe snapshot, call Jev when enabled, and persist one immutable result.
- `harness_get_semantic_evaluations`: list results for the current Project or inspect one Attempt.
- Runtime Snapshot exposes only provider readiness (`disabled`, `ready`, or `misconfigured`), model, and thresholds; it never exposes the key.

## Failure behavior

Provider failures are data, not process crashes. Authentication, timeout, rate limit, overload, network, and response-schema failures produce `unavailable` results with sanitized codes. The caller receives the persisted result and deterministic Evaluation remains fail-closed as `uncertain` for proposed success.
