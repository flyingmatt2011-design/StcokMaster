import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from data_provider.akshare_fetcher import AkshareFetcher
from data_provider.base import DataFetcherManager
from src.services.market_dashboard_service import MarketDashboardService
from src.services.stock_service import StockService


@pytest.fixture(autouse=True)
def reset_stock_service_quote_state():
    StockService._reset_realtime_quote_state_for_tests()
    MarketDashboardService._reset_cache_for_tests()
    yield
    StockService._reset_realtime_quote_state_for_tests()
    MarketDashboardService._reset_cache_for_tests()


def test_market_dashboard_snapshot_does_not_use_news_or_llm():
    config = object()
    overview = SimpleNamespace()
    payload = {"indices": [{"code": "000001", "name": "上证指数"}]}

    with patch("src.services.market_dashboard_service.MarketAnalyzer") as analyzer_cls:
        analyzer = analyzer_cls.return_value
        analyzer.get_market_overview.return_value = overview
        analyzer.build_market_review_payload.return_value = payload

        result = MarketDashboardService(config=config).get_snapshot(region="cn")

    analyzer_cls.assert_called_once_with(
        search_service=None,
        analyzer=None,
        region="cn",
        config=config,
    )
    analyzer.get_market_overview.assert_called_once_with(force_refresh=True)
    analyzer.build_market_review_payload.assert_called_once_with(
        overview=overview,
        news=[],
        report="",
    )
    assert result["payload"] == payload
    assert result["mode"] == "market_data_only"
    assert result["uses_llm"] is False


def test_market_dashboard_snapshot_reuses_short_lived_cache():
    payload = {"indices": [{"code": "000001"}]}
    with (
        patch.object(MarketDashboardService, "_cache_ttl_seconds", return_value=240.0),
        patch("src.services.market_dashboard_service.MarketAnalyzer") as analyzer_cls,
    ):
        analyzer_cls.return_value.get_market_overview.return_value = object()
        analyzer_cls.return_value.build_market_review_payload.return_value = payload
        service = MarketDashboardService(config=object())
        first = service.get_snapshot(region="cn")
        second = service.get_snapshot(region="cn")

    assert analyzer_cls.call_count == 1
    assert first["cache_hit"] is False
    assert second["cache_hit"] is True
    assert second["payload"] == payload


def test_market_dashboard_snapshot_coalesces_concurrent_refreshes():
    entered = threading.Event()
    release = threading.Event()

    def fetch_overview(*_args, **_kwargs):
        entered.set()
        assert release.wait(timeout=2)
        return object()

    with (
        patch.object(MarketDashboardService, "_cache_ttl_seconds", return_value=240.0),
        patch("src.services.market_dashboard_service.MarketAnalyzer") as analyzer_cls,
    ):
        analyzer_cls.return_value.get_market_overview.side_effect = fetch_overview
        analyzer_cls.return_value.build_market_review_payload.return_value = {"indices": []}
        service = MarketDashboardService(config=object())
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(service.get_snapshot, "cn")
            assert entered.wait(timeout=2)
            second = executor.submit(service.get_snapshot, "cn")
            time.sleep(0.05)
            release.set()
            assert first.result(timeout=2)["payload"] == {"indices": []}
            assert second.result(timeout=2)["cache_hit"] is True

    assert analyzer_cls.return_value.get_market_overview.call_count == 1


def _tencent_quote_payload(code: str, name: str, price: str, change_pct: str) -> str:
    fields = [""] * 50
    fields[1] = name
    fields[2] = code
    fields[3] = price
    fields[4] = "100.00"
    fields[5] = "101.00"
    fields[6] = "1234"
    fields[31] = "1.00"
    fields[32] = change_pct
    fields[33] = "103.00"
    fields[34] = "99.00"
    fields[37] = "123456"
    fields[38] = "0.80"
    fields[39] = "12.30"
    fields[43] = "4.00"
    fields[44] = "100.00"
    fields[45] = "120.00"
    fields[46] = "1.50"
    fields[49] = "1.20"
    return "~".join(fields)


def test_tencent_batch_quotes_use_one_http_request_for_multiple_a_shares():
    response = MagicMock()
    response.text = ";".join(
        [
            f'v_sh600519="{_tencent_quote_payload("600519", "贵州茅台", "1700.50", "1.25")}"',
            f'v_sz000001="{_tencent_quote_payload("000001", "平安银行", "12.34", "-0.50")}"',
        ]
    ) + ";"
    response.raise_for_status.return_value = None
    circuit_breaker = MagicMock()
    circuit_breaker.is_available.return_value = True
    fetcher = AkshareFetcher.__new__(AkshareFetcher)

    with (
        patch.object(fetcher, "_enforce_rate_limit"),
        patch("data_provider.akshare_fetcher.requests.get", return_value=response) as request_get,
        patch(
            "data_provider.akshare_fetcher.get_realtime_circuit_breaker",
            return_value=circuit_breaker,
        ),
    ):
        quotes = fetcher.get_realtime_quotes(["600519", "000001"])

    assert request_get.call_count == 1
    request_url = request_get.call_args.args[0]
    assert "sh600519" in request_url
    assert "sz000001" in request_url
    assert quotes["600519"].price == 1700.5
    assert quotes["600519"].change_pct == 1.25
    assert quotes["000001"].price == 12.34
    assert quotes["000001"].change_pct == -0.5
    circuit_breaker.record_success.assert_called_once_with("akshare_tencent")


def test_stock_service_frequent_batch_does_not_expand_missing_quotes_into_fallbacks():
    quote = SimpleNamespace(
        code="600519",
        name="贵州茅台",
        price=1700.5,
        change_amount=1.0,
        change_pct=1.25,
        open_price=1690.0,
        high=1710.0,
        low=1680.0,
        pre_close=1679.5,
        volume=100,
        amount=200,
    )

    with patch("data_provider.base.DataFetcherManager") as manager_cls:
        manager_cls.return_value.get_realtime_quotes.return_value = {"600519": quote}
        result = StockService().get_realtime_quotes(["600519", "000001"])

    manager_cls.return_value.get_realtime_quotes.assert_called_once_with(
        ["600519", "000001"],
        fallback_missing=False,
    )
    assert [item["stock_code"] for item in result["items"]] == ["600519"]
    assert result["failed_codes"] == ["000001"]


def test_stock_service_reuses_shared_quote_cache_and_preserves_quality_metadata():
    fetched_at = datetime.now().astimezone()
    quote = SimpleNamespace(
        code="600519",
        name="贵州茅台",
        price=1700.5,
        change_amount=1.0,
        change_pct=1.25,
        open_price=1690.0,
        high=1710.0,
        low=1680.0,
        pre_close=1679.5,
        volume=100,
        amount=200,
        source="tencent",
        fetched_at=fetched_at,
        provider_timestamp=fetched_at,
        is_stale=False,
        stale_seconds=0.0,
    )

    with patch("data_provider.base.DataFetcherManager") as manager_cls:
        manager_cls.return_value.get_realtime_quotes.return_value = {"600519": quote}
        first = StockService().get_realtime_quotes(["600519"])
        second = StockService().get_realtime_quotes(["600519"])

    manager_cls.return_value.get_realtime_quotes.assert_called_once_with(
        ["600519"],
        fallback_missing=False,
    )
    assert first["items"][0]["refresh_status"] == "fresh"
    assert second["items"][0]["refresh_status"] == "cached"
    assert second["items"][0]["source"] == "tencent"
    assert second["items"][0]["last_success_at"]
    assert second["items"][0]["is_stale"] is False


def test_stock_service_coalesces_concurrent_batch_requests():
    quote = SimpleNamespace(code="600519", price=1700.5)
    provider_entered = threading.Event()
    provider_release = threading.Event()

    def fetch_quotes(*_args, **_kwargs):
        provider_entered.set()
        assert provider_release.wait(timeout=2)
        return {"600519": quote}

    with patch("data_provider.base.DataFetcherManager") as manager_cls:
        manager_cls.return_value.get_realtime_quotes.side_effect = fetch_quotes
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(StockService().get_realtime_quotes, ["600519"])
            assert provider_entered.wait(timeout=2)
            second = executor.submit(StockService().get_realtime_quotes, ["600519"])
            time.sleep(0.05)
            provider_release.set()
            assert first.result(timeout=2)["items"]
            assert second.result(timeout=2)["items"]

    assert manager_cls.return_value.get_realtime_quotes.call_count == 1


def test_stock_service_returns_stale_quote_and_defers_failed_symbol_retry():
    quote = SimpleNamespace(code="600519", name="贵州茅台", price=1700.5)

    with patch("data_provider.base.DataFetcherManager") as manager_cls:
        manager_cls.return_value.get_realtime_quotes.side_effect = [
            {"600519": quote},
            {},
        ]
        StockService().get_realtime_quotes(["600519"])
        StockService._quote_cache["600519"].cached_at_monotonic = 0.0
        failed = StockService().get_realtime_quotes(["600519"])
        deferred = StockService().get_realtime_quotes(["600519"])

    assert manager_cls.return_value.get_realtime_quotes.call_count == 2
    assert failed["failed_codes"] == ["600519"]
    assert failed["items"][0]["refresh_status"] == "stale"
    assert failed["items"][0]["is_stale"] is True
    assert failed["items"][0]["failure_count"] == 1
    assert failed["items"][0]["next_retry_at"]
    assert deferred["items"][0]["refresh_status"] == "stale"


def test_batch_quotes_use_configured_akshare_primary_source():
    quote = SimpleNamespace(code="600519")
    fetcher = MagicMock()
    fetcher.get_realtime_quotes.return_value = {"600519": quote}
    manager = DataFetcherManager.__new__(DataFetcherManager)

    with (
        patch("src.config.get_config", return_value=SimpleNamespace(
            realtime_source_priority="akshare_sina,tencent",
            realtime_cache_ttl=15,
        )),
        patch.object(manager, "_get_fetcher_by_name", return_value=fetcher),
        patch.object(manager, "_call_fetcher_method", return_value={"600519": quote}) as call,
        patch.object(manager, "_enrich_realtime_quote", side_effect=lambda value, **_: value),
    ):
        result = manager.get_realtime_quotes(["600519"], fallback_missing=False)

    assert result == {"600519": quote}
    assert call.call_args.kwargs["source"] == "sina"


def test_batch_quotes_use_configured_non_akshare_primary_without_full_fallback():
    quote = SimpleNamespace(code="600519")
    fetcher = MagicMock()
    fetcher.get_realtime_quote.return_value = quote
    manager = DataFetcherManager.__new__(DataFetcherManager)

    with (
        patch("src.config.get_config", return_value=SimpleNamespace(
            realtime_source_priority="efinance,tencent",
            realtime_cache_ttl=15,
        )),
        patch.object(manager, "_get_fetcher_by_name", return_value=fetcher),
        patch.object(manager, "_call_fetcher_method", return_value=quote) as call,
        patch.object(manager, "_enrich_realtime_quote", side_effect=lambda value, **_: value),
        patch.object(manager, "get_realtime_quote") as fallback,
    ):
        result = manager.get_realtime_quotes(["600519"], fallback_missing=False)

    assert result == {"600519": quote}
    call.assert_called_once_with(fetcher, "get_realtime_quote", "600519")
    fallback.assert_not_called()
