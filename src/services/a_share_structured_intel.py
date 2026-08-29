# -*- coding: utf-8 -*-
"""Free structured A-share announcements, research and IR intelligence.

The endpoint mapping and field normalization are adapted from
``a-stock-data-quant/lib/stock_notice.py`` (MIT License,
Copyright (c) 2026 lao-liu).  StockMaster keeps the data in its existing
``SearchResponse`` contract so it participates in the same freshness,
persistence and report paths as other news evidence.
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from typing import Any, Callable, Dict, Iterable, List, Optional

import requests

from data_provider.base import normalize_stock_code
from src.search_provider_base import SearchResponse, SearchResult
from src.services.run_diagnostics import record_provider_run, record_provider_run_started

logger = logging.getLogger(__name__)

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
    ),
}


def _text(value: Any) -> str:
    return " ".join(str(value or "").split())


def _date_text(value: Any) -> str:
    text = _text(value)
    if text.isdigit() and len(text) >= 10:
        try:
            timestamp = int(text)
            if len(text) >= 13:
                timestamp /= 1000
            return datetime.fromtimestamp(timestamp).date().isoformat()
        except (OSError, OverflowError, ValueError):
            return ""
    return text[:10] if len(text) >= 10 else text


def _is_recent(value: str, cutoff: date) -> bool:
    try:
        return datetime.fromisoformat(value[:10]).date() >= cutoff
    except (TypeError, ValueError):
        return False


class AShareStructuredIntelService:
    """Fetch bounded, source-labelled A-share intelligence without API keys."""

    def __init__(self, timeout_seconds: float = 6.0):
        self.timeout_seconds = max(1.0, float(timeout_seconds))

    @staticmethod
    def supports(stock_code: str) -> bool:
        code = normalize_stock_code(stock_code)
        return code.isdigit() and len(code) == 6 and not code.startswith(("15", "16", "18", "51", "52", "56", "58"))

    def fetch(
        self,
        stock_code: str,
        stock_name: str,
        *,
        news_window_days: int = 3,
        research_days: int = 90,
        interactive_days: int = 14,
    ) -> Dict[str, SearchResponse]:
        code = normalize_stock_code(stock_code)
        if not self.supports(code):
            return {}

        tasks: Dict[str, Callable[[], SearchResponse]] = {
            "announcements": lambda: self._fetch_announcements(
                code, max(1, int(news_window_days)), limit=8
            ),
            "market_analysis": lambda: self._fetch_research(
                code, max(7, int(research_days)), limit=6
            ),
            "interactive": lambda: self._fetch_interactive(
                code, stock_name, max(1, int(interactive_days)), limit=6
            ),
        }
        responses: Dict[str, SearchResponse] = {}
        with ThreadPoolExecutor(max_workers=3, thread_name_prefix="structured-intel") as executor:
            futures = {name: executor.submit(task) for name, task in tasks.items()}
            for name, future in futures.items():
                try:
                    responses[name] = future.result()
                except Exception as exc:
                    logger.warning("[结构化情报] %s %s 获取失败: %s", code, name, exc)
                    responses[name] = SearchResponse(
                        query=f"{stock_name} {name}",
                        results=[],
                        provider="StructuredIntel",
                        success=False,
                        error_message=f"{type(exc).__name__}: upstream request failed",
                    )
        return responses

    def _run_provider(
        self,
        *,
        provider: str,
        operation: str,
        query: str,
        fetcher: Callable[[], List[SearchResult]],
    ) -> SearchResponse:
        started = time.monotonic()
        record_provider_run_started(
            data_type="structured_intel",
            provider=provider,
            operation=operation,
        )
        try:
            results = fetcher()
            elapsed_ms = int((time.monotonic() - started) * 1000)
            record_provider_run(
                data_type="structured_intel",
                provider=provider,
                operation=operation,
                success=bool(results),
                latency_ms=elapsed_ms,
                record_count=len(results),
                error_type=None if results else "NoRecentItems",
                error_message=None if results else "no recent structured intelligence",
            )
            return SearchResponse(
                query=query,
                results=results,
                provider=provider,
                success=True,
                search_time=elapsed_ms / 1000.0,
            )
        except Exception as exc:
            elapsed_ms = int((time.monotonic() - started) * 1000)
            record_provider_run(
                data_type="structured_intel",
                provider=provider,
                operation=operation,
                success=False,
                latency_ms=elapsed_ms,
                record_count=0,
                error_type=type(exc).__name__,
                error_message="upstream request failed",
            )
            logger.warning("[结构化情报] %s 失败: %s", operation, exc)
            return SearchResponse(
                query=query,
                results=[],
                provider=provider,
                success=False,
                error_message=f"{type(exc).__name__}: upstream request failed",
                search_time=elapsed_ms / 1000.0,
            )

    def _fetch_research(self, code: str, days: int, limit: int) -> SearchResponse:
        return self._run_provider(
            provider="EastMoneyResearch",
            operation="research_reports",
            query=f"{code} 机构研报",
            fetcher=lambda: self._research_items(code, days, limit),
        )

    def _research_items(self, code: str, days: int, limit: int) -> List[SearchResult]:
        today = date.today()
        cutoff = today - timedelta(days=days)
        response = requests.post(
            "https://reportapi.eastmoney.com/report/list2",
            json={
                "code": code,
                "industryCode": "*",
                "beginTime": cutoff.isoformat(),
                "endTime": today.isoformat(),
                "pageNo": 1,
                "pageSize": limit,
                "pageNumber": 1,
            },
            headers={**_HEADERS, "Referer": "https://data.eastmoney.com/report/stock.jshtml"},
            timeout=self.timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
        rows = payload.get("data") if isinstance(payload, dict) else []
        results: List[SearchResult] = []
        for item in rows or []:
            published = _date_text(item.get("publishDate"))
            if not _is_recent(published, cutoff):
                continue
            title = _text(item.get("title"))
            if not title:
                continue
            org = _text(item.get("orgSName"))
            rating = _text(item.get("ratingName"))
            author = _text(item.get("researcher"))
            info_code = _text(item.get("infoCode"))
            meta = [value for value in (org, rating, author) if value]
            results.append(
                SearchResult(
                    title=title,
                    snippet="；".join(meta) or "机构研究报告",
                    url=(
                        f"https://data.eastmoney.com/report/info/{info_code}.html"
                        if info_code
                        else f"https://data.eastmoney.com/report/{code}.html"
                    ),
                    source=org or "东方财富研报",
                    published_date=published,
                    relevance_score=95,
                    relevance_category="direct_stock",
                    relevance_reasons=["结构化个股研报", "股票代码直接匹配", "包含明确发布日期"],
                )
            )
        return results[:limit]

    def _fetch_announcements(self, code: str, days: int, limit: int) -> SearchResponse:
        return self._run_provider(
            provider="EastMoneyNotice",
            operation="stock_announcements",
            query=f"{code} 公司公告",
            fetcher=lambda: self._announcement_items(code, days, limit),
        )

    def _announcement_items(self, code: str, days: int, limit: int) -> List[SearchResult]:
        cutoff = date.today() - timedelta(days=days)
        response = requests.get(
            "https://np-anotice-stock.eastmoney.com/api/security/ann",
            params={
                "page_size": str(max(limit * 2, 20)),
                "page_index": "1",
                "ann_type": "SHA,CYB,SZA,BJA,INV",
                "client_source": "web",
                "f_node": "0",
                "stock_list": code,
            },
            headers={**_HEADERS, "Referer": "https://data.eastmoney.com/notices/"},
            timeout=self.timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
        rows = ((payload.get("data") or {}).get("list") or []) if isinstance(payload, dict) else []
        results: List[SearchResult] = []
        for item in rows:
            published = _date_text(item.get("notice_date"))
            if not _is_recent(published, cutoff):
                continue
            title = _text(item.get("title"))
            if not title:
                continue
            columns = item.get("columns") or []
            notice_type = _text(columns[0].get("column_name")) if columns and isinstance(columns[0], dict) else ""
            art_code = _text(item.get("art_code"))
            results.append(
                SearchResult(
                    title=title,
                    snippet=notice_type or "上市公司公告",
                    url=(
                        f"https://data.eastmoney.com/notices/detail/{code}/{art_code}.html"
                        if art_code
                        else f"https://data.eastmoney.com/notices/stock/{code}.html"
                    ),
                    source="东方财富公告",
                    published_date=published,
                    relevance_score=100,
                    relevance_category="direct_stock",
                    relevance_reasons=["上市公司结构化公告", "股票代码直接匹配", "严格时间窗口"],
                )
            )
        return results[:limit]

    def _fetch_interactive(self, code: str, stock_name: str, days: int, limit: int) -> SearchResponse:
        return self._run_provider(
            provider="CninfoIR",
            operation="interactive_answers",
            query=f"{stock_name} {code} 投资者互动",
            fetcher=lambda: self._interactive_items(code, stock_name, days, limit),
        )

    def _interactive_items(self, code: str, stock_name: str, days: int, limit: int) -> List[SearchResult]:
        cutoff = date.today() - timedelta(days=days)
        response = requests.post(
            f"https://irm.cninfo.com.cn/newircs/index/search?_t={int(time.time())}",
            data={
                "pageNo": "1",
                # The endpoint performs full-text search rather than exact-code
                # lookup.  Request a bounded wider page, then enforce exact
                # stockCode matching below so mentions of the company in other
                # issuers' questions cannot contaminate the evidence.
                "pageSize": "200",
                "searchTypes": "11",
                "highLight": "false",
                "keyWord": stock_name or code,
            },
            headers={**_HEADERS, "Referer": "https://irm.cninfo.com.cn/views/interactiveAnswer"},
            timeout=self.timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
        rows = payload.get("results") if isinstance(payload, dict) else []
        results: List[SearchResult] = []
        for item in rows or []:
            published = _date_text(
                item.get("attachedPubDate")
                or item.get("replyDate")
                or item.get("updateDate")
                or item.get("pubDate")
                or item.get("date")
            )
            if not _is_recent(published, cutoff):
                continue
            item_code = _text(item.get("stockCode") or item.get("secCode") or item.get("companyCode"))
            company = _text(
                item.get("companyShortName")
                or item.get("stockName")
                or item.get("companyName")
                or item.get("secName")
            )
            if item_code and code not in item_code:
                continue
            if not item_code and company and stock_name and stock_name not in company and company not in stock_name:
                continue
            question = _text(item.get("mainContent") or item.get("question") or item.get("questionContent"))
            answer = _text(
                item.get("attachedContent")
                or item.get("answer")
                or item.get("answerContent")
                or item.get("replyContent")
            )
            if not question and not answer:
                continue
            results.append(
                SearchResult(
                    title=f"投资者问答：{question[:80]}" if question else "投资者互动回复",
                    snippet=answer[:280] or "公司尚未提供有效回复摘要",
                    url="https://irm.cninfo.com.cn/views/interactiveAnswer",
                    source=company or "巨潮互动易",
                    published_date=published,
                    relevance_score=90,
                    relevance_category="direct_stock",
                    relevance_reasons=["交易所投资者互动平台", "股票代码直接检索", "包含明确回复日期"],
                )
            )
        return results[:limit]

    @staticmethod
    def merge_responses(
        structured: Dict[str, SearchResponse],
        searched: Dict[str, SearchResponse],
    ) -> Dict[str, SearchResponse]:
        """Merge direct evidence first and remove duplicate URLs/titles."""
        merged: Dict[str, SearchResponse] = dict(searched or {})
        for dimension, direct_response in (structured or {}).items():
            existing = merged.get(dimension)
            candidates = list(direct_response.results or [])
            if existing is not None:
                candidates.extend(existing.results or [])
            seen = set()
            items: List[SearchResult] = []
            for item in candidates:
                key = (item.url or "").strip().lower() or item.title.strip().lower()
                if not key or key in seen:
                    continue
                seen.add(key)
                items.append(item)
            providers = [direct_response.provider]
            if existing is not None and existing.provider not in providers:
                providers.append(existing.provider)
            merged[dimension] = SearchResponse(
                query=direct_response.query or (existing.query if existing else dimension),
                results=items[:8],
                provider=" + ".join(filter(None, providers)),
                success=bool(items) or direct_response.success or bool(existing and existing.success),
                error_message=None if items else direct_response.error_message,
                search_time=direct_response.search_time + (existing.search_time if existing else 0.0),
            )
        return merged

    @staticmethod
    def format_for_analysis(responses: Dict[str, SearchResponse], stock_name: str) -> str:
        labels = {
            "announcements": "公司公告",
            "market_analysis": "机构研报",
            "interactive": "投资者互动",
        }
        lines = [f"【{stock_name} A股结构化情报】"]
        for dimension in ("announcements", "market_analysis", "interactive"):
            response = responses.get(dimension)
            if response is None or not response.results:
                continue
            lines.append(f"\n{labels[dimension]}（来源：{response.provider}）:")
            for index, item in enumerate(response.results[:6], 1):
                date_suffix = f" [{item.published_date}]" if item.published_date else ""
                lines.append(f"  {index}. {item.title}{date_suffix}")
                if item.snippet:
                    lines.append(f"     {item.snippet[:240]}")
        return "\n".join(lines) if len(lines) > 1 else ""
