# -*- coding: utf-8 -*-
"""Runtime wiring for the structured configuration validator."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, List

from src.config import ConfigIssue


@dataclass(frozen=True)
class RuntimeConfigValidationResult:
    issues: List[ConfigIssue]
    mode: str
    can_start: bool

    @property
    def error_count(self) -> int:
        return sum(issue.severity == "error" for issue in self.issues)


def validate_runtime_config(config: Any, target_logger: logging.Logger) -> RuntimeConfigValidationResult:
    """Validate, log by severity, and enforce the opt-in strict startup mode."""
    raw_mode = str(getattr(config, "config_validate_mode", "warn") or "warn").strip().lower()
    mode = raw_mode if raw_mode in {"warn", "strict"} else "warn"
    if raw_mode != mode:
        target_logger.warning(
            "未知 CONFIG_VALIDATE_MODE=%s，已按 warn 模式继续启动",
            raw_mode,
        )

    structured_validator = getattr(config, "validate_structured", None)
    if callable(structured_validator):
        issues = list(structured_validator())
    else:
        legacy_validator = getattr(config, "validate", None)
        legacy_messages = list(legacy_validator()) if callable(legacy_validator) else []
        issues = [
            ConfigIssue(severity="warning", message=str(message))
            for message in legacy_messages
        ]
    log_methods = {
        "error": target_logger.error,
        "warning": target_logger.warning,
        "info": target_logger.info,
    }
    for issue in issues:
        log_method = log_methods.get(issue.severity, target_logger.warning)
        field_prefix = f"[{issue.field}] " if issue.field else ""
        log_method("配置校验 %s%s", field_prefix, issue.message)

    can_start = not (mode == "strict" and any(issue.severity == "error" for issue in issues))
    if not can_start:
        target_logger.error("严格配置校验未通过，启动已停止；修正 error 级问题或改用 CONFIG_VALIDATE_MODE=warn")
    return RuntimeConfigValidationResult(issues=issues, mode=mode, can_start=can_start)
