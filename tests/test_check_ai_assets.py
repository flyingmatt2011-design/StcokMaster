from pathlib import Path
from unittest.mock import patch

import pytest

from scripts import check_ai_assets


def test_windows_materialized_git_symlink_is_accepted(tmp_path: Path) -> None:
    agents = tmp_path / "AGENTS.md"
    claude = tmp_path / "CLAUDE.md"
    agents.write_text("rules", encoding="utf-8")
    claude.write_text("AGENTS.md", encoding="utf-8")

    with (
        patch.object(check_ai_assets, "AGENTS", agents),
        patch.object(check_ai_assets, "CLAUDE", claude),
        patch.object(check_ai_assets.sys, "platform", "win32"),
        patch.object(check_ai_assets, "git_index_mode", return_value="120000"),
    ):
        check_ai_assets.ensure_symlink()


def test_regular_claude_file_is_rejected_without_git_symlink_mode(tmp_path: Path) -> None:
    agents = tmp_path / "AGENTS.md"
    claude = tmp_path / "CLAUDE.md"
    agents.write_text("rules", encoding="utf-8")
    claude.write_text("AGENTS.md", encoding="utf-8")

    with (
        patch.object(check_ai_assets, "AGENTS", agents),
        patch.object(check_ai_assets, "CLAUDE", claude),
        patch.object(check_ai_assets.sys, "platform", "win32"),
        patch.object(check_ai_assets, "git_index_mode", return_value="100644"),
        pytest.raises(SystemExit, match="1"),
    ):
        check_ai_assets.ensure_symlink()
