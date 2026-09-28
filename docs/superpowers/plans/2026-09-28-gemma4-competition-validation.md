# Gemma 4 Competition Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an isolated, reproducible B0/B1 competition workspace that packages valid Gemma 4 agents and compares official verifier outcomes without changing the Agent Harness runtime.

**Architecture:** Versioned variant sources live under `competition/gemma4/experiments/variants/`; a standard-library Python tool deterministically materializes each variant into an immutable directory below `competition/gemma4/submission/`, validates it, fingerprints it, and builds a ZIP. Official harness output is normalized into an explicit result schema before B0/B1 aggregation, keeping infrastructure failures distinct from agent failures.

**Tech Stack:** Python 3.13 standard library (`dataclasses`, `hashlib`, `json`, `pathlib`, `shutil`, `unittest`, `zipfile`), official `swegemma`/ADK submission tools when downloaded, Gemma 4 competition YAML and Skills.

**Spec:** `docs/superpowers/specs/2026-09-28-gemma4-competition-validation-design.md`

## Global Constraints

- Competition code lives under `competition/gemma4/` and must not import from `src/`, invoke Claude MCP or Hooks, or read the Agent Harness SQLite database.
- B0 and B1 use only `gemma-4-31b-it-qat-w4a16-ct` and identical evaluation limits.
- Stage one uses no LoRA, no multi-agent delegation, no repository-specific policy, no Jev, and no persistent runtime.
- Python development utilities use only the standard library unless an official competition package owns the required operation.
- Competition data, snapshots, weights, Docker state, raw results, materialized submissions, ZIP archives, credentials, and secrets stay untracked.
- Reference `patch` and `test_patch` content must never enter prompts, Skills, resources, manifests, or committed reports.
- Materialization and packaging never delete or overwrite prior output; identical output is reusable and conflicting output fails closed.
- Existing `npm run check` behavior remains unchanged and must continue to pass.

## Review Focus

- A variant source containing a symlink or a path escaping its declared source root must be rejected before materialization (Task 2 tests).
- Re-running a fingerprint into an existing directory must verify byte identity and reject conflicts rather than overwrite files (Task 2 tests).
- B0 and B1 model names or evaluation limits drifting apart must fail contract validation (Task 4 tests).
- Submission resources containing verifier-only markers such as `test_patch` or reference-solution material must be rejected (Task 3 tests).
- Missing, malformed, or partial official result files must normalize to `infrastructure_failure`, never to an incorrect-patch verdict (Task 5 tests).

---

## File Structure

- Modify `.gitignore` — exclude all local competition inputs and generated outputs while retaining source variants, scripts, tests, and compact reports.
- Create `competition/gemma4/README.md` — document boundaries, prerequisites, local paths, commands, and authorization handoffs.
- Create `competition/gemma4/experiments/experiment-manifest.yaml` — JSON-syntax YAML manifest for standard-library parsing.
- Create `competition/gemma4/experiments/variants/b0/` — official-format minimal agent source.
- Create `competition/gemma4/experiments/variants/b1/` — official-format evidence-first agent source.
- Create `competition/gemma4/scripts/experiment_manifest.py` — load and validate experiment definitions.
- Create `competition/gemma4/scripts/materialize_variant.py` — immutable materialization and fingerprints.
- Create `competition/gemma4/scripts/package_submission.py` — package validation and deterministic ZIP creation.
- Create `competition/gemma4/scripts/analyze_results.py` — official-output normalization and B0/B1 summaries.
- Create `competition/gemma4/tests/` — standard-library unit and contract tests plus sanitized official-output fixtures.

### Task 1: Workspace boundary and experiment manifest

**Files:**
- Modify: `.gitignore`
- Create: `competition/gemma4/README.md`
- Create: `competition/gemma4/experiments/experiment-manifest.yaml`
- Create: `competition/gemma4/scripts/experiment_manifest.py`
- Create: `competition/gemma4/tests/test_experiment_manifest.py`

**Interfaces:**
- Consumes: JSON-syntax YAML at `competition/gemma4/experiments/experiment-manifest.yaml`.
- Produces: `Limits`, `VariantSpec`, `ExperimentManifest`, and `load_manifest(path: Path, workspace_root: Path) -> ExperimentManifest`.

- [ ] **Step 1: Write failing manifest and ignore-boundary tests**

  Cover schema version `1`, exact competition model, exactly `b0` and `b1`, positive integer limits, duplicate IDs, absolute paths, `..` traversal, sources outside `experiments/variants/`, and equality of B0/B1 limits. Assert `.gitignore` excludes `data/`, `downloads/`, `models/`, `results/`, `submission/`, `build/`, `*.zip`, and credential files only below `competition/gemma4/`. Source existence is intentionally deferred to materialization so Task 1 can commit the manifest before Task 4 creates official-format variants.

- [ ] **Step 2: Run the manifest tests and verify RED**

  Run: `python -m unittest competition/gemma4/tests/test_experiment_manifest.py -v`

  Expected: FAIL because the manifest loader and competition files do not exist.

- [ ] **Step 3: Implement the immutable manifest types and loader**

  Define:

  ```python
  @dataclass(frozen=True)
  class Limits:
      timeout_seconds: int
      max_tool_calls: int
      max_time_minutes: int
      max_turns: int

  @dataclass(frozen=True)
  class VariantSpec:
      variant_id: str
      source_dir: Path
      policy: str

  @dataclass(frozen=True)
  class ExperimentManifest:
      schema_version: int
      model: str
      limits: Limits
      variants: tuple[VariantSpec, ...]

  def load_manifest(path: Path, workspace_root: Path) -> ExperimentManifest: ...
  ```

  Store the manifest using JSON syntax so it remains valid YAML while `json.loads` parses it without a new dependency. Seed the shared limits as `timeout_seconds=300`, `max_tool_calls=40`, `max_time_minutes=4`, and `max_turns=80`.

- [ ] **Step 4: Add scoped ignore rules and the boundary README**

  Document that Kaggle sign-in/rule acceptance is manual, official downloads live outside Git, `submission/` is materialized output, and official-model equivalence must never be claimed for surrogate runs.

- [ ] **Step 5: Run tests and repository checks**

  Run: `python -m unittest competition/gemma4/tests/test_experiment_manifest.py -v`

  Expected: PASS.

  Run: `npm run check`

  Expected: existing TypeScript, Vitest, build, and plugin checks PASS unchanged.

- [ ] **Step 6: Commit**

  ```bash
  git add .gitignore competition/gemma4
  git commit -m "feat: define gemma4 experiment workspace"
  ```

### Task 2: Immutable variant materialization and fingerprints

**Files:**
- Create: `competition/gemma4/scripts/materialize_variant.py`
- Create: `competition/gemma4/tests/test_materialize_variant.py`

**Interfaces:**
- Consumes: `load_manifest(...)` and one `VariantSpec` source tree.
- Produces: `FileDigest`, `MaterializedVariant`, `compute_tree_fingerprint(source_dir: Path) -> tuple[str, tuple[FileDigest, ...]]`, and `materialize_variant(workspace_root: Path, manifest_path: Path, variant_id: str) -> MaterializedVariant`.

- [ ] **Step 1: Write failing materialization tests**

  Test stable SHA-256 fingerprints across creation order, sorted POSIX-relative paths, rejection of missing source directories, symlinks, and escaping paths, output location `submission/<variant_id>/<fingerprint>/`, idempotent reuse of byte-identical output, conflict rejection, and preservation of previous fingerprints.

- [ ] **Step 2: Run the materialization tests and verify RED**

  Run: `python -m unittest competition/gemma4/tests/test_materialize_variant.py -v`

  Expected: FAIL because the materializer is absent.

- [ ] **Step 3: Implement fingerprinting and immutable materialization**

  Define:

  ```python
  @dataclass(frozen=True)
  class FileDigest:
      path: str
      sha256: str
      size: int

  @dataclass(frozen=True)
  class MaterializedVariant:
      variant_id: str
      fingerprint: str
      path: Path
      files: tuple[FileDigest, ...]

  def compute_tree_fingerprint(source_dir: Path) -> tuple[str, tuple[FileDigest, ...]]: ...
  def materialize_variant(workspace_root: Path, manifest_path: Path, variant_id: str) -> MaterializedVariant: ...
  ```

  Hash normalized relative path bytes, a NUL separator, file length, and file contents in sorted order. Create new output atomically through a sibling temporary directory; rename only after complete verification and never remove an existing output.

- [ ] **Step 4: Run focused and combined Python tests**

  Run: `python -m unittest competition/gemma4/tests/test_materialize_variant.py -v`

  Expected: PASS.

  Run: `python -m unittest discover -s competition/gemma4/tests -v`

  Expected: all current competition tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add competition/gemma4/scripts/materialize_variant.py competition/gemma4/tests/test_materialize_variant.py
  git commit -m "feat: materialize immutable gemma4 variants"
  ```

### Task 3: Submission validation and deterministic packaging

**Files:**
- Create: `competition/gemma4/scripts/package_submission.py`
- Create: `competition/gemma4/tests/test_package_submission.py`

**Interfaces:**
- Consumes: one materialized variant directory from Task 2.
- Produces: `ValidationIssue`, `ArchiveResult`, `validate_submission(root: Path) -> tuple[ValidationIssue, ...]`, and `build_archive(root: Path, output_path: Path) -> ArchiveResult`.

- [ ] **Step 1: Write failing validator and archive tests**

  Test required root `agent.yaml`, optional `eval_config.yaml`, allowed roots (`configs`, `prompts`, `skills`, `sub_agents`, `adapters`), stage-one file types, missing and empty files, symlinks, oversized aggregate content, traversal-safe archive names, sorted entries, fixed ZIP timestamps, stable archive SHA-256 with `ZIP_STORED`, byte-identical archive reuse, conflicting-output rejection, and detection of `test_patch`, embedded reference fixes, private keys, API keys, and credential filenames.

- [ ] **Step 2: Run packaging tests and verify RED**

  Run: `python -m unittest competition/gemma4/tests/test_package_submission.py -v`

  Expected: FAIL because validation and packaging functions do not exist.

- [ ] **Step 3: Implement validation**

  Define:

  ```python
  @dataclass(frozen=True)
  class ValidationIssue:
      code: str
      path: str
      message: str

  @dataclass(frozen=True)
  class ArchiveResult:
      path: Path
      sha256: str
      size: int
      entries: tuple[str, ...]

  def validate_submission(root: Path) -> tuple[ValidationIssue, ...]: ...
  def build_archive(root: Path, output_path: Path) -> ArchiveResult: ...
  ```

  Stage one accepts text/config/Python Skill files only; adapter support remains structurally recognized but absent. The official compiler remains authoritative for ADK semantics.

- [ ] **Step 4: Run focused and combined Python tests**

  Run: `python -m unittest competition/gemma4/tests/test_package_submission.py -v`

  Expected: PASS.

  Run: `python -m unittest discover -s competition/gemma4/tests -v`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add competition/gemma4/scripts/package_submission.py competition/gemma4/tests/test_package_submission.py
  git commit -m "feat: validate gemma4 submission archives"
  ```

### Task 4: Official-format B0 and B1 variants

**Files:**
- Create: `competition/gemma4/experiments/variants/b0/agent.yaml`
- Create: `competition/gemma4/experiments/variants/b0/eval_config.yaml`
- Create: `competition/gemma4/experiments/variants/b0/prompts/system.md`
- Create: `competition/gemma4/experiments/variants/b1/agent.yaml`
- Create: `competition/gemma4/experiments/variants/b1/eval_config.yaml`
- Create: `competition/gemma4/experiments/variants/b1/prompts/system.md`
- Create: `competition/gemma4/experiments/variants/b1/skills/evidence-first/SKILL.md`
- Create: `competition/gemma4/tests/test_variant_contracts.py`

**Interfaces:**
- Consumes: the official downloaded `sample_submission/`, `HARNESS_README.md`, and official ADK submission compiler; manual Kaggle rule acceptance is a prerequisite.
- Produces: two compilable source trees selected by the Task 1 manifest and accepted by Tasks 2–3.

- [ ] **Step 1: Stop at the authorization/data boundary when official files are unavailable**

  Check only for locally supplied official data and packages. If missing, report the exact manual actions required: join the competition, accept its rules, download `HARNESS_README.md`, `sample_submission/`, public task data, and the official wheelhouse. Do not sign in, accept rules, create credentials, or substitute third-party schemas.

- [ ] **Step 2: Write failing variant contract tests from the official sample**

  Assert both variants name only `gemma-4-31b-it-qat-w4a16-ct`; expose the official tools `run_command`, `read_file`, `edit_file`, `write_file`, `get_status`, and `submit_patch`; use limits `300/40/4/80`; compile through the official tool; and differ only in their policy prompt/Skill surface. Assert B0 contains no evidence-first Skill and B1 contains exactly one Skill named `evidence-first`.

- [ ] **Step 3: Run the contract tests and verify RED**

  Run: `python -m unittest competition/gemma4/tests/test_variant_contracts.py -v`

  Expected: FAIL because the variants are absent.

- [ ] **Step 4: Implement B0 by adapting the official sample minimally**

  Preserve the official config schema and root layout. The B0 prompt instructs inspect, identify the smallest complete change, run relevant verification, inspect the diff, call `get_status` before budget exhaustion, and call `submit_patch`; it adds no Agent Harness terminology or hidden state machine.

- [ ] **Step 5: Implement B1 as the single controlled delta**

  Add a compact `evidence-first` Skill requiring an inspected or reproduced evidence statement before editing, focused verification before broader checks, smallest behaviorally complete edits, final diff review, and explicit uncertainty handling. Keep model, tools, sampling, and limits byte-equivalent to B0 where the official schema permits.

- [ ] **Step 6: Materialize, validate, compile, and package both variants**

  Run the Task 2 materializer and Task 3 packager for B0 and B1, then the official compiler for each materialized directory.

  Expected: two valid archives with distinct recorded fingerprints and no validation issues.

- [ ] **Step 7: Run all local checks**

  Run: `python -m unittest discover -s competition/gemma4/tests -v`

  Expected: PASS.

  Run: `npm run check`

  Expected: PASS unchanged.

- [ ] **Step 8: Commit**

  ```bash
  git add competition/gemma4/experiments competition/gemma4/tests/test_variant_contracts.py
  git commit -m "feat: add gemma4 baseline experiment variants"
  ```

### Task 5: Official result normalization and comparison

**Files:**
- Create: `competition/gemma4/scripts/analyze_results.py`
- Create: `competition/gemma4/tests/fixtures/results/`
- Create: `competition/gemma4/tests/test_analyze_results.py`

**Interfaces:**
- Consumes: sanitized fixtures derived from the exact official harness version used in Task 4 plus run metadata containing variant and fingerprint.
- Produces: `TaskResult`, `VariantSummary`, `ComparisonSummary`, `normalize_run(results_dir: Path, variant_id: str, fingerprint: str) -> tuple[TaskResult, ...]`, and `compare_variants(b0: tuple[TaskResult, ...], b1: tuple[TaskResult, ...]) -> ComparisonSummary`.

- [ ] **Step 1: Produce sanitized official-output fixtures**

  Run the official no-inference control paths to capture passed-schema, failed-schema, `NO_PATCH`, timeout, and incomplete/infrastructure examples without source code, patches, hidden tests, credentials, or large logs. Commit only minimal JSON fixtures.

- [ ] **Step 2: Write failing normalization and aggregation tests**

  Define exact normalized outcomes `passed`, `failed`, `no_patch`, `timeout`, and `infrastructure_failure`. Test patch presence, elapsed seconds, model turns, tool calls, focused/broader verification flags, failure categories, mismatched task sets, duplicate task IDs, fingerprint mismatch, partial official output, and paired B0/B1 deltas.

- [ ] **Step 3: Run analyzer tests and verify RED**

  Run: `python -m unittest competition/gemma4/tests/test_analyze_results.py -v`

  Expected: FAIL because the analyzer is absent.

- [ ] **Step 4: Implement normalization and comparison**

  Define:

  ```python
  @dataclass(frozen=True)
  class TaskResult:
      task_id: str
      variant_id: str
      fingerprint: str
      outcome: str
      patch_present: bool
      elapsed_seconds: float
      model_turns: int
      tool_calls: int
      focused_test_attempted: bool
      broader_test_attempted: bool
      failure_category: str | None

  @dataclass(frozen=True)
  class VariantSummary:
      variant_id: str
      fingerprint: str
      total_tasks: int
      passed: int
      failed: int
      no_patch: int
      timeouts: int
      infrastructure_failures: int
      total_elapsed_seconds: float
      total_model_turns: int
      total_tool_calls: int
      focused_test_attempts: int
      broader_test_attempts: int

  @dataclass(frozen=True)
  class ComparisonSummary:
      b0: VariantSummary
      b1: VariantSummary
      paired_task_ids: tuple[str, ...]
      pass_delta: int
      elapsed_seconds_delta: float
      tool_call_delta: int
      outcome_changes: tuple[tuple[str, str, str], ...]

  def normalize_run(results_dir: Path, variant_id: str, fingerprint: str) -> tuple[TaskResult, ...]: ...
  def compare_variants(
      b0: tuple[TaskResult, ...],
      b1: tuple[TaskResult, ...],
  ) -> ComparisonSummary: ...
  ```

  Only official verifier output may produce `passed` or `failed`; missing required fields produce `infrastructure_failure`.

- [ ] **Step 5: Run focused and full checks**

  Run: `python -m unittest competition/gemma4/tests/test_analyze_results.py -v`

  Expected: PASS.

  Run: `python -m unittest discover -s competition/gemma4/tests -v`

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add competition/gemma4/scripts/analyze_results.py competition/gemma4/tests
  git commit -m "feat: compare gemma4 verifier outcomes"
  ```

### Task 6: Smoke test, fixed probe, and continuation report

**Files:**
- Modify: `competition/gemma4/README.md`
- Modify: `competition/gemma4/experiments/experiment-manifest.yaml`
- Create when evidence exists: `competition/gemma4/experiments/reports/2026-<run-date>-b0-b1-probe.md`

**Interfaces:**
- Consumes: packaged B0/B1 archives, official public tasks/snapshots, official model endpoint, and Task 5 analyzer.
- Produces: reproducible commands, a locked ten-task probe definition, a compact comparison report, and a continue/revise/stop decision.

- [ ] **Step 1: Validate the local official environment without inference**

  Record official package versions. Run unchanged-repository and reference-patch controls on one documented public task through official harness paths that keep verifier material away from the agent.

  Expected: unchanged control does not pass; reference patch passes. Any other result is infrastructure failure and blocks inference experiments.

- [ ] **Step 2: Run one B0 end-to-end smoke task**

  Use the exact B0 fingerprint and locked limits. Confirm model loading, tool calls, repository setup, patch extraction, independent verification, and result normalization all complete.

- [ ] **Step 3: Lock the ten-task probe before comparing variants**

  Add task IDs and a short pre-result selection rationale to the manifest. Include more than one public repository and group any shared `repo + base_commit` records. Commit this selection before running B1.

- [ ] **Step 4: Run B0 and B1 on the identical probe**

  Use identical official package versions, model, limits, task order, and environment. Keep raw output untracked and retain both fingerprints in run metadata.

- [ ] **Step 5: Generate and inspect the compact report**

  Report per-task official outcomes, valid-patch/`NO_PATCH` counts, focused and broader verification attempts, elapsed time, model turns, tool calls, timeouts, infrastructure failures, and paired deltas. Do not claim statistical significance from ten tasks.

- [ ] **Step 6: Apply the continuation gate**

  Record exactly one decision: `continue`, `revise`, or `stop`. Continue only if the end-to-end path is reliable, B0 is interpretable, B1 changes behavior as intended, and results show either a credible positive signal or one specific revision hypothesis without product-runtime coupling.

- [ ] **Step 7: Run final verification**

  Run: `python -m unittest discover -s competition/gemma4/tests -v`

  Expected: PASS.

  Run: `npm run check`

  Expected: PASS.

  Run: `git diff --check`

  Expected: no output.

- [ ] **Step 8: Commit the reproducible report and documentation**

  ```bash
  git add competition/gemma4/README.md competition/gemma4/experiments/experiment-manifest.yaml competition/gemma4/experiments/reports
  git commit -m "docs: report gemma4 baseline probe"
  ```
