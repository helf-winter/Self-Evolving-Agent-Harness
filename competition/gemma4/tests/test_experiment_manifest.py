from __future__ import annotations

import importlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


EXPECTED_MODEL = "gemma-4-31b-it-qat-w4a16-ct"


def load_api():
    try:
        return importlib.import_module("competition.gemma4.scripts.experiment_manifest")
    except ModuleNotFoundError as error:
        raise AssertionError("experiment_manifest module must exist") from error


def valid_payload() -> dict[str, object]:
    return {
        "schema_version": 1,
        "model": EXPECTED_MODEL,
        "limits": {
            "timeout_seconds": 300,
            "max_tool_calls": 40,
            "max_time_minutes": 4,
            "max_turns": 80,
        },
        "variants": [
            {
                "id": "b0",
                "source": "experiments/variants/b0",
                "policy": "minimal",
            },
            {
                "id": "b1",
                "source": "experiments/variants/b1",
                "policy": "evidence-first",
            },
        ],
    }


class ExperimentManifestTests(unittest.TestCase):
    def write_manifest(self, root: Path, payload: dict[str, object]) -> Path:
        path = root / "experiments" / "experiment-manifest.yaml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_loads_locked_b0_b1_contract_without_requiring_sources_yet(self) -> None:
        api = load_api()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = api.load_manifest(self.write_manifest(root, valid_payload()), root)

        self.assertEqual(manifest.schema_version, 1)
        self.assertEqual(manifest.model, EXPECTED_MODEL)
        self.assertEqual(manifest.limits.timeout_seconds, 300)
        self.assertEqual(manifest.limits.max_tool_calls, 40)
        self.assertEqual(manifest.limits.max_time_minutes, 4)
        self.assertEqual(manifest.limits.max_turns, 80)
        self.assertEqual(tuple(item.variant_id for item in manifest.variants), ("b0", "b1"))
        self.assertEqual(tuple(item.policy for item in manifest.variants), ("minimal", "evidence-first"))

    def test_rejects_invalid_schema_model_ids_limits_and_paths(self) -> None:
        api = load_api()
        mutations = {
            "schema": lambda value: value.update(schema_version=2),
            "model": lambda value: value.update(model="surrogate-model"),
            "missing_variant": lambda value: value["variants"].pop(),
            "duplicate_variant": lambda value: value.update(
                variants=[value["variants"][0], value["variants"][0]]
            ),
            "unexpected_variant": lambda value: value["variants"][1].update(id="b2"),
            "zero_limit": lambda value: value["limits"].update(max_turns=0),
            "boolean_limit": lambda value: value["limits"].update(max_turns=True),
            "absolute_path": lambda value: value["variants"][0].update(source="/tmp/b0"),
            "traversal": lambda value: value["variants"][0].update(
                source="experiments/variants/../b0"
            ),
            "outside_variants": lambda value: value["variants"][0].update(
                source="experiments/b0"
            ),
            "variant_limits": lambda value: value["variants"][0].update(
                limits={"max_turns": 1}
            ),
        }

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, mutate in mutations.items():
                with self.subTest(name=name):
                    payload = valid_payload()
                    mutate(payload)
                    path = self.write_manifest(root, payload)
                    with self.assertRaises(ValueError):
                        api.load_manifest(path, root)

    def test_repository_manifest_matches_the_locked_contract(self) -> None:
        api = load_api()
        repo_root = Path(__file__).resolve().parents[3]
        workspace = repo_root / "competition" / "gemma4"
        manifest = api.load_manifest(
            workspace / "experiments" / "experiment-manifest.yaml",
            workspace,
        )
        self.assertEqual(manifest.model, EXPECTED_MODEL)
        self.assertEqual(tuple(item.variant_id for item in manifest.variants), ("b0", "b1"))

    def test_gitignore_scopes_local_competition_artifacts(self) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        ignored = (
            "competition/gemma4/data/task.json",
            "competition/gemma4/downloads/HARNESS_README.md",
            "competition/gemma4/models/model.bin",
            "competition/gemma4/results/run.json",
            "competition/gemma4/submission/b0/archive.zip",
            "competition/gemma4/build/tmp.txt",
            "competition/gemma4/variant.zip",
            "competition/gemma4/credentials.json",
            "competition/gemma4/.env.local",
        )
        for relative in ignored:
            with self.subTest(relative=relative):
                result = subprocess.run(
                    ["git", "check-ignore", "-q", relative],
                    cwd=repo_root,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, relative)

        result = subprocess.run(
            ["git", "check-ignore", "-q", "competition/gemma4/experiments/variants/b0/agent.yaml"],
            cwd=repo_root,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
