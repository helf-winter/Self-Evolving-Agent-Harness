from __future__ import annotations

import hashlib
import io
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path


ALLOWED_ROOT_FILES = {"agent.yaml", "eval_config.yaml"}
ALLOWED_ROOT_DIRECTORIES = {
    "configs",
    "prompts",
    "skills",
    "sub_agents",
    "adapters",
}
ALLOWED_SUFFIXES = {".yaml", ".yml", ".json", ".md", ".txt", ".py", ".toml"}
MAX_TOTAL_BYTES = 1024 * 1024
CREDENTIAL_NAMES = {
    ".env",
    "credentials.json",
    "credential.json",
    "kaggle.json",
    "secrets.json",
    "secret.json",
    "secrets.yaml",
    "secrets.yml",
}
VERIFIER_MARKERS = (
    "test_patch",
    "reference_patch",
    "reference solution",
    "reference fix",
    "gold patch",
    "golden patch",
)
SECRET_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----", re.IGNORECASE),
    re.compile(
        r"\b(?:api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*"
        r"[\"']?[A-Za-z0-9_./+\-=]{20,}",
        re.IGNORECASE,
    ),
)


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


def _issue(code: str, path: str, message: str) -> ValidationIssue:
    return ValidationIssue(code=code, path=path, message=message)


def _entries(root: Path) -> tuple[Path, ...]:
    return tuple(sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()))


def validate_submission(root: Path) -> tuple[ValidationIssue, ...]:
    issues: list[ValidationIssue] = []
    if root.is_symlink():
        return (_issue("symlink", ".", "submission root must not be a symlink"),)
    if not root.is_dir():
        return (_issue("missing_root", ".", "submission root does not exist"),)

    agent = root / "agent.yaml"
    if not agent.is_file() or agent.is_symlink():
        issues.append(_issue("missing_required", "agent.yaml", "agent.yaml is required"))

    total_bytes = 0
    root_resolved = root.resolve()
    for entry in _entries(root):
        relative = entry.relative_to(root).as_posix()
        if entry.is_symlink():
            issues.append(_issue("symlink", relative, "symlinks are not allowed"))
            continue

        try:
            entry.resolve().relative_to(root_resolved)
        except ValueError:
            issues.append(_issue("path_escape", relative, "entry escapes submission root"))
            continue

        top_level = entry.relative_to(root).parts[0]
        if entry.is_dir():
            if top_level not in ALLOWED_ROOT_DIRECTORIES:
                issues.append(
                    _issue("unexpected_root", relative, "directory is outside the allowed surface")
                )
            continue
        if not entry.is_file():
            issues.append(_issue("unexpected_entry", relative, "entry is not a regular file"))
            continue

        if len(entry.relative_to(root).parts) == 1:
            if relative not in ALLOWED_ROOT_FILES:
                issues.append(
                    _issue("unexpected_root", relative, "file is not an allowed root file")
                )
        elif top_level not in ALLOWED_ROOT_DIRECTORIES:
            issues.append(
                _issue("unexpected_root", relative, "file is outside the allowed surface")
            )

        if entry.suffix.lower() not in ALLOWED_SUFFIXES:
            issues.append(
                _issue("unexpected_file_type", relative, "file type is not allowed in stage one")
            )
        if entry.name.lower() in CREDENTIAL_NAMES or "credential" in entry.name.lower():
            issues.append(
                _issue("credential_file", relative, "credential files are not allowed")
            )

        content = entry.read_bytes()
        total_bytes += len(content)
        if not content:
            issues.append(_issue("empty_file", relative, "files must not be empty"))
            continue
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            issues.append(_issue("non_text_file", relative, "stage-one files must be UTF-8 text"))
            continue
        lowered = text.lower()
        if any(marker in lowered for marker in VERIFIER_MARKERS):
            issues.append(
                _issue("verifier_material", relative, "verifier-only material is not allowed")
            )
        if any(pattern.search(text) for pattern in SECRET_PATTERNS):
            issues.append(_issue("secret_material", relative, "secret material is not allowed"))

    if total_bytes > MAX_TOTAL_BYTES:
        issues.append(
            _issue(
                "content_too_large",
                ".",
                f"aggregate content exceeds {MAX_TOTAL_BYTES} bytes",
            )
        )

    return tuple(sorted(issues, key=lambda item: (item.path, item.code, item.message)))


def _archive_bytes(root: Path) -> tuple[bytes, tuple[str, ...]]:
    files = tuple(entry for entry in _entries(root) if entry.is_file())
    names = tuple(entry.relative_to(root).as_posix() for entry in files)
    for name in names:
        path = Path(name)
        if path.is_absolute() or ".." in path.parts or "\\" in name:
            raise ValueError(f"unsafe archive entry: {name}")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_STORED) as archive:
        for entry, name in zip(files, names, strict=True):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, entry.read_bytes())
    return buffer.getvalue(), names


def build_archive(root: Path, output_path: Path) -> ArchiveResult:
    issues = validate_submission(root)
    if issues:
        summary = "; ".join(f"{item.code}:{item.path}" for item in issues)
        raise ValueError(f"submission validation failed: {summary}")

    content, entries = _archive_bytes(root)
    digest = hashlib.sha256(content).hexdigest()
    output = output_path.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with output.open("xb") as stream:
            stream.write(content)
    except FileExistsError:
        if output.read_bytes() != content:
            raise FileExistsError(f"archive output already exists with different bytes: {output}")

    return ArchiveResult(path=output, sha256=digest, size=len(content), entries=entries)
