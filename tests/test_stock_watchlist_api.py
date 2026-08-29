# -*- coding: utf-8 -*-
"""Watchlist API regressions for stock-code variant matching."""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

from api.v1.endpoints.stocks import (
    add_to_watchlist,
    get_stock_quote_refresh_policy,
    get_watchlist,
    remove_from_watchlist,
)
from api.v1.schemas.history import WatchlistRequest


class FakeSystemConfigService:
    def __init__(self, stock_list: str) -> None:
        self.stock_list = stock_list
        self.config_version = "cfg-v1"
        self.update_calls: list[str] = []

    def get_config(self, include_schema: bool = False) -> dict:
        return {
            "config_version": self.config_version,
            "items": [{"key": "STOCK_LIST", "value": self.stock_list}],
        }

    def update(self, **kwargs) -> None:
        items = kwargs["items"]
        self.stock_list = items[0]["value"]
        self.update_calls.append(self.stock_list)


def test_watchlist_add_deduplicates_raw_hk_code_against_prefixed_variant() -> None:
    service = FakeSystemConfigService("00700")

    response = add_to_watchlist(
        WatchlistRequest(stock_code="HK00700"),
        service=service,
    )

    assert response.stock_codes == ["00700"]
    assert service.stock_list == "00700"
    assert service.update_calls == []


def test_watchlist_remove_deletes_raw_hk_code_from_prefixed_variant_request() -> None:
    service = FakeSystemConfigService("00700")

    response = remove_from_watchlist(
        WatchlistRequest(stock_code="HK00700"),
        service=service,
    )

    assert response.stock_codes == []
    assert service.stock_list == ""
    assert service.update_calls == [""]


def test_watchlist_matching_is_case_insensitive_for_us_tickers() -> None:
    service = FakeSystemConfigService("aapl")

    add_response = add_to_watchlist(
        WatchlistRequest(stock_code="AAPL"),
        service=service,
    )
    remove_response = remove_from_watchlist(
        WatchlistRequest(stock_code="AAPL"),
        service=service,
    )

    assert add_response.stock_codes == ["aapl"]
    assert remove_response.stock_codes == []
    assert service.update_calls == [""]


def test_watchlist_reads_common_copy_paste_separators() -> None:
    service = FakeSystemConfigService("600519，300750  AAPL")

    response = get_watchlist(service=service)

    assert response.stock_codes == ["600519", "300750", "AAPL"]


def test_watchlist_add_normalizes_existing_mixed_separators_on_write() -> None:
    service = FakeSystemConfigService("600519，300750")

    response = add_to_watchlist(
        WatchlistRequest(stock_code="AAPL"),
        service=service,
    )

    assert response.stock_codes == ["600519", "300750", "AAPL"]
    assert service.stock_list == "600519,300750,AAPL"
    assert service.update_calls == ["600519,300750,AAPL"]


def test_quote_refresh_policy_uses_cn_exchange_calendar_without_fetching_quotes() -> None:
    market_time = datetime(2026, 3, 27, 12, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
    next_transition = datetime(2026, 3, 27, 13, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
    context = SimpleNamespace(
        phase=SimpleNamespace(value="lunch_break"),
        is_trading_day=True,
        is_market_open_now=False,
        market_local_time=market_time,
    )

    with patch(
        "api.v1.endpoints.stocks.build_market_phase_context",
        return_value=context,
    ) as build_context, patch(
        "api.v1.endpoints.stocks.get_next_quote_refresh_transition",
        return_value=next_transition,
    ) as get_transition:
        response = get_stock_quote_refresh_policy()

    assert response.phase == "lunch_break"
    assert response.is_trading_day is True
    assert response.is_market_open_now is False
    assert response.market_local_time == market_time.isoformat()
    assert response.next_transition_at == next_transition.isoformat()
    build_context.assert_called_once_with(market="cn")
    get_transition.assert_called_once_with("cn")
