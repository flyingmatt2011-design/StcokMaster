from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace

import pandas as pd

from src.analyzer import AnalysisResult
from src.core.pipeline import StockAnalysisPipeline
from src.services.kronos_forecast_service import KronosForecastService


def _config(**overrides):
    values = {
        "kronos_enabled": True,
        "kronos_model": "test/kronos-small",
        "kronos_tokenizer": "test/kronos-tokenizer",
        "kronos_lookback": 400,
        "kronos_pred_len": 5,
        "kronos_sample_count": 3,
        "kronos_device": "cpu",
        "kronos_neutral_band_pct": 1.0,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _bars(count: int = 140):
    start = date(2025, 1, 1)
    return [
        {
            "date": start + timedelta(days=index),
            "open": 10.0 + index * 0.02,
            "high": 10.2 + index * 0.02,
            "low": 9.8 + index * 0.02,
            "close": 10.1 + index * 0.02,
            "volume": 100000 + index,
            "amount": 1000000 + index * 100,
        }
        for index in range(count)
    ]


class _FakePredictor:
    device = "cpu"

    def predict(self, _frame, *, y_timestamp, pred_len, **_kwargs):
        closes = [13.0 + index * 0.1 for index in range(pred_len)]
        return pd.DataFrame(
            {
                "open": closes,
                "high": [value + 0.2 for value in closes],
                "low": [value - 0.2 for value in closes],
                "close": closes,
                "volume": [120000.0] * pred_len,
                "amount": [1500000.0] * pred_len,
            },
            index=pd.to_datetime(y_timestamp),
        )


def test_disabled_forecast_has_zero_report_payload():
    service = KronosForecastService(_config(kronos_enabled=False))

    assert service.forecast(code="600519", bars=_bars(), market="cn") is None


def test_successful_forecast_is_explicitly_excluded_from_scoring(monkeypatch):
    monkeypatch.setattr(KronosForecastService, "_get_predictor", lambda *args, **kwargs: _FakePredictor())

    payload = KronosForecastService(_config()).forecast(code="600519", bars=_bars(), market="cn")

    assert payload is not None
    assert payload["status"] == "success"
    assert payload["score_included"] is False
    assert payload["horizon"] == 5
    assert len(payload["forecast_points"]) == 5
    assert len(payload["historical_points"]) == 30
    assert payload["as_of"] == _bars()[-1]["date"].isoformat()


def test_missing_optional_dependency_fails_open(monkeypatch):
    missing = ModuleNotFoundError("No module named 'torch'")
    missing.name = "torch"

    def _raise_missing(*_args, **_kwargs):
        raise missing

    monkeypatch.setattr(KronosForecastService, "_get_predictor", _raise_missing)

    payload = KronosForecastService(_config()).forecast(code="600519", bars=_bars(), market="cn")

    assert payload is not None
    assert payload["status"] == "unavailable"
    assert payload["reason"] == "optional_dependency_missing"
    assert payload["score_included"] is False
    assert payload["metadata"]["dependency"] == "torch"


def test_pipeline_attachment_does_not_change_final_score_or_action(monkeypatch):
    expected = {
        "schema_version": 1,
        "status": "success",
        "score_included": False,
        "source": "kronos",
    }
    monkeypatch.setattr(KronosForecastService, "forecast", lambda *_args, **_kwargs: expected)

    pipeline = object.__new__(StockAnalysisPipeline)
    pipeline.config = _config()
    pipeline.db = SimpleNamespace(get_data_range=lambda *_args, **_kwargs: _bars())
    pipeline._emit_progress = lambda *_args, **_kwargs: None
    result = AnalysisResult(
        code="600519",
        name="贵州茅台",
        sentiment_score=67,
        trend_prediction="看多",
        operation_advice="观察",
        action="watch",
    )

    pipeline._attach_kronos_forecast(result=result, code="600519", stock_name="贵州茅台")

    assert result.sentiment_score == 67
    assert result.operation_advice == "观察"
    assert result.action == "watch"
    assert result.kronos_forecast == expected
    assert result.to_dict()["kronos_forecast"]["score_included"] is False


def test_pipeline_backfills_history_for_kronos_without_changing_decision(monkeypatch):
    captured = {}

    def _forecast(_service, *, code, bars, market):
        captured["code"] = code
        captured["bars"] = list(bars)
        captured["market"] = market
        return {
            "schema_version": 1,
            "status": "success",
            "score_included": False,
            "source": "kronos",
        }

    monkeypatch.setattr(KronosForecastService, "forecast", _forecast)

    initial_bars = _bars(56)
    backfill_bars = _bars(140)
    database = SimpleNamespace(
        get_data_range=lambda *_args, **_kwargs: initial_bars,
        save_daily_data=lambda *_args, **_kwargs: 84,
    )
    fetcher_manager = SimpleNamespace(
        get_daily_data=lambda *_args, **_kwargs: (
            pd.DataFrame(backfill_bars),
            "BaostockFetcher",
        )
    )
    pipeline = object.__new__(StockAnalysisPipeline)
    pipeline.config = _config()
    pipeline.db = database
    pipeline.fetcher_manager = fetcher_manager
    pipeline._emit_progress = lambda *_args, **_kwargs: None
    result = AnalysisResult(
        code="600519",
        name="贵州茅台",
        sentiment_score=67,
        trend_prediction="看多",
        operation_advice="观察",
        action="watch",
    )

    pipeline._attach_kronos_forecast(result=result, code="600519", stock_name="贵州茅台")

    assert len(captured["bars"]) == 140
    assert result.kronos_forecast["metadata"]["history_source"] == "forecast_backfill:BaostockFetcher"
    assert result.sentiment_score == 67
    assert result.operation_advice == "观察"
    assert result.action == "watch"
