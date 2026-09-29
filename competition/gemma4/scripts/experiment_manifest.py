from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path, PurePath
from typing import Any


SCHEMA_VERSION = 1
OFFICIAL_MODEL = "gemma-4-31b-it-qat-w4a16-ct"
VARIANT_IDS = ("b0", "b1")


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


def _mapping(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def _exact_keys(value: dict[str, Any], expected: set[str], name: str) -> None:
    actual = set(value)
    if actual != expected:
        raise ValueError(
            f"{name} keys must be {sorted(expected)}; got {sorted(actual)}"
        )


def _positive_integer(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _source_path(raw: Any, workspace_root: Path) -> Path:
    if not isinstance(raw, str) or not raw:
        raise ValueError("variant source must be a non-empty string")
    path = PurePath(raw)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("variant source must be a relative non-traversing path")
    if path.parts[:2] != ("experiments", "variants") or len(path.parts) != 3:
        raise ValueError("variant source must be directly below experiments/variants")

    root = workspace_root.resolve()
    resolved = (root / Path(*path.parts)).resolve()
    try:
        resolved.relative_to((root / "experiments" / "variants").resolve())
    except ValueError as error:
        raise ValueError("variant source escapes experiments/variants") from error
    return resolved


def load_manifest(path: Path, workspace_root: Path) -> ExperimentManifest:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"unable to read experiment manifest: {error}") from error

    root = _mapping(payload, "manifest")
    _exact_keys(root, {"schema_version", "model", "limits", "variants"}, "manifest")
    if root["schema_version"] != SCHEMA_VERSION:
        raise ValueError(f"schema_version must be {SCHEMA_VERSION}")
    if root["model"] != OFFICIAL_MODEL:
        raise ValueError(f"model must be {OFFICIAL_MODEL}")

    limits_data = _mapping(root["limits"], "limits")
    limit_keys = {
        "timeout_seconds",
        "max_tool_calls",
        "max_time_minutes",
        "max_turns",
    }
    _exact_keys(limits_data, limit_keys, "limits")
    limits = Limits(
        timeout_seconds=_positive_integer(
            limits_data["timeout_seconds"], "limits.timeout_seconds"
        ),
        max_tool_calls=_positive_integer(
            limits_data["max_tool_calls"], "limits.max_tool_calls"
        ),
        max_time_minutes=_positive_integer(
            limits_data["max_time_minutes"], "limits.max_time_minutes"
        ),
        max_turns=_positive_integer(limits_data["max_turns"], "limits.max_turns"),
    )

    variants_data = root["variants"]
    if not isinstance(variants_data, list):
        raise ValueError("variants must be an array")
    variants: list[VariantSpec] = []
    for index, item in enumerate(variants_data):
        variant = _mapping(item, f"variants[{index}]")
        _exact_keys(variant, {"id", "source", "policy"}, f"variants[{index}]")
        variant_id = variant["id"]
        policy = variant["policy"]
        if not isinstance(variant_id, str) or not variant_id:
            raise ValueError(f"variants[{index}].id must be a non-empty string")
        if not isinstance(policy, str) or not policy:
            raise ValueError(f"variants[{index}].policy must be a non-empty string")
        variants.append(
            VariantSpec(
                variant_id=variant_id,
                source_dir=_source_path(variant["source"], workspace_root),
                policy=policy,
            )
        )

    ids = tuple(item.variant_id for item in variants)
    if len(set(ids)) != len(ids):
        raise ValueError("variant IDs must be unique")
    if ids != VARIANT_IDS:
        raise ValueError(f"variants must be exactly {VARIANT_IDS} in order")

    return ExperimentManifest(
        schema_version=SCHEMA_VERSION,
        model=OFFICIAL_MODEL,
        limits=limits,
        variants=tuple(variants),
    )
