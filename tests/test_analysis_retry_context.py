# -*- coding: utf-8 -*-

from src.services.analysis_retry_context import PreparedAnalysisRetryCache


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
