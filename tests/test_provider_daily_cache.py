from __future__ import annotations

import os
from datetime import date
from tempfile import TemporaryDirectory
from unittest.mock import patch

from data_provider.provider_daily_cache import (
    effective_session_date,
    read_session_cache,
    write_session_cache,
)


def test_effective_session_date_keeps_weekend_on_friday() -> None:
    assert effective_session_date(date(2026, 8, 21)) == date(2026, 8, 21)
    assert effective_session_date(date(2026, 8, 22)) == date(2026, 8, 21)
    assert effective_session_date(date(2026, 8, 23)) == date(2026, 8, 21)
    assert effective_session_date(date(2026, 8, 24)) == date(2026, 8, 24)


def test_session_cache_is_atomic_and_session_scoped() -> None:
    with TemporaryDirectory() as temp_dir, patch.dict(
        os.environ,
        {"DATABASE_PATH": os.path.join(temp_dir, "stock_analysis.db")},
    ):
        assert write_session_cache(
            "fundamental",
            "600519",
            {"score_input": 17.5},
            session_date=date(2026, 8, 23),
        )
        assert read_session_cache(
            "fundamental",
            "600519",
            session_date=date(2026, 8, 22),
        ) == {"score_input": 17.5}
        assert read_session_cache(
            "fundamental",
            "600519",
            session_date=date(2026, 8, 24),
        ) is None
