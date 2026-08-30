"""Lightweight market dashboard snapshots without news or LLM generation."""

from __future__ import annotations

import copy
import threading
import time
from datetime import datetime
from typing import Any, Dict

from src.core.trading_calendar import build_market_phase_context
from src.market_analyzer import MarketAnalyzer


class MarketDashboardService:
    """Collect the structured market fields used by the home dashboard."""

    _condition = threading.Condition(threading.RLock())
    _cache: Dict[str, tuple[float, Dict[str, Any]]] = {}
    _refreshing: set[str] = set()
    _OPEN_TTL_SECONDS = 240.0
    _CLOSED_TTL_SECONDS = 6 * 60 * 60.0

    def __init__(self, config: Any) -> None:
        self.config = config

    @classmethod
    def _reset_cache_for_tests(cls) -> None:
        with cls._condition:
            cls._cache.clear()
            cls._refreshing.clear()
            cls._condition.notify_all()

    @staticmethod
    def _market_code(region: str) -> str:
        return {"cn": "CN", "hk": "HK", "us": "US"}.get(region.lower(), region.upper())

    def _cache_ttl_seconds(self, region: str) -> float:
        context = build_market_phase_context(market=self._market_code(region))
        if context.is_market_open_now or context.is_partial_bar:
            return self._OPEN_TTL_SECONDS
        if context.is_trading_day is False:
            return self._CLOSED_TTL_SECONDS
        return self._OPEN_TTL_SECONDS

    def get_snapshot(self, region: str = "cn") -> Dict[str, Any]:
        key = (region or "cn").strip().lower()
        now = time.monotonic()
        ttl_seconds = self._cache_ttl_seconds(key)
        with self._condition:
            cached = self._cache.get(key)
            if cached and now - cached[0] < ttl_seconds:
                result = copy.deepcopy(cached[1])
                result["cache_hit"] = True
                return result
            if key in self._refreshing:
                self._condition.wait_for(lambda: key not in self._refreshing, timeout=30.0)
                cached = self._cache.get(key)
                if cached:
                    result = copy.deepcopy(cached[1])
                    result["cache_hit"] = True
                    return result
            self._refreshing.add(key)

        try:
            analyzer = MarketAnalyzer(
                search_service=None,
                analyzer=None,
                region=key,
                config=self.config,
            )
            overview = analyzer.get_market_overview(force_refresh=True)
            payload = analyzer.build_market_review_payload(
                overview=overview,
                news=[],
                report="",
            )
            result = {
                "payload": payload,
                "refreshed_at": datetime.now().astimezone().isoformat(),
                "mode": "market_data_only",
                "uses_llm": False,
                "cache_hit": False,
            }
            with self._condition:
                self._cache[key] = (time.monotonic(), copy.deepcopy(result))
            return result
        except Exception:
            with self._condition:
                cached = self._cache.get(key)
            if cached:
                result = copy.deepcopy(cached[1])
                result.update({"cache_hit": True, "is_stale": True})
                return result
            raise
        finally:
            with self._condition:
                self._refreshing.discard(key)
                self._condition.notify_all()
