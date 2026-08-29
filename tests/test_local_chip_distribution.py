# -*- coding: utf-8 -*-
"""Tests for the BaoStock-backed local chip distribution estimator."""

from contextlib import nullcontext

import pytest

from data_provider.baostock_fetcher import BaostockFetcher
from data_provider.chip_distribution import calculate_chip_distribution


def _sample_klines(count: int = 30):
    rows = []
    for index in range(count):
        low = 10 + index * 0.08
        high = low + 0.8
        close = low + 0.5
        volume = 1_000_000 + index * 10_000
        rows.append(
            {
                "date": f"2026-07-{index + 1:02d}",
                "open": low + 0.2,
                "high": high,
                "low": low,
                "close": close,
                "volume": volume,
                "amount": volume * (low + 0.45),
                "turnover": 1.2 + (index % 5) * 0.1,
            }
        )
    return rows


def test_local_chip_distribution_maps_existing_contract_metrics():
    result = calculate_chip_distribution(_sample_klines(), bins=80)

    assert result is not None
    assert result["date"] == "2026-07-30"
    assert result["days"] == 30
    assert result["bins"] == 80
    assert result["min_price"] < result["avg_cost"] < result["max_price"]
    assert 0 <= result["profit_ratio"] <= 1
    assert result["cost_90_low"] <= result["cost_70_low"]
    assert result["cost_70_low"] <= result["avg_cost"] <= result["cost_70_high"]
    assert result["cost_70_high"] <= result["cost_90_high"]
    assert result["concentration_70"] <= result["concentration_90"]
    assert sum(item["ratio"] for item in result["items"]) == pytest.approx(1.0)
    assert result["turnover_coverage"] == 1.0


@pytest.mark.parametrize(
    "rows",
    [
        _sample_klines(1),
        [{**row, "turnover": ""} for row in _sample_klines(5)],
        [{**row, "volume": 0} for row in _sample_klines(5)],
    ],
)
def test_local_chip_distribution_rejects_incomplete_inputs(rows):
    assert calculate_chip_distribution(rows) is None


class _FakeQueryResult:
    fields = [
        "date",
        "open",
        "high",
        "low",
        "close",
        "volume",
        "amount",
        "turn",
        "tradestatus",
    ]

    def __init__(self, rows):
        self.error_code = "0"
        self.error_msg = ""
        self._rows = rows
        self._index = -1

    def next(self):
        self._index += 1
        return self._index < len(self._rows)

    def get_row_data(self):
        return self._rows[self._index]


class _FakeBaoStock:
    def __init__(self, rows):
        self._rows = rows
        self.query_kwargs = None

    def query_history_k_data_plus(self, **kwargs):
        self.query_kwargs = kwargs
        return _FakeQueryResult(self._rows)


def test_baostock_fetcher_uses_unadjusted_turnover_klines_and_maps_result():
    rows = []
    for item in _sample_klines():
        rows.append(
            [
                item["date"],
                str(item["open"]),
                str(item["high"]),
                str(item["low"]),
                str(item["close"]),
                str(item["volume"]),
                str(item["amount"]),
                str(item["turnover"]),
                "1",
            ]
        )
    fake_baostock = _FakeBaoStock(rows)
    fetcher = BaostockFetcher()
    fetcher._baostock_session = lambda: nullcontext(fake_baostock)

    chip = fetcher.get_chip_distribution("600519")

    assert chip is not None
    assert chip.code == "600519"
    assert chip.date == "2026-07-30"
    assert chip.source == "baostock_local_cyq"
    assert chip.avg_cost > 0
    assert 0 <= chip.profit_ratio <= 1
    assert chip.cost_90_low <= chip.cost_70_low <= chip.cost_70_high <= chip.cost_90_high
    assert fake_baostock.query_kwargs["code"] == "sh.600519"
    assert fake_baostock.query_kwargs["adjustflag"] == "3"
    assert "turn" in fake_baostock.query_kwargs["fields"]


def test_baostock_fetcher_skips_etf_before_opening_session():
    fetcher = BaostockFetcher()
    fetcher._baostock_session = lambda: pytest.fail("ETF must not query BaoStock chips")

    assert fetcher.get_chip_distribution("510300") is None
