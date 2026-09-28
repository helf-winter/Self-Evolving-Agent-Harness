# Gemma 4 Competition Validation Design

## Goal

Use the Gemma 4 Developer Agent main competition as a standardized external
validation environment for selected Agent Harness execution policies. The
competition work is an experiment surface, not a second product and not a port
of the full long-lived runtime.

The first experiment must answer three questions:

1. Can a valid competition agent reliably produce patches under the official
   harness?
2. Does an evidence-first policy improve patch outcomes over a minimal agent?
3. Is any observed improvement worth its time and tool-call cost?

Leaderboard position, LoRA training, and paper-track output are not first-stage
success criteria.

## Architectural boundary

Competition assets live under `competition/gemma4/` in this repository. They
must not import from `src/`, call the Claude MCP server, depend on lifecycle
Hooks, or read the Agent Harness SQLite database. This keeps official harness
constraints from reshaping the product runtime and makes each competition
submission independently inspectable.

The repository records experiment definitions and compact derived reports.
Competition data, repository snapshots, model weights, Docker storage, raw
result directories, generated archives, credentials, and secrets remain local
and ignored by Git.

## Directory contract

```text
competition/gemma4/
├── submission/
│   ├── agent.yaml
│   ├── eval_config.yaml
│   ├── prompts/
│   │   └── system.md
│   └── skills/
├── scripts/
│   ├── validate_submission.py
│   └── analyze_results.py
├── experiments/
│   └── experiment-manifest.yaml
└── README.md
```

`submission/` is the only source directory for `submission.zip`. Validation
must reject path traversal, symlinks, unexpected generated files, missing root
configuration, and content that is outside the competition's allowed package
surface.

`scripts/` contains development utilities only. They do not enter the archive
and must use the Python standard library unless an official competition package
already provides the required behavior.

`experiments/` stores versioned experiment definitions. Raw evaluator output
stays outside Git. A compact derived report may be committed later only when it
contains no competition secrets, hidden-test content, credentials, or large
artifacts.

## Initial variants

The first stage contains exactly two variants:

- **B0 — minimal baseline:** one Gemma 4 agent using the official repository
  inspection, command, editing, status, and patch-submission tools. Its prompt
  gives only the minimum workflow necessary to inspect, patch, verify, and
  submit.
- **B1 — evidence-first:** B0 plus a compact policy requiring the agent to
  connect the issue to inspected or reproduced repository evidence before the
  first edit, prefer the smallest behaviorally complete patch, run focused
  verification before broader checks, inspect the final diff, and submit only
  after evaluating remaining uncertainty.

B1 must remain a prompt or competition Skill policy. It must not recreate the
Task Tree database, confirmation flow, Artifact Graph persistence, Project
identity, Plugin composition, Skill evolution, Jev integration, or other
long-lived Agent Harness services.

Multi-agent delegation, graph-specialized variants, repository-specific
instructions, and LoRA adapters are deferred until B0 and B1 produce stable,
interpretable results.

## Experiment flow

```text
official task + repository snapshot
                ↓
        locked variant package
                ↓
       official swegemma harness
                ↓
 raw trajectory + patch + verifier result
                ↓
 deterministic result summarization
                ↓
 B0/B1 comparison and continuation decision
```

Each experiment record identifies:

- variant and immutable configuration fingerprint;
- official harness/package versions;
- task IDs and selection rationale;
- per-task limits and global run settings;
- outcome, patch presence, elapsed time, model turns, and tool calls;
- whether focused and broader verification were attempted;
- failure category when the task did not pass.

The analysis script summarizes recorded outputs; it does not infer success from
agent prose. The official verifier result is the primary outcome.

## Task selection and leakage control

Development begins with one official smoke-test task, then a fixed ten-task
probe set. The probe set should cover more than one public repository and a
range of issue shapes without selecting tasks based on which variant already
solves them.

Reference patches and `test_patch` may be used only by the official local
verification path. They must never be copied into prompts, Skills, resources,
or task-specific hints. Experiment reports must distinguish agent-visible task
inputs from verifier-only material.

If the work proceeds beyond the first probe, task splits must group related
`repo + base_commit` records so related snapshots do not cross development and
holdout boundaries.

## Metrics

The primary metric is official patch PASS rate.

Secondary outcome metrics are:

- valid patch rate;
- `NO_PATCH` rate;
- focused-test execution rate;
- broader-test execution rate;
- regression or verification-failure rate;
- stable failure categories.

Cost metrics are elapsed time, model turns, tool calls, and timeout rate. A B1
improvement is not treated as useful when it consumes enough budget to reduce
the number of tasks that can be attempted under the competition-wide limit.

## Failure handling

Setup and evaluation fail closed:

- missing competition data, official packages, or accepted Kaggle access stops
  the affected step with an actionable message;
- the project never accepts competition rules, signs in, or handles account
  credentials automatically;
- unavailable model inference does not fall back silently to a different model
  while labeling the result as competition-equivalent;
- malformed or incomplete evaluator output is recorded as infrastructure
  failure, not agent failure;
- timeouts and sandbox failures remain separate from incorrect patches.

The development scripts must not delete downloaded data, Docker state, model
caches, or prior experiment output.

## Verification strategy

Verification proceeds in increasing cost order:

1. static validation of the submission directory and archive layout;
2. configuration compilation with the official submission tooling when
   available;
3. no-inference control checks supplied by the official harness;
4. one-task end-to-end smoke test;
5. fixed ten-task B0 run;
6. the same ten-task B1 run under identical limits;
7. comparison of verifier outcomes and resource use.

Scripts receive unit tests for deterministic packaging, manifest validation,
result parsing, aggregation, and secret/reference-answer exclusion. Existing
Agent Harness checks remain unchanged and must continue to pass.

## First-stage deliverables

The first stage produces:

- a valid minimal submission package;
- B0 and B1 configurations with explicit fingerprints;
- reproducible commands for setup, packaging, smoke testing, and probe runs;
- a ten-task comparison report containing official outcomes and cost metrics;
- a written decision to continue, revise, or stop competition work.

## Continuation gate

Continue beyond the first stage only when all of the following hold:

- the official end-to-end path runs reliably;
- B0 produces valid patches and interpretable trajectories;
- B1 behavior is observably different from B0 in the intended way;
- the comparison yields a credible positive signal or a specific, testable
  revision hypothesis;
- maintaining the competition surface has not introduced dependencies into the
  product runtime.

Pause competition work when the environment remains unstable, the results
cannot distinguish policy effects from infrastructure failures, or further
work would require product architecture changes unsupported by benchmark
evidence.

## Explicit non-goals

The first stage does not:

- optimize for leaderboard rank;
- submit to the paper track;
- train or package LoRA adapters;
- build a general benchmark platform;
- implement a second persistent Agent Harness runtime;
- add product features solely to improve competition performance;
- automate Kaggle account actions or final submission selection.
