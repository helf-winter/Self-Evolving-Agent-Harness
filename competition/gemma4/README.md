# Gemma 4 Competition Validation

This directory is an isolated experiment surface for comparing two Agent
Harness execution policies with the official Gemma 4 Developer Agent harness.
It is not part of the product runtime and must not import `src/`, call the
Claude MCP server, consume lifecycle Hooks, or read the Harness database.

## Boundaries

- `experiments/variants/` contains versioned B0/B1 source packages.
- `scripts/` contains deterministic, standard-library development utilities.
- `tests/` contains local contract tests and sanitized fixtures only.
- `data/`, `downloads/`, `models/`, `results/`, `submission/`, `build/`, ZIP
  archives, credentials, and `.env` files are local-only and ignored by Git.
- Reference patches and `test_patch` content are verifier-only and must never
  enter prompts, Skills, manifests, or committed reports.

## Manual prerequisites

The repository does not automate account actions. Before official validation,
the operator must join the competition, accept its rules, and download the
official `HARNESS_README.md`, `sample_submission/`, public task data, and
wheelhouse into the ignored local directories documented by the official
instructions.

Surrogate models can be used for development diagnostics, but their results
must never be described as equivalent to the official
`gemma-4-31b-it-qat-w4a16-ct` evaluation.

## Local checks

```bash
python -m unittest discover -s competition/gemma4/tests -v
npm run check
```

Materialization, packaging, official compilation, and result-analysis commands
will be added alongside their corresponding scripts. Generated submissions are
fingerprint-addressed and are never overwritten.
