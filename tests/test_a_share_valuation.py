from __future__ import annotations

import sys
from types import SimpleNamespace

import pandas as pd

from data_provider.a_share_valuation import AShareValuationHistoryService


class _Response:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def _disable_cache(monkeypatch):
    monkeypatch.setattr("data_provider.a_share_valuation.read_session_cache", lambda *args, **kwargs: None)
    monkeypatch.setattr("data_provider.a_share_valuation.write_session_cache", lambda *args, **kwargs: True)


def test_eastmoney_history_uses_empirical_percentile(monkeypatch):
    _disable_cache(monkeypatch)
    rows = [
        {"TRADE_DATE": "2026-08-25", "PE_TTM": 30, "PB_MRQ": 3, "PS_TTM": 6},
        {"TRADE_DATE": "2026-08-24", "PE_TTM": 20, "PB_MRQ": 2, "PS_TTM": 4},
        {"TRADE_DATE": "2026-08-23", "PE_TTM": 10, "PB_MRQ": 1, "PS_TTM": 2},
    ]
    monkeypatch.setattr(
        "data_provider.a_share_valuation.requests.get",
        lambda *args, **kwargs: _Response({"result": {"data": rows}}),
    )

    result = AShareValuationHistoryService().get("600519")

    assert result["provider"] == "eastmoney_valuation_history"
    assert result["metrics"]["pe"]["current"] == 30
    assert result["metrics"]["pe"]["percentile"] == 66.67
    assert result["metrics"]["pe"]["sample_count"] == 3


def test_baidu_fallback_runs_when_eastmoney_fails(monkeypatch):
    _disable_cache(monkeypatch)

    def fail(*args, **kwargs):
        raise TimeoutError("eastmoney timeout")

    monkeypatch.setattr("data_provider.a_share_valuation.requests.get", fail)
    fake_ak = SimpleNamespace(
        stock_zh_valuation_baidu=lambda **kwargs: pd.DataFrame({
            "date": ["2026-08-23", "2026-08-24", "2026-08-25"],
            "value": [10.0, 11.0, 12.0],
        })
    )
    monkeypatch.setitem(sys.modules, "akshare", fake_ak)

    result = AShareValuationHistoryService(period_years=5).get("600519")

    assert result["provider"] == "akshare_baidu_valuation"
    assert set(result["metrics"]) == {"pe", "pb", "ps"}
    assert result["metrics"]["pe"]["current"] == 12
