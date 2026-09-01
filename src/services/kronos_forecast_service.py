"""Optional, fail-open Kronos K-line forecast for report display only.

This service is deliberately invoked after StockMaster has finalized its score,
guardrails, and action. Its output must never be added to an LLM prompt or used
to alter the existing decision pipeline.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from datetime import date, timedelta
from typing import Any, Dict, Iterable, List, Optional, Tuple

import pandas as pd

from src.core.trading_calendar import is_market_open


logger = logging.getLogger(__name__)

_PRICE_COLUMNS = ("open", "high", "low", "close")
_MODEL_COLUMNS = (*_PRICE_COLUMNS, "volume", "amount")
_MIN_HISTORY_BARS = 120
_DISPLAY_HISTORY_BARS = 30


def _finite_float(value: Any) -> Optional[float]:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _rounded(value: Any, digits: int = 4) -> Optional[float]:
    parsed = _finite_float(value)
    return round(parsed, digits) if parsed is not None else None


def _bar_value(bar: Any, key: str) -> Any:
    if isinstance(bar, dict):
        return bar.get(key)
    return getattr(bar, key, None)


class KronosForecastService:
    """Lazy-load and cache the optional Kronos predictor for A-share reports."""

    _predictor_lock = threading.RLock()
    _predictors: Dict[Tuple[str, str, str, int], Any] = {}

    def __init__(self, config: Any):
        self.config = config

    @staticmethod
    def minimum_history_bars() -> int:
        """Return the minimum completed-bar count accepted by the model stage."""
        return _MIN_HISTORY_BARS

    @property
    def enabled(self) -> bool:
        return bool(getattr(self.config, "kronos_enabled", False))

    def forecast(
        self,
        *,
        code: str,
        bars: Iterable[Any],
        market: Optional[str] = "cn",
    ) -> Optional[Dict[str, Any]]:
        """Return a structured forecast, or ``None`` when the feature is off/out of scope."""
        if not self.enabled or market != "cn":
            return None

        started_at = time.monotonic()
        model_id = str(getattr(self.config, "kronos_model", "") or "").strip()
        tokenizer_id = str(getattr(self.config, "kronos_tokenizer", "") or "").strip()
        if not model_id or not tokenizer_id:
            return self._status_result(
                status="unavailable",
                reason="model_not_configured",
                model_id=model_id,
                tokenizer_id=tokenizer_id,
                started_at=started_at,
            )

        lookback = max(
            _MIN_HISTORY_BARS,
            min(int(getattr(self.config, "kronos_lookback", 400) or 400), 512),
        )
        horizon = max(1, min(int(getattr(self.config, "kronos_pred_len", 5) or 5), 20))
        frame = self._prepare_frame(bars, lookback=lookback)
        if frame is None or len(frame) < _MIN_HISTORY_BARS:
            return self._status_result(
                status="insufficient_data",
                reason="insufficient_daily_bars",
                model_id=model_id,
                tokenizer_id=tokenizer_id,
                started_at=started_at,
                metadata={"available_bars": 0 if frame is None else len(frame), "required_bars": _MIN_HISTORY_BARS},
            )

        device = str(getattr(self.config, "kronos_device", "auto") or "auto").strip().lower()
        sample_count = max(1, min(int(getattr(self.config, "kronos_sample_count", 5) or 5), 20))
        neutral_band_pct = max(
            0.0,
            float(getattr(self.config, "kronos_neutral_band_pct", 1.0) or 1.0),
        )
        try:
            with self._predictor_lock:
                predictor = self._get_predictor(
                    model_id=model_id,
                    tokenizer_id=tokenizer_id,
                    device=device,
                    max_context=lookback,
                )
                x_timestamp = pd.Series(frame.index)
                y_timestamp = pd.Series(self._future_trading_dates(frame.index[-1].date(), horizon))
                prediction = predictor.predict(
                    frame.loc[:, list(_MODEL_COLUMNS)],
                    x_timestamp=x_timestamp,
                    y_timestamp=y_timestamp,
                    pred_len=horizon,
                    T=0.6,
                    top_p=0.9,
                    sample_count=sample_count,
                    verbose=False,
                )
        except ModuleNotFoundError as exc:
            logger.warning("Kronos optional dependency is unavailable for %s: %s", code, exc)
            return self._status_result(
                status="unavailable",
                reason="optional_dependency_missing",
                model_id=model_id,
                tokenizer_id=tokenizer_id,
                started_at=started_at,
                metadata={"dependency": str(getattr(exc, "name", "") or "unknown")},
            )
        except Exception as exc:
            logger.warning("Kronos forecast failed for %s: %s", code, exc, exc_info=True)
            return self._status_result(
                status="failed",
                reason="inference_failed",
                model_id=model_id,
                tokenizer_id=tokenizer_id,
                started_at=started_at,
                metadata={"error_type": type(exc).__name__},
            )

        try:
            return self._build_success_result(
                code=code,
                frame=frame,
                prediction=prediction,
                predictor=predictor,
                model_id=model_id,
                tokenizer_id=tokenizer_id,
                horizon=horizon,
                sample_count=sample_count,
                neutral_band_pct=neutral_band_pct,
                started_at=started_at,
            )
        except Exception as exc:
            logger.warning("Kronos result normalization failed for %s: %s", code, exc, exc_info=True)
            return self._status_result(
                status="failed",
                reason="invalid_prediction_output",
                model_id=model_id,
                tokenizer_id=tokenizer_id,
                started_at=started_at,
                metadata={"error_type": type(exc).__name__},
            )

    @classmethod
    def _get_predictor(
        cls,
        *,
        model_id: str,
        tokenizer_id: str,
        device: str,
        max_context: int,
    ) -> Any:
        resolved_device = "auto" if device in {"", "auto"} else device
        key = (model_id, tokenizer_id, resolved_device, max_context)
        predictor = cls._predictors.get(key)
        if predictor is not None:
            return predictor

        from src.vendor.kronos import Kronos, KronosPredictor, KronosTokenizer

        tokenizer = KronosTokenizer.from_pretrained(tokenizer_id)
        model = Kronos.from_pretrained(model_id)
        tokenizer.eval()
        model.eval()
        predictor = KronosPredictor(
            model,
            tokenizer,
            device=None if resolved_device == "auto" else resolved_device,
            max_context=max_context,
        )
        cls._predictors[key] = predictor
        return predictor

    @staticmethod
    def _prepare_frame(bars: Iterable[Any], *, lookback: int) -> Optional[pd.DataFrame]:
        rows: List[Dict[str, Any]] = []
        for bar in bars or []:
            bar_date = _bar_value(bar, "date")
            values = {column: _finite_float(_bar_value(bar, column)) for column in _MODEL_COLUMNS}
            if bar_date is None or any(values[column] is None for column in _PRICE_COLUMNS):
                continue
            values["volume"] = values["volume"] or 0.0
            values["amount"] = values["amount"] or 0.0
            rows.append({"date": bar_date, **values})
        if not rows:
            return None

        frame = pd.DataFrame(rows)
        frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
        frame = frame.dropna(subset=["date"]).sort_values("date")
        frame = frame.drop_duplicates(subset=["date"], keep="last").tail(lookback)
        if frame.empty:
            return None
        return frame.set_index("date")

    @staticmethod
    def _future_trading_dates(last_date: date, horizon: int) -> List[pd.Timestamp]:
        resolved: List[pd.Timestamp] = []
        candidate = last_date
        while len(resolved) < horizon:
            candidate += timedelta(days=1)
            if candidate.weekday() >= 5:
                continue
            if not is_market_open("cn", candidate):
                continue
            resolved.append(pd.Timestamp(candidate))
        return resolved

    @staticmethod
    def _status_result(
        *,
        status: str,
        reason: str,
        model_id: str,
        tokenizer_id: str,
        started_at: float,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return {
            "schema_version": 1,
            "status": status,
            "reason": reason,
            "source": "kronos",
            "score_included": False,
            "model": model_id or None,
            "tokenizer": tokenizer_id or None,
            "duration_ms": int((time.monotonic() - started_at) * 1000),
            "metadata": metadata or {},
        }

    @staticmethod
    def _build_success_result(
        *,
        code: str,
        frame: pd.DataFrame,
        prediction: pd.DataFrame,
        predictor: Any,
        model_id: str,
        tokenizer_id: str,
        horizon: int,
        sample_count: int,
        neutral_band_pct: float,
        started_at: float,
    ) -> Dict[str, Any]:
        if prediction is None or prediction.empty or "close" not in prediction.columns:
            raise ValueError("Kronos returned an empty prediction")

        current_close = _finite_float(frame.iloc[-1]["close"])
        predicted_closes = [_finite_float(value) for value in prediction["close"].tolist()]
        if current_close is None or any(value is None for value in predicted_closes):
            raise ValueError("Kronos returned non-finite close values")
        final_close = float(predicted_closes[-1])
        predicted_return_pct = ((final_close / current_close) - 1.0) * 100.0 if current_close else 0.0
        direction = (
            "bullish"
            if predicted_return_pct > neutral_band_pct
            else "bearish"
            if predicted_return_pct < -neutral_band_pct
            else "neutral"
        )

        path = [current_close, *[float(value) for value in predicted_closes]]
        peak = path[0]
        max_drawdown_pct = 0.0
        for value in path[1:]:
            peak = max(peak, value)
            if peak > 0:
                max_drawdown_pct = min(max_drawdown_pct, ((value / peak) - 1.0) * 100.0)

        historical_points = [
            {"date": index.date().isoformat(), "close": _rounded(row["close"])}
            for index, row in frame.tail(_DISPLAY_HISTORY_BARS).iterrows()
        ]
        forecast_points = []
        for index, row in prediction.iterrows():
            point = {"date": pd.Timestamp(index).date().isoformat()}
            point.update({column: _rounded(row.get(column)) for column in _MODEL_COLUMNS})
            forecast_points.append(point)

        return {
            "schema_version": 1,
            "status": "success",
            "reason": None,
            "source": "kronos",
            "score_included": False,
            "code": code,
            "model": model_id,
            "tokenizer": tokenizer_id,
            "device": str(getattr(predictor, "device", "unknown")),
            "as_of": frame.index[-1].date().isoformat(),
            "lookback": len(frame),
            "horizon": horizon,
            "sample_count": sample_count,
            "neutral_band_pct": neutral_band_pct,
            "current_close": _rounded(current_close),
            "predicted_final_close": _rounded(final_close),
            "predicted_return_pct": _rounded(predicted_return_pct, 2),
            "predicted_path_max_drawdown_pct": _rounded(max_drawdown_pct, 2),
            "direction": direction,
            "historical_points": historical_points,
            "forecast_points": forecast_points,
            "duration_ms": int((time.monotonic() - started_at) * 1000),
        }
