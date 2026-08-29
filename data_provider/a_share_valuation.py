# -*- coding: utf-8 -*-
"""A-share historical PE/PB/PS percentile enrichment.

Endpoint selection is adapted from ``a-stock-data-quant/lib/valuation.py``
(MIT License, Copyright (c) 2026 lao-liu).  Percentiles use empirical rank
instead of min/max normalization and are context-only: no StockMaster score is
changed here.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from statistics import median
from typing import Any, Dict, List, Optional

import requests

from .provider_daily_cache import read_session_cache, write_session_cache

logger = logging.getLogger(__name__)

_FIELD_MAP = {"pe": "PE_TTM", "pb": "PB_MRQ", "ps": "PS_TTM"}


def _metric_payload(values: List[float], dates: List[str]) -> Optional[Dict[str, Any]]:
    clean = [float(value) for value in values if value is not None and float(value) > 0]
    if not clean:
        return None
    current = clean[-1]
    percentile = sum(1 for value in clean if value < current) / len(clean) * 100
    history = []
    aligned_dates = dates[-len(clean):]
    for index in range(max(0, len(clean) - 20), len(clean)):
        history.append({"date": aligned_dates[index], "value": round(clean[index], 4)})
    return {
        "current": round(current, 4),
        "percentile": round(percentile, 2),
        "min": round(min(clean), 4),
        "max": round(max(clean), 4),
        "median": round(median(clean), 4),
        "sample_count": len(clean),
        "history": history,
    }


class AShareValuationHistoryService:
    """Fetch five-year historical valuation in one request with AKShare fallback."""

    def __init__(self, timeout_seconds: float = 6.0, period_years: int = 5):
        self.timeout_seconds = max(1.0, float(timeout_seconds))
        self.period_years = max(1, min(int(period_years), 10))

    def get(self, stock_code: str) -> Dict[str, Any]:
        code = str(stock_code).strip()[-6:]
        cache_key = f"{code}_{self.period_years}y"
        cached = read_session_cache("a_share_valuation_history", cache_key)
        if isinstance(cached, dict) and cached.get("metrics"):
            cached = dict(cached)
            cached["cache_hit"] = True
            return cached

        try:
            result = self._fetch_eastmoney(code)
        except Exception as exc:
            logger.warning("[历史估值] %s 东方财富获取失败，切换百度估值: %s", code, exc)
            result = {"period_years": self.period_years, "provider": "eastmoney_valuation_history", "metrics": {}}
        if not result.get("metrics"):
            result = self._fetch_baidu(code)
        if result.get("metrics"):
            write_session_cache("a_share_valuation_history", cache_key, result)
        return result

    def _fetch_eastmoney(self, code: str) -> Dict[str, Any]:
        page_size = self.period_years * 260
        response = requests.get(
            "https://datacenter-web.eastmoney.com/api/data/v1/get",
            params={
                "reportName": "RPT_VALUEANALYSIS_DET",
                "columns": "TRADE_DATE,PE_TTM,PB_MRQ,PS_TTM,CLOSE_PRICE",
                "filter": f'(SECURITY_CODE="{code}")',
                "pageNumber": 1,
                "pageSize": page_size,
                "sortColumns": "TRADE_DATE",
                "sortTypes": "-1",
            },
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                "Referer": "https://data.eastmoney.com/",
            },
            timeout=self.timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
        rows = ((payload.get("result") or {}).get("data") or []) if isinstance(payload, dict) else []
        rows = list(reversed(rows))
        metrics: Dict[str, Any] = {}
        for name, field in _FIELD_MAP.items():
            values: List[float] = []
            dates: List[str] = []
            for row in rows:
                try:
                    value = float(row.get(field))
                except (TypeError, ValueError):
                    continue
                if value <= 0:
                    continue
                values.append(value)
                dates.append(str(row.get("TRADE_DATE") or "")[:10])
            metric = _metric_payload(values, dates)
            if metric:
                metrics[name] = metric
        return {
            "as_of": max((item["history"][-1]["date"] for item in metrics.values() if item.get("history")), default=""),
            "period_years": self.period_years,
            "provider": "eastmoney_valuation_history",
            "metrics": metrics,
            "cache_hit": False,
        }

    def _fetch_baidu(self, code: str) -> Dict[str, Any]:
        try:
            import akshare as ak
        except ImportError:
            return {"period_years": self.period_years, "provider": "none", "metrics": {}}

        def fetch_metric(name: str) -> tuple[str, Optional[Dict[str, Any]]]:
            try:
                period_labels = {
                    1: "近一年",
                    3: "近三年",
                    5: "近五年",
                    10: "近十年",
                }
                frame = ak.stock_zh_valuation_baidu(
                    symbol=code,
                    indicator=name,
                    period=period_labels.get(self.period_years, "全部"),
                )
                if frame is None or frame.empty:
                    return name, None
                values: List[float] = []
                dates: List[str] = []
                for _, row in frame.iterrows():
                    try:
                        value = float(row.iloc[-1])
                    except (TypeError, ValueError):
                        continue
                    if value <= 0:
                        continue
                    values.append(value)
                    dates.append(str(row.iloc[0])[:10])
                return name, _metric_payload(values, dates)
            except Exception as exc:
                logger.debug("[历史估值] %s %s 百度 fallback 失败: %s", code, name, exc)
                return name, None

        metrics: Dict[str, Any] = {}
        with ThreadPoolExecutor(max_workers=3, thread_name_prefix="valuation-baidu") as executor:
            for name, metric in executor.map(fetch_metric, _FIELD_MAP):
                if metric:
                    metrics[name] = metric
        return {
            "as_of": max((item["history"][-1]["date"] for item in metrics.values() if item.get("history")), default=date.today().isoformat()),
            "period_years": self.period_years,
            "provider": "akshare_baidu_valuation",
            "metrics": metrics,
            "cache_hit": False,
        }
