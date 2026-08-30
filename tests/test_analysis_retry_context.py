# -*- coding: utf-8 -*-

from datetime import datetime, timezone

from src.services.analysis_retry_context import PreparedAnalysisRetryCache
from data_provider.realtime_types import RealtimeSource, UnifiedRealtimeQuote
from src.stock_analyzer import TrendAnalysisResult, TrendStatus


def test_prepared_analysis_retry_cache_returns_copy_and_deletes() -> None:
    cache = PreparedAnalysisRetryCache(ttl_seconds=60, max_items=2)
    payload = {"stock_name": "测试股票", "runtime_object": object()}

    cache.put(" 600000 ", payload)
    loaded = cache.get("600000")

    assert loaded is not None
    assert loaded is not payload
    assert loaded["stock_name"] == "测试股票"
    assert loaded["runtime_object"] is payload["runtime_object"]

    cache.delete("600000")
    assert cache.get("600000") is None


def test_prepared_analysis_retry_cache_evicts_oldest_item() -> None:
    cache = PreparedAnalysisRetryCache(ttl_seconds=60, max_items=2)

    cache.put("1", {"value": 1})
    cache.put("2", {"value": 2})
    cache.put("3", {"value": 3})

    assert cache.get("1") is None
    assert cache.get("2") == {"value": 2}
    assert cache.get("3") == {"value": 3}


def test_prepared_analysis_retry_cache_survives_process_restart(tmp_path) -> None:
    checkpoint = tmp_path / "prepared.json"
    first = PreparedAnalysisRetryCache(
        ttl_seconds=60,
        max_items=2,
        storage_path=str(checkpoint),
    )
    first.put("600519", {
        "stock_name": "贵州茅台",
        "realtime_quote": UnifiedRealtimeQuote(
            code="600519",
            name="贵州茅台",
            source=RealtimeSource.TENCENT,
            price=1600.0,
            fetched_at=datetime(2026, 8, 29, tzinfo=timezone.utc),
        ),
        "trend_result": TrendAnalysisResult(
            code="600519",
            trend_status=TrendStatus.BULL,
            support_levels=[1500.0],
            resistance_levels=[1700.0],
        ),
    })

    second = PreparedAnalysisRetryCache(
        ttl_seconds=60,
        max_items=2,
        storage_path=str(checkpoint),
    )
    loaded = second.get("600519")

    assert loaded is not None
    assert loaded["realtime_quote"].source is RealtimeSource.TENCENT
    assert loaded["realtime_quote"].price == 1600.0
    assert loaded["realtime_quote"].fetched_at == "2026-08-29T00:00:00+00:00"
    assert loaded["trend_result"].trend_status is TrendStatus.BULL
    assert loaded["trend_result"].support_levels == [1500.0]
    second.delete("600519")
    assert PreparedAnalysisRetryCache(storage_path=str(checkpoint)).get("600519") is None
