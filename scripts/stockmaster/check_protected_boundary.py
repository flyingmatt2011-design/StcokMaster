"""Detect changes touching StockMaster's protected analysis boundary.

This module is deliberately read-only. It classifies paths so a reviewer can
decide whether a change is allowed; it never rewrites, stages, or commits files.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import PurePosixPath
from typing import Iterable, Sequence


DEFAULT_ROOTS = ("src", "data_provider", "strategies", "api", "templates")


def _normalize_path(path: str) -> str:
    value = str(path).replace("\\", "/").strip()
    if not value or value.startswith("/") or ":" in value.split("/", 1)[0]:
        raise ValueError(f"unsafe absolute path: {path!r}")
    parts = PurePosixPath(value).parts
    if ".." in parts:
        raise ValueError(f"unsafe parent traversal path: {path!r}")
    return "/".join(parts)


def protected_paths(paths: Iterable[str], roots: Sequence[str] = DEFAULT_ROOTS) -> list[str]:
    """Return sorted changed paths inside one of the protected roots."""

    normalized_roots = tuple(_normalize_path(root).rstrip("/") for root in roots)
    result: set[str] = set()
    for raw_path in paths:
        path = _normalize_path(raw_path)
        if any(path == root or path.startswith(f"{root}/") for root in normalized_roots):
            result.add(path)
    return sorted(result)


def changed_paths(base_ref: str, head_ref: str) -> list[str]:
    """Read changed names from Git without mutating the repository."""

    completed = subprocess.run(
        ["git", "diff", "--name-only", "--diff-filter=ACMRTUXB", f"{base_ref}..{head_ref}"],
        check=True,
        capture_output=True,
        text=True,
    )
    return [line for line in completed.stdout.splitlines() if line.strip()]


def build_report(base_ref: str, head_ref: str, roots: Sequence[str] = DEFAULT_ROOTS) -> dict[str, object]:
    paths = changed_paths(base_ref, head_ref)
    protected = protected_paths(paths, roots)
    return {
        "base": base_ref,
        "head": head_ref,
        "changed_paths": sorted(_normalize_path(path) for path in paths),
        "protected_paths": protected,
        "protected_change": bool(protected),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="Git base ref")
    parser.add_argument("--head", required=True, help="Git head ref")
    parser.add_argument("--baseline", help="Optional baseline JSON to read protectedRoots from")
    parser.add_argument("--fail-on-protected", action="store_true")
    args = parser.parse_args()

    roots: Sequence[str] = DEFAULT_ROOTS
    if args.baseline:
        with open(args.baseline, encoding="utf-8") as handle:
            payload = json.load(handle)
        configured = payload.get("protectedRoots")
        if isinstance(configured, list) and all(isinstance(item, str) for item in configured):
            roots = tuple(configured)

    report = build_report(args.base, args.head, roots)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 2 if args.fail_on_protected and report["protected_change"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
