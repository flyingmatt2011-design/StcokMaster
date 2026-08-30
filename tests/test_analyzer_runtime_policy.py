from types import SimpleNamespace

import pytest

from src.analyzer import _ModelCircuitOpen, _ModelRuntimePolicy, _model_timeout_seconds


def test_model_timeout_uses_route_class_budgets() -> None:
    config = SimpleNamespace(
        litellm_analysis_timeout_seconds=90,
        litellm_fast_model_timeout_seconds=60,
        litellm_quality_fallback_timeout_seconds=120,
    )

    assert _model_timeout_seconds(config, "Gemini-SLB/gemini-3.1-pro-preview") == 90
    assert _model_timeout_seconds(config, "Gemini-SLB/gemini-3.7-flash") == 60
    assert _model_timeout_seconds(config, "claude-officially/claude-sonnet-4-6") == 120


def test_model_runtime_policy_opens_after_consecutive_failures() -> None:
    policy = _ModelRuntimePolicy()
    model = "Gemini-SLB/gemini-3.1-pro-preview"

    for _ in range(2):
        policy.acquire(
            model,
            configured_limit=2,
            failure_threshold=2,
            cooldown_seconds=180,
        )
        policy.release(
            model,
            success=False,
            duration_seconds=90,
            configured_limit=2,
            failure_threshold=2,
            cooldown_seconds=180,
        )

    with pytest.raises(_ModelCircuitOpen):
        policy.acquire(
            model,
            configured_limit=2,
            failure_threshold=2,
            cooldown_seconds=180,
        )
