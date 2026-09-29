from __future__ import annotations

import importlib
import os
import tempfile
import unittest
import zipfile
from pathlib import Path


def load_api():
    try:
        return importlib.import_module("competition.gemma4.scripts.package_submission")
    except ModuleNotFoundError as error:
        raise AssertionError("package_submission module must exist") from error


def write_valid_submission(root: Path) -> None:
    (root / "agent.yaml").write_text("name: baseline\n", encoding="utf-8")
    (root / "eval_config.yaml").write_text("model: gemma\n", encoding="utf-8")
    prompt = root / "prompts" / "system.md"
    prompt.parent.mkdir()
    prompt.write_text("Inspect, edit, verify, and submit.\n", encoding="utf-8")
    skill = root / "skills" / "evidence-first" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("# Evidence first\n", encoding="utf-8")


class PackageSubmissionTests(unittest.TestCase):
    def test_accepts_the_stage_one_surface(self) -> None:
        api = load_api()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_valid_submission(root)
            self.assertEqual(api.validate_submission(root), ())

    def test_reports_missing_empty_unexpected_oversized_and_secret_content(self) -> None:
        api = load_api()
        cases = {
            "missing-agent": ({"prompts/system.md": "hello"}, "missing_required"),
            "empty-agent": ({"agent.yaml": ""}, "empty_file"),
            "unexpected-root": (
                {"agent.yaml": "ok", "vendor/file.md": "bad"},
                "unexpected_root",
            ),
            "unexpected-extension": (
                {"agent.yaml": "ok", "prompts/blob.bin": "bad"},
                "unexpected_file_type",
            ),
            "verifier-marker": (
                {"agent.yaml": "ok", "prompts/system.md": "use test_patch here"},
                "verifier_material",
            ),
            "reference-fix": (
                {"agent.yaml": "ok", "prompts/system.md": "embedded reference solution"},
                "verifier_material",
            ),
            "private-key": (
                {
                    "agent.yaml": "ok",
                    "prompts/system.md": "-----BEGIN PRIVATE KEY-----",
                },
                "secret_material",
            ),
            "api-key": (
                {
                    "agent.yaml": "ok",
                    "configs/runtime.yaml": "api_key: abcdefghijklmnopqrstuvwxyz123456",
                },
                "secret_material",
            ),
            "credential-file": (
                {"agent.yaml": "ok", "configs/credentials.json": "{}"},
                "credential_file",
            ),
            "oversized": (
                {"agent.yaml": "ok", "prompts/system.md": "x" * (1024 * 1024 + 1)},
                "content_too_large",
            ),
        }
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            for name, (files, expected_code) in cases.items():
                with self.subTest(name=name):
                    root = base / name
                    root.mkdir()
                    for relative, content in files.items():
                        path = root / relative
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_text(content, encoding="utf-8")
                    codes = {issue.code for issue in api.validate_submission(root)}
                    self.assertIn(expected_code, codes)

    def test_rejects_symlinks_and_escaping_content(self) -> None:
        api = load_api()
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "submission"
            root.mkdir()
            (root / "agent.yaml").write_text("name: baseline\n", encoding="utf-8")
            outside = base / "outside.md"
            outside.write_text("outside", encoding="utf-8")
            link = root / "prompts"
            try:
                os.symlink(outside, link)
            except OSError as error:
                self.skipTest(f"symlink creation unavailable: {error}")
            codes = {issue.code for issue in api.validate_submission(root)}
            self.assertIn("symlink", codes)

    def test_builds_a_deterministic_sorted_stored_archive(self) -> None:
        api = load_api()
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "submission"
            root.mkdir()
            write_valid_submission(root)
            first = api.build_archive(root, base / "first.zip")
            second = api.build_archive(root, base / "second.zip")

            self.assertEqual(first.sha256, second.sha256)
            self.assertEqual((base / "first.zip").read_bytes(), (base / "second.zip").read_bytes())
            self.assertEqual(first.entries, tuple(sorted(first.entries)))
            self.assertTrue(all(not name.startswith("/") for name in first.entries))
            self.assertTrue(all(".." not in Path(name).parts for name in first.entries))
            with zipfile.ZipFile(first.path) as archive:
                infos = archive.infolist()
                self.assertTrue(all(info.compress_type == zipfile.ZIP_STORED for info in infos))
                self.assertTrue(all(info.date_time == (1980, 1, 1, 0, 0, 0) for info in infos))
                self.assertEqual(tuple(info.filename for info in infos), first.entries)

    def test_reuses_identical_archive_and_rejects_conflicting_output(self) -> None:
        api = load_api()
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "submission"
            root.mkdir()
            write_valid_submission(root)
            output = base / "submission.zip"
            first = api.build_archive(root, output)
            second = api.build_archive(root, output)
            self.assertEqual(first, second)

            output.write_bytes(b"conflict")
            with self.assertRaises(FileExistsError):
                api.build_archive(root, output)
            self.assertEqual(output.read_bytes(), b"conflict")

    def test_refuses_to_archive_an_invalid_submission(self) -> None:
        api = load_api()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "submission"
            root.mkdir()
            (root / "agent.yaml").write_text("", encoding="utf-8")
            with self.assertRaises(ValueError):
                api.build_archive(root, Path(directory) / "invalid.zip")


if __name__ == "__main__":
    unittest.main()
