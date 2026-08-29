from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.stockmaster.check_protected_boundary import protected_paths


def test_ui_only_paths_are_not_protected() -> None:
    assert protected_paths(["apps/dsa-web/src/pages/HomePage.tsx", "docs/CHANGELOG.md"]) == []


def test_analysis_paths_are_protected() -> None:
    assert protected_paths(["src/analyzer.py", "data_provider/akshare.py"]) == [
        "data_provider/akshare.py",
        "src/analyzer.py",
    ]


def test_templates_are_protected_but_superpowers_docs_are_not() -> None:
    assert protected_paths(["templates/report_markdown.j2", "docs/superpowers/spec.md"]) == [
        "templates/report_markdown.j2"
    ]


def test_parent_traversal_is_rejected() -> None:
    with pytest.raises(ValueError):
        protected_paths(["src/../data_provider/evil.py"])


def test_baseline_manifest_has_expected_commit_and_roots() -> None:
    manifest = json.loads(
        (Path(__file__).parents[2] / "stockmaster" / "upstream-baseline.json").read_text(encoding="utf-8")
    )
    assert manifest["commit"] == "3b98aa1d779a3525660b5bd95a2b297278808464"
    assert manifest["protectedRoots"] == ["src", "data_provider", "strategies", "api", "templates"]
