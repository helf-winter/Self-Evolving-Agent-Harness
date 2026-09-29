from __future__ import annotations

import importlib
import json
import os
import tempfile
import unittest
from pathlib import Path


def load_api():
    try:
        return importlib.import_module("competition.gemma4.scripts.materialize_variant")
    except ModuleNotFoundError as error:
        raise AssertionError("materialize_variant module must exist") from error


def write_manifest(root: Path) -> Path:
    path = root / "experiments" / "experiment-manifest.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "model": "gemma-4-31b-it-qat-w4a16-ct",
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
        ),
        encoding="utf-8",
    )
    return path


def write_source(root: Path, variant_id: str, files: dict[str, bytes]) -> Path:
    source = root / "experiments" / "variants" / variant_id
    for relative, content in files.items():
        target = source / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    return source


class MaterializeVariantTests(unittest.TestCase):
    def test_fingerprint_is_stable_sorted_and_sensitive_to_paths_and_bytes(self) -> None:
        api = load_api()
        with tempfile.TemporaryDirectory() as first_dir, tempfile.TemporaryDirectory() as second_dir:
            first = Path(first_dir)
            second = Path(second_dir)
            (first / "z").mkdir()
            (first / "z" / "b.txt").write_bytes(b"second")
            (first / "a.txt").write_bytes(b"first")
            (second / "a.txt").write_bytes(b"first")
            (second / "z").mkdir()
            (second / "z" / "b.txt").write_bytes(b"second")

            first_fingerprint, first_files = api.compute_tree_fingerprint(first)
            second_fingerprint, second_files = api.compute_tree_fingerprint(second)

            self.assertEqual(first_fingerprint, second_fingerprint)
            self.assertEqual(first_files, second_files)
            self.assertEqual(tuple(item.path for item in first_files), ("a.txt", "z/b.txt"))

            (second / "z" / "b.txt").write_bytes(b"changed")
            changed_fingerprint, _ = api.compute_tree_fingerprint(second)
            self.assertNotEqual(changed_fingerprint, first_fingerprint)

    def test_rejects_missing_empty_and_symlinked_source_content(self) -> None:
        api = load_api()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                api.compute_tree_fingerprint(root / "missing")

            empty = root / "empty"
            empty.mkdir()
            with self.assertRaises(ValueError):
                api.compute_tree_fingerprint(empty)

            outside = root / "outside.txt"
            outside.write_text("outside", encoding="utf-8")
            source = root / "source"
            source.mkdir()
            link = source / "escape.txt"
            try:
                os.symlink(outside, link)
            except OSError as error:
                self.skipTest(f"symlink creation unavailable: {error}")
            with self.assertRaises(ValueError):
                api.compute_tree_fingerprint(source)

    def test_materializes_to_fingerprint_path_and_reuses_identical_output(self) -> None:
        api = load_api()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(root)
            write_source(root, "b0", {"agent.yaml": b"agent: b0\n", "prompts/a.md": b"A\n"})
            write_source(root, "b1", {"agent.yaml": b"agent: b1\n"})

            first = api.materialize_variant(root, manifest_path, "b0")
            second = api.materialize_variant(root, manifest_path, "b0")

            self.assertEqual(first, second)
            self.assertEqual(first.path, root / "submission" / "b0" / first.fingerprint)
            self.assertEqual((first.path / "agent.yaml").read_bytes(), b"agent: b0\n")
            self.assertFalse(any(first.path.parent.glob(".*.tmp-*")))

    def test_rejects_conflicting_existing_output_without_overwriting_it(self) -> None:
        api = load_api()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(root)
            write_source(root, "b0", {"agent.yaml": b"agent: b0\n"})
            write_source(root, "b1", {"agent.yaml": b"agent: b1\n"})
            materialized = api.materialize_variant(root, manifest_path, "b0")
            target = materialized.path / "agent.yaml"
            target.write_bytes(b"tampered\n")

            with self.assertRaises(FileExistsError):
                api.materialize_variant(root, manifest_path, "b0")
            self.assertEqual(target.read_bytes(), b"tampered\n")

    def test_preserves_previous_fingerprint_when_source_changes(self) -> None:
        api = load_api()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(root)
            source = write_source(root, "b0", {"agent.yaml": b"version: 1\n"})
            write_source(root, "b1", {"agent.yaml": b"agent: b1\n"})
            first = api.materialize_variant(root, manifest_path, "b0")

            (source / "agent.yaml").write_bytes(b"version: 2\n")
            second = api.materialize_variant(root, manifest_path, "b0")

            self.assertNotEqual(first.fingerprint, second.fingerprint)
            self.assertTrue(first.path.is_dir())
            self.assertTrue(second.path.is_dir())
            self.assertEqual((first.path / "agent.yaml").read_bytes(), b"version: 1\n")
            self.assertEqual((second.path / "agent.yaml").read_bytes(), b"version: 2\n")

    def test_rejects_unknown_variant_and_source_directory_symlink(self) -> None:
        api = load_api()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(root)
            write_source(root, "b1", {"agent.yaml": b"agent: b1\n"})
            with self.assertRaises(KeyError):
                api.materialize_variant(root, manifest_path, "b2")

            outside = root / "outside"
            outside.mkdir()
            (outside / "agent.yaml").write_text("outside", encoding="utf-8")
            source = root / "experiments" / "variants" / "b0"
            source.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.symlink(outside, source, target_is_directory=True)
            except OSError as error:
                self.skipTest(f"directory symlink creation unavailable: {error}")
            with self.assertRaises(ValueError):
                api.materialize_variant(root, manifest_path, "b0")


if __name__ == "__main__":
    unittest.main()
