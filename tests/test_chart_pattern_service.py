from __future__ import annotations

import numpy as np
import pandas as pd

from src.services.chart_pattern_service import analyze_chart_patterns
from src.stock_analyzer import StockTrendAnalyzer


def _frame(length: int = 80) -> pd.DataFrame:
    close = np.linspace(10.0, 14.0, length) + np.sin(np.linspace(0, 8, length)) * 0.2
    return pd.DataFrame({
        "date": pd.date_range("2026-01-01", periods=length, freq="D").astype(str),
        "open": close - 0.05,
        "high": close + 0.2,
        "low": close - 0.2,
        "close": close,
        "volume": np.linspace(1000, 1800, length),
    })


def test_cup_and_handle_is_descriptive_only(monkeypatch):
    frame = _frame(30)
    frame.loc[29, "close"] = 101.0
    monkeypatch.setattr(
        "src.services.chart_pattern_service._pivot_points",
        lambda values, step=3: [
            (5, 1, 100.0),
            (10, -1, 75.0),
            (15, 1, 98.0),
            (20, -1, 92.0),
            (25, 1, 101.0),
        ],
    )

    result = analyze_chart_patterns(frame)

    pattern = next(item for item in result["patterns"] if item["type"] == "cup_and_handle")
    assert pattern["label"] == "杯柄形态"
    assert result["score_included"] is False


def test_pattern_context_does_not_change_existing_signal_score(monkeypatch):
    frame = _frame()
    analyzer = StockTrendAnalyzer()
    monkeypatch.setattr(
        "src.stock_analyzer.analyze_chart_patterns",
        lambda frame: {
            "patterns": [{"type": "w_bottom", "label": "W底"}],
            "summary": "W底（形成中）",
        },
    )
    with_pattern = analyzer.analyze(frame, "600519")
    monkeypatch.setattr(
        "src.stock_analyzer.analyze_chart_patterns",
        lambda frame: {"patterns": [], "summary": "未识别到典型形态"},
    )
    without_pattern = analyzer.analyze(frame, "600519")

    assert with_pattern.signal_score == without_pattern.signal_score
    assert with_pattern.buy_signal == without_pattern.buy_signal
    assert with_pattern.chart_patterns[0]["type"] == "w_bottom"
    assert with_pattern.to_dict()["chart_patterns_score_included"] is False
