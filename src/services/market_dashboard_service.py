"""Lightweight market dashboard snapshots without news or LLM generation."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict

from src.market_analyzer import MarketAnalyzer


class MarketDashboardService:
    """Collect the structured market fields used by the home dashboard."""

    def __init__(self, config: Any) -> None:
        self.config = config

    def get_snapshot(self, region: str = "cn") -> Dict[str, Any]:
        analyzer = MarketAnalyzer(
            search_service=None,
            analyzer=None,
            region=region,
            config=self.config,
        )
        overview = analyzer.get_market_overview(force_refresh=True)
        payload = analyzer.build_market_review_payload(
            overview=overview,
            news=[],
            report="",
        )
        return {
            "payload": payload,
            "refreshed_at": datetime.now().astimezone().isoformat(),
            "mode": "market_data_only",
            "uses_llm": False,
        }
