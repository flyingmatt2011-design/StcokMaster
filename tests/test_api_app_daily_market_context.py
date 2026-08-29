# -*- coding: utf-8 -*-
"""Tests for the desktop startup daily market context prewarm."""

from __future__ import annotations

import asyncio
from datetime import date
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from api.app import _prewarm_daily_market_context_in_background


def test_desktop_startup_prewarm_never_generates_market_context() -> None:
    config = SimpleNamespace(
        daily_market_context_enabled=True,
        market_review_enabled=True,
    )
    pipeline = MagicMock()
    pipeline._load_daily_market_context.return_value = None

    with patch("api.app.asyncio.sleep", new=AsyncMock()), \
         patch("api.app.run_in_threadpool", new=AsyncMock(side_effect=lambda func: func())), \
         patch("src.config.get_config", return_value=config), \
         patch("src.core.pipeline.StockAnalysisPipeline", return_value=pipeline) as pipeline_cls, \
         patch(
             "src.core.trading_calendar.get_effective_trading_date",
             return_value=date(2026, 8, 28),
         ):
        asyncio.run(_prewarm_daily_market_context_in_background())

    pipeline_cls.assert_called_once_with(
        config=config,
        query_source="desktop_startup_prewarm",
        daily_market_context_enabled=True,
        daily_market_context_allow_generate=False,
    )
    pipeline._load_daily_market_context.assert_called_once_with(
        "cn",
        target_date=date(2026, 8, 28),
    )
