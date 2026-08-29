import pytest

from scripts.stockmaster.benchmark_first_result import (
    improvement_pct,
    median_ms,
    parse_sse_events,
)


def test_median_and_improvement_are_deterministic():
    assert median_ms([1000, 1200, 1100]) == 1100
    assert improvement_pct(1200, 1000) == pytest.approx(16.6667, rel=1e-4)


def test_sse_parser_handles_split_frames_comments_and_duplicates():
    chunks = [
        ': heartbeat\n\n',
        'event: task\ndata: {"status":"running"}\n\n',
        'event: task\ndata: {"status":"completed","stock_code":"600519"}\n',
        '\ndata: {"status":"completed","stock_code":"600519"}\n\n',
        'event: malformed\ndata: not-json\n\n',
    ]
    events = parse_sse_events(chunks)
    assert [item["event"] for item in events] == ["task", "task"]
    assert events[0]["data"]["status"] == "running"
    assert events[1]["data"]["stock_code"] == "600519"
