from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

from competition.gemma4.scripts.experiment_manifest import load_manifest


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


def _source_files(source_dir: Path) -> tuple[tuple[str, Path], ...]:
    if source_dir.is_symlink():
        raise ValueError(f"source directory must not be a symlink: {source_dir}")
    if not source_dir.is_dir():
        raise ValueError(f"source directory does not exist: {source_dir}")

    root = source_dir.resolve()
    files: list[tuple[str, Path]] = []
    for entry in source_dir.rglob("*"):
        if entry.is_symlink():
            raise ValueError(f"source tree contains a symlink: {entry}")
        if entry.is_dir():
            continue
        if not entry.is_file():
            raise ValueError(f"source tree contains a non-file entry: {entry}")
        resolved = entry.resolve()
        try:
            relative = resolved.relative_to(root)
        except ValueError as error:
            raise ValueError(f"source entry escapes source directory: {entry}") from error
        files.append((relative.as_posix(), resolved))

    if not files:
        raise ValueError(f"source directory contains no files: {source_dir}")
    return tuple(sorted(files, key=lambda item: item[0]))


def compute_tree_fingerprint(
    source_dir: Path,
) -> tuple[str, tuple[FileDigest, ...]]:
    tree_digest = hashlib.sha256()
    file_digests: list[FileDigest] = []
    for relative, path in _source_files(source_dir):
        content = path.read_bytes()
        content_digest = hashlib.sha256(content).hexdigest()
        file_digests.append(
            FileDigest(path=relative, sha256=content_digest, size=len(content))
        )
        tree_digest.update(relative.encode("utf-8"))
        tree_digest.update(b"\0")
        tree_digest.update(len(content).to_bytes(8, byteorder="big", signed=False))
        tree_digest.update(content)
    return tree_digest.hexdigest(), tuple(file_digests)


def _verify_existing(
    destination: Path,
    expected_fingerprint: str,
    expected_files: tuple[FileDigest, ...],
) -> None:
    try:
        actual_fingerprint, actual_files = compute_tree_fingerprint(destination)
    except ValueError as error:
        raise FileExistsError(
            f"materialized output conflicts with source: {destination}"
        ) from error
    if actual_fingerprint != expected_fingerprint or actual_files != expected_files:
        raise FileExistsError(
            f"materialized output conflicts with source: {destination}"
        )


def materialize_variant(
    workspace_root: Path,
    manifest_path: Path,
    variant_id: str,
) -> MaterializedVariant:
    workspace = workspace_root.resolve()
    manifest = load_manifest(manifest_path, workspace)
    try:
        variant = next(item for item in manifest.variants if item.variant_id == variant_id)
    except StopIteration as error:
        raise KeyError(f"unknown variant: {variant_id}") from error

    fingerprint, files = compute_tree_fingerprint(variant.source_dir)
    destination = workspace / "submission" / variant_id / fingerprint
    if destination.exists() or destination.is_symlink():
        _verify_existing(destination, fingerprint, files)
        return MaterializedVariant(variant_id, fingerprint, destination, files)

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(
        tempfile.mkdtemp(prefix=f".{fingerprint}.tmp-", dir=destination.parent)
    )
    try:
        for file_digest in files:
            source = variant.source_dir / Path(file_digest.path)
            target = temporary / Path(file_digest.path)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target, follow_symlinks=False)

        copied_fingerprint, copied_files = compute_tree_fingerprint(temporary)
        if copied_fingerprint != fingerprint or copied_files != files:
            raise RuntimeError("source changed during materialization")

        try:
            os.rename(temporary, destination)
        except FileExistsError:
            _verify_existing(destination, fingerprint, files)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)

    return MaterializedVariant(variant_id, fingerprint, destination, files)
