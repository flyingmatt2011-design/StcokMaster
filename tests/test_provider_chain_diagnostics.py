from __future__ import annotations

import logging

from src.services.provider_chain_diagnostics import summarize_provider_chains
from src.services.run_diagnostics import (
    activate_run_diagnostic_context,
    build_run_diagnostic_summary,
    record_provider_run,
    reset_run_diagnostic_context,
)


def test_provider_chain_summary_distinguishes_fallback_success_and_total_latency():
    chains = summarize_provider_chains(
        [
            {
                "data_type": "news_search",
                "provider": "Bocha",
                "success": False,
                "latency_ms": 1200,
                "error_type": "Timeout",
                "fallback_to": "Tavily",
            },
            {
                "data_type": "news_search",
                "provider": "Tavily",
                "success": True,
                "latency_ms": 350,
                "record_count": 4,
                "fallback_from": "Bocha",
            },
        ]
    )

    assert chains == [
        {
            "data_type": "news_search",
            "label": "新闻舆情",
            "status": "degraded",
            "message": "新闻舆情在 2 次尝试后由 Tavily 降级成功",
            "attempts": 2,
            "providers": ["Bocha", "Tavily"],
            "selected_provider": "Tavily",
            "total_latency_ms": 1550,
            "record_count": 4,
            "final_error": None,
        }
    ]


def test_run_summary_exposes_failed_provider_chain_and_copy_text():
    summary = build_run_diagnostic_summary(
        context_snapshot={
            "diagnostics": {
                "provider_runs": [
                    {
                        "data_type": "realtime_quote",
                        "provider": "AkShare",
                        "operation": "get_realtime_quote",
                        "success": False,
                        "latency_ms": 800,
                        "error_type": "Timeout",
                    }
                ],
                "llm_runs": [],
            }
        }
    )

    assert summary["provider_chains"][0]["status"] == "failed"
    assert "provider_chain: realtime_quote failed attempts=1" in summary["copy_text"]


def test_reset_logs_one_terminal_chain_outcome(caplog):
    token = activate_run_diagnostic_context(trace_id="trace-chain-log")
    try:
        record_provider_run(
            data_type="daily_data",
            provider="Primary",
            operation="fetch",
            success=False,
            latency_ms=100,
            error_type="Timeout",
            fallback_to="Fallback",
        )
        record_provider_run(
            data_type="daily_data",
            provider="Fallback",
            operation="fetch",
            success=True,
            latency_ms=50,
            fallback_from="Primary",
            record_count=120,
        )
        with caplog.at_level(logging.WARNING, logger="src.services.run_diagnostics"):
            reset_run_diagnostic_context(token)
            token = None
    finally:
        reset_run_diagnostic_context(token)

    messages = [record.getMessage() for record in caplog.records]
    assert messages == ["[数据源链路] 日线K线在 2 次尝试后由 Fallback 降级成功"]
