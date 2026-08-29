from __future__ import annotations

import sys
from types import SimpleNamespace

import pandas as pd

from src.services.a_share_market_temperature import AShareMarketTemperatureService


def test_market_temperature_collects_free_context_without_scoring(monkeypatch):
    monkeypatch.setattr(
        "src.services.a_share_market_temperature.read_session_cache",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "src.services.a_share_market_temperature.write_session_cache",
        lambda *args, **kwargs: True,
    )
    fake_ak = SimpleNamespace(
        stock_buffett_index_lg=lambda: pd.DataFrame({"巴菲特指标": [80.0, 90.0, 100.0]}),
        stock_ebs_lg=lambda: pd.DataFrame({"股债利差": [3.2]}),
        stock_a_high_low_statistics=lambda symbol: pd.DataFrame({"创新高": [32], "创新低": [8]}),
        index_option_50etf_qvix=lambda: pd.DataFrame({"close": [18.5]}),
    )
    monkeypatch.setitem(sys.modules, "akshare", fake_ak)

    context = AShareMarketTemperatureService(timeout_seconds=2).get_context()

    assert context["status"] == "ok"
    assert context["score_included"] is False
    assert context["indicators"]["new_high_low"]["ratio"] == 4.0
    assert context["indicators"]["qvix"]["value"] == 18.5


def test_market_review_payload_exposes_context_but_keeps_market_light_separate(monkeypatch):
    from src.market_analyzer import MarketAnalyzer, MarketOverview

    analyzer = MarketAnalyzer.__new__(MarketAnalyzer)
    analyzer.region = "cn"
    analyzer.profile = SimpleNamespace(has_market_stats=True)
    analyzer.config = SimpleNamespace(market_review_color_scheme="red_up")
    analyzer.build_market_light_snapshot = lambda overview: {"score": 59}
    overview = MarketOverview(
        date="2026-08-25",
        supplemental_indicators={
            "score_included": False,
            "indicators": {"qvix": {"value": 18.5}},
        },
    )

    payload = analyzer.build_market_review_payload(overview, [], "## 复盘")

    assert payload["market_light"] == {"score": 59}
    assert payload["market_context_indicators"]["score_included"] is False
