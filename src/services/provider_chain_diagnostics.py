# -*- coding: utf-8 -*-
"""Aggregate provider attempts into stable, user-facing chain outcomes.

The analysis pipeline records individual provider attempts in
``run_diagnostics``. This module deliberately contains only pure aggregation
logic so provider fallback behavior remains unchanged.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Any, Dict, Iterable, List


DATA_TYPE_LABELS = {
    "realtime_quote": "实时行情",
    "daily_data": "日线K线",
    "daily_bars": "日线K线",
    "technical": "技术指标",
    "news": "新闻舆情",
    "news_search": "新闻舆情",
    "fundamental": "基本面",
    "fundamentals": "基本面",
    "belong_boards": "所属板块",
    "chip": "筹码结构",
}


def _non_negative_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, parsed)


def summarize_provider_chains(provider_runs: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Return one deterministic outcome for every recorded data-source chain."""
    grouped: "OrderedDict[str, List[Dict[str, Any]]]" = OrderedDict()
    for raw_run in provider_runs:
        if not isinstance(raw_run, dict):
            continue
        data_type = str(raw_run.get("data_type") or "provider").strip() or "provider"
        grouped.setdefault(data_type, []).append(raw_run)

    summaries: List[Dict[str, Any]] = []
    for data_type, runs in grouped.items():
        successes = [run for run in runs if run.get("success") is True]
        failures = [run for run in runs if run.get("success") is False]
        selected = successes[-1] if successes else None
        last_run = runs[-1]
        providers: List[str] = []
        for run in runs:
            provider = str(run.get("provider") or "unknown").strip() or "unknown"
            if provider not in providers:
                providers.append(provider)

        used_fallback = bool(
            failures
            or any(run.get("fallback_from") or run.get("fallback_to") for run in runs)
        )
        status = "failed" if selected is None else ("degraded" if used_fallback else "ok")
        final_error = None
        if selected is None:
            final_error = (
                last_run.get("error_message_sanitized")
                or last_run.get("error_type")
                or "所有数据源尝试失败"
            )

        label = DATA_TYPE_LABELS.get(data_type, data_type)
        selected_provider = selected.get("provider") if selected else None
        if status == "ok":
            message = f"{label}由 {selected_provider or 'unknown'} 获取成功"
        elif status == "degraded":
            message = f"{label}在 {len(runs)} 次尝试后由 {selected_provider or 'unknown'} 降级成功"
        else:
            message = f"{label}全部 {len(runs)} 次尝试失败：{final_error}"

        summaries.append(
            {
                "data_type": data_type,
                "label": label,
                "status": status,
                "message": message,
                "attempts": len(runs),
                "providers": providers,
                "selected_provider": selected_provider,
                "total_latency_ms": sum(_non_negative_int(run.get("latency_ms")) for run in runs),
                "record_count": selected.get("record_count") if selected else 0,
                "final_error": final_error,
            }
        )
    return summaries
