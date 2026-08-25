# -*- coding: utf-8 -*-
"""Regression tests for intelligence concurrency and coverage semantics."""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace

from src.core.pipeline import StockAnalysisPipeline
from src.schemas.analysis_context_pack import ContextFieldStatus
from src.search_service import SearchResponse, SearchResult, SearchService
from src.services.analysis_context_builder import _build_news_block
from src.services.intel_context_status import (
    IntelCoverageStatus,
    format_intel_coverage_note,
    summarize_intel_coverage,
)


class _ConcurrentProvider:
    name = "test-provider"
    is_available = True

    def __init__(self, *, fail_query_fragment: str = "") -> None:
        self.fail_query_fragment = fail_query_fragment
        self._lock = threading.Lock()
        self.active = 0
        self.max_active = 0

    def search(self, query: str, **_kwargs) -> SearchResponse:
        with self._lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            # Different completion times prove that the returned dict is rebuilt
            # by declaration order rather than as_completed order.
            time.sleep(0.03 if "最新" in query else 0.01)
            if self.fail_query_fragment and self.fail_query_fragment in query:
                raise RuntimeError("dimension boom")
            return SearchResponse(
                query=query,
                results=[],
                provider=self.name,
                success=True,
            )
        finally:
            with self._lock:
                self.active -= 1


def test_comprehensive_search_runs_dimensions_concurrently_in_stable_order() -> None:
    service = SearchService(news_search_max_workers=3)
    provider = _ConcurrentProvider()
    service._providers = [provider]

    results = service.search_comprehensive_intel("600519", "贵州茅台", max_searches=3)

    assert provider.max_active >= 2
    assert list(results) == ["latest_news", "market_analysis", "risk_check"]


def test_comprehensive_search_keeps_dimension_failure_fail_open() -> None:
    service = SearchService(news_search_max_workers=3)
    service._providers = [_ConcurrentProvider(fail_query_fragment="减持")]

    results = service.search_comprehensive_intel("600519", "贵州茅台", max_searches=3)

    assert results["latest_news"].success is True
    assert results["market_analysis"].success is True
    assert results["risk_check"].success is False
    assert "dimension search failed" in (results["risk_check"].error_message or "")


def test_comprehensive_search_respects_single_worker_configuration() -> None:
    service = SearchService(news_search_max_workers=1)
    provider = _ConcurrentProvider()
    service._providers = [provider]

    service.search_comprehensive_intel("600519", "贵州茅台", max_searches=3)

    assert provider.max_active == 1


def test_pipeline_fetches_structured_and_generic_sources_concurrently() -> None:
    active = 0
    max_active = 0
    lock = threading.Lock()

    def run_source(label: str):
        nonlocal active, max_active
        with lock:
            active += 1
            max_active = max(max_active, active)
        try:
            time.sleep(0.03)
            return {
                label: SearchResponse(
                    query=label,
                    results=[],
                    provider=label,
                    success=True,
                )
            }
        finally:
            with lock:
                active -= 1

    pipeline = StockAnalysisPipeline.__new__(StockAnalysisPipeline)
    pipeline.a_share_structured_intel = SimpleNamespace(
        supports=lambda _code: True,
        fetch=lambda *_args, **_kwargs: run_source("announcements"),
    )
    pipeline.search_service = SimpleNamespace(
        is_available=True,
        search_comprehensive_intel=lambda **_kwargs: run_source("latest_news"),
    )

    structured, searched, unavailable = pipeline._fetch_intelligence_sources(
        code="600519",
        stock_name="贵州茅台",
        news_window_days=3,
    )

    assert max_active == 2
    assert list(structured) == ["announcements"]
    assert list(searched) == ["latest_news"]
    assert unavailable == []


def test_coverage_states_distinguish_empty_partial_and_unavailable() -> None:
    covered_response = SearchResponse(
        query="covered",
        results=[
            SearchResult(
                title="公司公告",
                snippet="公告摘要",
                url="https://example.com/notice",
                source="exchange",
            )
        ],
        provider="ok",
        success=True,
    )
    successful_empty = SearchResponse(
        query="empty",
        results=[],
        provider="ok",
        success=True,
    )
    failed = SearchResponse(
        query="failed",
        results=[],
        provider="failed",
        success=False,
        error_message="timeout",
    )

    covered = summarize_intel_coverage([covered_response])
    confirmed = summarize_intel_coverage([successful_empty])
    partial = summarize_intel_coverage([successful_empty, failed])
    unavailable = summarize_intel_coverage([failed], unavailable_sources=["generic_search"])

    assert covered.status == IntelCoverageStatus.COVERED
    assert confirmed.status == IntelCoverageStatus.EMPTY_CONFIRMED
    assert partial.status == IntelCoverageStatus.PARTIAL
    assert unavailable.status == IntelCoverageStatus.UNAVAILABLE
    assert "未发现相关公告、研报或新闻" in format_intel_coverage_note(
        confirmed,
        news_window_days=3,
    )
    unavailable_note = format_intel_coverage_note(unavailable, news_window_days=3)
    assert "未覆盖最新舆情" in unavailable_note
    assert "勿将“无新闻”视为“无利空”" in unavailable_note


def test_analysis_context_pack_preserves_explicit_unavailable_news_note() -> None:
    note = "【新闻/舆情覆盖状态】UNAVAILABLE：本次结论未覆盖最新舆情。"
    block = _build_news_block(
        SimpleNamespace(
            news_context=note,
            news_result_count=0,
            metadata={
                "news_coverage_status": "UNAVAILABLE",
                "news_coverage": {"status": "UNAVAILABLE", "failed": 3},
            },
        )
    )

    assert block.status == ContextFieldStatus.FETCH_FAILED
    assert block.items["content"].value == note
    assert block.items["content"].missing_reason == "news_sources_unavailable"
