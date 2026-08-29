"""Validate a staged backend-only StockMaster update without executing it."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
from pathlib import Path
from typing import Iterable

BLOCKED_ROOTS = ("apps/dsa-web/", "apps/dsa-desktop/", "data/", "logs/")
BLOCKED_EXTENSIONS = {".exe", ".dll", ".so", ".dylib", ".db", ".sqlite", ".pyc"}


def _relative_files(root: Path) -> dict[str, Path]:
    result: dict[str, Path] = {}
    if not root.exists():
        return result
    for path in root.rglob("*"):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            result[relative] = path
        elif path.is_file():
            result[relative] = path
    return result


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_candidate(
    current_root: Path,
    candidate_root: Path,
    eligible_paths: Iterable[str],
    dependency_paths: Iterable[str],
) -> dict[str, object]:
    current_root = Path(current_root).resolve()
    candidate_root = Path(candidate_root).resolve()
    allowed = {str(path).replace("\\", "/") for path in (*eligible_paths, *dependency_paths)}
    current = _relative_files(current_root)
    candidate = _relative_files(candidate_root)
    blocked: list[str] = []
    reasons: list[str] = []
    for relative, path in sorted(candidate.items()):
        normalized = relative.lower()
        if path.is_symlink() or normalized.startswith(BLOCKED_ROOTS) or path.suffix.lower() in BLOCKED_EXTENSIONS:
            blocked.append(relative)
            reasons.append(f"blocked path: {relative}")
        elif relative not in allowed:
            blocked.append(relative)
            reasons.append(f"path outside manifest: {relative}")
    changed = sorted(
        relative
        for relative in set(current) | set(candidate)
        if relative in allowed and (
            relative not in current
            or relative not in candidate
            or current[relative].is_symlink()
            or candidate[relative].is_symlink()
            or _digest(current[relative]) != _digest(candidate[relative])
        )
    )
    syntax_errors: list[str] = []
    for relative in changed:
        if relative.endswith(".py") and relative in candidate:
            try:
                ast.parse(candidate[relative].read_text(encoding="utf-8"), filename=relative)
            except (OSError, SyntaxError) as error:
                syntax_errors.append(f"{relative}: {error}")
    return {
        "ok": not blocked and not syntax_errors,
        "changed_paths": changed,
        "blocked_paths": sorted(blocked),
        "syntax_errors": syntax_errors,
        "reasons": reasons,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("current", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--eligible", default="")
    parser.add_argument("--dependencies", default="")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = validate_candidate(args.current, args.candidate, args.eligible.split(","), args.dependencies.split(","))
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
