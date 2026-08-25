from __future__ import annotations

from datetime import date, timedelta

from src.search_service import SearchResponse, SearchResult
from src.services.a_share_structured_intel import AShareStructuredIntelService, _date_text


class _Response:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def test_announcements_keep_only_recent_items(monkeypatch):
    recent = date.today().isoformat()
    stale = (date.today() - timedelta(days=20)).isoformat()
    monkeypatch.setattr(
        "src.services.a_share_structured_intel.requests.get",
        lambda *args, **kwargs: _Response({
            "data": {
                "list": [
                    {
                        "notice_date": recent,
                        "title": "最新经营公告",
                        "art_code": "AN1",
                        "columns": [{"column_name": "经营事项"}],
                    },
                    {
                        "notice_date": stale,
                        "title": "过期公告",
                        "art_code": "AN0",
                        "columns": [],
                    },
                ]
            }
        }),
    )

    items = AShareStructuredIntelService()._announcement_items("600519", days=3, limit=8)

    assert [item.title for item in items] == ["最新经营公告"]
    assert items[0].published_date == recent
    assert items[0].source == "东方财富公告"
    assert items[0].relevance_category == "direct_stock"


def test_merge_responses_prioritizes_direct_evidence_and_deduplicates():
    direct_item = SearchResult("公司公告", "直接证据", "https://example.com/a", "交易所")
    duplicate = SearchResult("转载公告", "转载", "https://example.com/a", "搜索引擎")
    generic = SearchResult("行业新闻", "行业", "https://example.com/b", "搜索引擎")
    direct = {
        "announcements": SearchResponse("公告", [direct_item], "EastMoneyNotice")
    }
    searched = {
        "announcements": SearchResponse("公告搜索", [duplicate, generic], "Tavily")
    }

    merged = AShareStructuredIntelService.merge_responses(direct, searched)

    assert [item.url for item in merged["announcements"].results] == [
        "https://example.com/a",
        "https://example.com/b",
    ]
    assert merged["announcements"].results[0].snippet == "直接证据"
    assert merged["announcements"].provider == "EastMoneyNotice + Tavily"


def test_supports_only_a_share_common_stock_codes():
    assert AShareStructuredIntelService.supports("sh600519") is True
    assert AShareStructuredIntelService.supports("000001") is True
    assert AShareStructuredIntelService.supports("510300") is False
    assert AShareStructuredIntelService.supports("AAPL") is False


def test_cninfo_epoch_milliseconds_are_normalized_to_calendar_date(monkeypatch):
    expected = date.today().isoformat()
    epoch_ms = str(int(__import__("datetime").datetime.combine(date.today(), __import__("datetime").time()).timestamp() * 1000))
    captured = {}

    def post(*args, **kwargs):
        captured.update(kwargs.get("data") or {})
        return _Response({
            "results": [{
                "stockCode": "300750",
                "companyShortName": "宁德时代",
                "mainContent": "公司如何看待储能业务？",
                "attachedContent": "公司将持续推进相关业务。",
                "attachedPubDate": epoch_ms,
            }]
        })

    monkeypatch.setattr("src.services.a_share_structured_intel.requests.post", post)
    items = AShareStructuredIntelService()._interactive_items("300750", "宁德时代", 14, 6)

    assert _date_text(epoch_ms) == expected
    assert captured["keyWord"] == "宁德时代"
    assert items[0].published_date == expected
    assert items[0].snippet == "公司将持续推进相关业务。"
