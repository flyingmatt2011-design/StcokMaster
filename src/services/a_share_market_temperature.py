# -*- coding: utf-8 -*-
"""Supplemental A-share market-temperature indicators.

Indicator selection is adapted from ``a-stock-data-quant/lib/market_temp.py``
(MIT License, Copyright (c) 2026 lao-liu).  These values are attached to the
market-review context only; the canonical StockMaster Market Light score and
alert thresholds remain unchanged.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime
from typing import Any, Callable, Dict, Optional

from data_provider.provider_daily_cache import read_session_cache, write_session_cache

logger = logging.getLogger(__name__)


def _safe_number(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None


class AShareMarketTemperatureService:
    """Collect slow-moving valuation/risk indicators once per trading session."""

    def __init__(self, timeout_seconds: float = 8.0):
        self.timeout_seconds = max(2.0, float(timeout_seconds))

    def get_context(self) -> Dict[str, Any]:
        cached = read_session_cache("a_share_market_temperature", "context")
        if isinstance(cached, dict):
            cached = dict(cached)
            cached["cache_hit"] = True
            return cached

        try:
            import akshare as ak
        except ImportError:
            return {
                "status": "not_supported",
                "score_included": False,
                "indicators": {},
                "errors": ["akshare_not_installed"],
            }

        tasks: Dict[str, Callable[[], Optional[Dict[str, Any]]]] = {
            "buffett_index": lambda: self._buffett_index(ak),
            "equity_bond_spread": lambda: self._equity_bond_spread(ak),
            "new_high_low": lambda: self._new_high_low(ak),
            "qvix": lambda: self._qvix(ak),
        }
        executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="market-temperature")
        futures = {executor.submit(fetcher): name for name, fetcher in tasks.items()}
        done, pending = wait(futures, timeout=self.timeout_seconds)
        indicators: Dict[str, Any] = {}
        errors = []
        for future in done:
            name = futures[future]
            try:
                value = future.result()
                if value:
                    indicators[name] = value
                else:
                    errors.append(f"{name}:empty")
            except Exception as exc:
                logger.debug("[市场温度扩展] %s 获取失败: %s", name, exc)
                errors.append(f"{name}:{type(exc).__name__}")
        for future in pending:
            errors.append(f"{futures[future]}:timeout")
            future.cancel()
        executor.shutdown(wait=False, cancel_futures=True)

        context = {
            "status": "ok" if len(indicators) == len(tasks) else "partial" if indicators else "failed",
            "as_of": datetime.now().astimezone().isoformat(timespec="seconds"),
            "provider": "akshare_public_market_indicators",
            "score_included": False,
            "indicators": indicators,
            "errors": errors,
            "cache_hit": False,
        }
        write_session_cache("a_share_market_temperature", "context", context)
        return context

    @staticmethod
    def _latest(frame: Any) -> Any:
        if frame is None or getattr(frame, "empty", True):
            return None
        return frame.iloc[-1]

    @staticmethod
    def _pick(row: Any, *keywords: str) -> Optional[float]:
        if row is None:
            return None
        for column in row.index:
            label = str(column).lower()
            if any(keyword.lower() in label for keyword in keywords):
                value = _safe_number(row[column])
                if value is not None:
                    return value
        return None

    def _buffett_index(self, ak: Any) -> Optional[Dict[str, Any]]:
        frame = ak.stock_buffett_index_lg()
        latest = self._latest(frame)
        value = self._pick(latest, "巴菲特指标", "总市值/gdp")
        series = None
        for column in frame.columns:
            if "指标" in str(column) or "gdp" in str(column).lower():
                numeric = frame[column].apply(_safe_number).dropna()
                if not numeric.empty:
                    series = numeric
                    break
        # Current AKShare releases expose date/index/total-market-cap/GDP
        # without a precomputed ratio.  Calculate the same Buffett indicator
        # positionally as a compatibility fallback for renamed/mojibake labels.
        if value is None and len(frame.columns) >= 4:
            market_cap = frame.iloc[:, 2].apply(_safe_number)
            gdp = frame.iloc[:, 3].apply(_safe_number)
            ratio = (market_cap / gdp * 100).replace([float("inf"), float("-inf")], None).dropna()
            if not ratio.empty:
                series = ratio
                value = float(ratio.iloc[-1])
        if value is None:
            return None
        percentile = float((series < value).sum() / len(series) * 100) if series is not None and len(series) else None
        return {"value": round(value, 3), "percentile": round(percentile, 2) if percentile is not None else None}

    def _equity_bond_spread(self, ak: Any) -> Optional[Dict[str, Any]]:
        latest = self._latest(ak.stock_ebs_lg())
        value = self._pick(latest, "利差", "spread", "溢价")
        return {"value": round(value, 4)} if value is not None else None

    def _new_high_low(self, ak: Any) -> Optional[Dict[str, Any]]:
        for symbol in ("hs300", "sz50"):
            try:
                latest = self._latest(ak.stock_a_high_low_statistics(symbol=symbol))
                high = self._pick(latest, "新高", "high")
                low = self._pick(latest, "新低", "low")
                if high is not None and low is not None:
                    return {
                        "universe": symbol,
                        "new_high": int(high),
                        "new_low": int(low),
                        "ratio": round(high / max(low, 1.0), 3),
                    }
            except Exception:
                continue
        return None

    def _qvix(self, ak: Any) -> Optional[Dict[str, Any]]:
        latest = self._latest(ak.index_option_50etf_qvix())
        value = self._pick(latest, "close", "收盘", "qvix", "value")
        return {"value": round(value, 3)} if value is not None else None

    @staticmethod
    def format_prompt_block(context: Dict[str, Any], language: str = "zh") -> str:
        indicators = context.get("indicators") if isinstance(context, dict) else None
        if not isinstance(indicators, dict) or not indicators:
            return ""
        lines = ["## Supplemental Market Risk Indicators" if language == "en" else "## 市场风险补充指标"]
        labels = {
            "buffett_index": "巴菲特指标",
            "equity_bond_spread": "股债利差",
            "new_high_low": "创新高/创新低",
            "qvix": "50ETF QVIX",
        }
        for key in ("buffett_index", "equity_bond_spread", "new_high_low", "qvix"):
            value = indicators.get(key)
            if isinstance(value, dict):
                lines.append(f"- {labels[key]}: {value}")
        lines.append("- 以上指标仅作环境背景，不参与现有市场红绿灯评分。")
        return "\n".join(lines)
