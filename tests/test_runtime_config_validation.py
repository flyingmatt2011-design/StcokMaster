from __future__ import annotations

import logging

from src.config import ConfigIssue
from src.services.runtime_config_validation import validate_runtime_config


class _Config:
    def __init__(self, mode: str, issues: list[ConfigIssue]):
        self.config_validate_mode = mode
        self._issues = issues

    def validate_structured(self):
        return list(self._issues)


def test_warn_mode_preserves_startup_and_logs_real_severity(caplog):
    config = _Config(
        "warn",
        [
            ConfigIssue(severity="error", field="STOCK_LIST", message="missing"),
            ConfigIssue(severity="warning", field="TUSHARE_TOKEN", message="optional"),
            ConfigIssue(severity="info", message="disabled"),
        ],
    )

    with caplog.at_level(logging.INFO):
        result = validate_runtime_config(config, logging.getLogger("test.runtime-config"))

    assert result.can_start is True
    assert result.error_count == 1
    levels = [record.levelname for record in caplog.records]
    assert levels == ["ERROR", "WARNING", "INFO"]


def test_strict_mode_blocks_only_error_severity():
    warning_only = _Config(
        "strict",
        [ConfigIssue(severity="warning", field="TUSHARE_TOKEN", message="optional")],
    )
    with_error = _Config(
        "strict",
        [ConfigIssue(severity="error", field="STOCK_LIST", message="missing")],
    )

    assert validate_runtime_config(warning_only, logging.getLogger("test.strict-warning")).can_start is True
    assert validate_runtime_config(with_error, logging.getLogger("test.strict-error")).can_start is False


def test_unknown_mode_falls_back_to_compatible_warn_mode(caplog):
    config = _Config(
        "unexpected",
        [ConfigIssue(severity="error", field="STOCK_LIST", message="missing")],
    )

    with caplog.at_level(logging.WARNING):
        result = validate_runtime_config(config, logging.getLogger("test.unknown-mode"))

    assert result.mode == "warn"
    assert result.can_start is True
    assert "未知 CONFIG_VALIDATE_MODE" in caplog.records[0].getMessage()


def test_legacy_config_adapter_remains_startable():
    class LegacyConfig:
        config_validate_mode = "strict"

        @staticmethod
        def validate():
            return ["legacy warning"]

    result = validate_runtime_config(LegacyConfig(), logging.getLogger("test.legacy-config"))

    assert result.can_start is True
    assert result.issues[0].severity == "warning"
