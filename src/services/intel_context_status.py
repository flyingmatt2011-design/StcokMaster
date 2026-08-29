# -*- coding: utf-8 -*-
"""Deterministic intelligence coverage status for analysis context."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, Iterable, Sequence

from src.report_language import normalize_report_language


class IntelCoverageStatus(str, Enum):
    """Coverage states exposed to the LLM without changing its JSON schema."""

    COVERED = "COVERED"
    EMPTY_CONFIRMED = "EMPTY_CONFIRMED"
    PARTIAL = "PARTIAL"
    UNAVAILABLE = "UNAVAILABLE"


@dataclass(frozen=True)
class IntelCoverageSummary:
    status: IntelCoverageStatus
    successful_with_results: int
    successful_empty: int
    failed: int
    unavailable: int
    total_results: int

    @property
    def total_sources(self) -> int:
        return (
            self.successful_with_results
            + self.successful_empty
            + self.failed
            + self.unavailable
        )

    @property
    def degraded_sources(self) -> int:
        return self.failed + self.unavailable

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status.value,
            "total_sources": self.total_sources,
            "successful_with_results": self.successful_with_results,
            "successful_empty": self.successful_empty,
            "failed": self.failed,
            "unavailable": self.unavailable,
            "degraded_sources": self.degraded_sources,
            "total_results": self.total_results,
        }


def summarize_intel_coverage(
    responses: Iterable[Any],
    *,
    unavailable_sources: Sequence[str] = (),
) -> IntelCoverageSummary:
    """Classify successful-empty responses separately from failed sources."""

    successful_with_results = 0
    successful_empty = 0
    failed = 0
    total_results = 0

    for response in responses:
        if response is None or not bool(getattr(response, "success", False)):
            failed += 1
            continue
        result_count = len(getattr(response, "results", None) or [])
        total_results += result_count
        if result_count:
            successful_with_results += 1
        else:
            successful_empty += 1

    unavailable = len(tuple(unavailable_sources))
    successful = successful_with_results + successful_empty
    degraded = failed + unavailable

    if successful_with_results and not degraded:
        status = IntelCoverageStatus.COVERED
    elif successful and degraded:
        status = IntelCoverageStatus.PARTIAL
    elif successful_empty and not degraded:
        status = IntelCoverageStatus.EMPTY_CONFIRMED
    else:
        status = IntelCoverageStatus.UNAVAILABLE

    return IntelCoverageSummary(
        status=status,
        successful_with_results=successful_with_results,
        successful_empty=successful_empty,
        failed=failed,
        unavailable=unavailable,
        total_results=total_results,
    )


def format_intel_coverage_note(
    summary: IntelCoverageSummary,
    *,
    news_window_days: int,
    report_language: str = "zh",
) -> str:
    """Render a localized, explicit instruction for the existing news context."""

    language = normalize_report_language(report_language)
    days = max(1, int(news_window_days or 1))
    total = summary.total_sources
    degraded = summary.degraded_sources
    successful = summary.successful_with_results + summary.successful_empty
    status = summary.status.value

    if language == "en":
        heading = "[News/sentiment coverage status]"
        if summary.status == IntelCoverageStatus.COVERED:
            return (
                f"{heading} {status}: {successful}/{total} search dimensions returned "
                f"successfully, with {summary.total_results} admitted items."
            )
        if summary.status == IntelCoverageStatus.EMPTY_CONFIRMED:
            return (
                f"{heading} {status}: all {total} search dimensions returned normally; "
                f"no relevant announcement, research item, or news was found in the main "
                f"{days}-day window."
            )
        if summary.status == IntelCoverageStatus.PARTIAL:
            return (
                f"{heading} {status}: {degraded}/{total} search dimensions failed or were "
                "unavailable. The latest sentiment is only partially covered. Record this "
                "in data_limitations/confidence_reason, reduce news-related confidence, and "
                "do not interpret missing news as absence of downside risk."
            )
        return (
            f"{heading} {status}: {degraded}/{total or degraded} search dimensions failed "
            "or were unavailable. The latest sentiment was not covered. Record this in "
            "data_limitations/confidence_reason, reduce news-related confidence, and do not "
            "interpret missing news as absence of downside risk."
        )

    if language == "ko":
        heading = "[뉴스/시장심리 커버리지 상태]"
        if summary.status == IntelCoverageStatus.COVERED:
            return (
                f"{heading} {status}: {successful}/{total}개 검색 차원이 정상 반환되었고 "
                f"유효 정보 {summary.total_results}건을 확보했습니다."
            )
        if summary.status == IntelCoverageStatus.EMPTY_CONFIRMED:
            return (
                f"{heading} {status}: {total}개 검색 차원이 모두 정상 반환되었으나, "
                f"주요 최근 {days}일 범위에서 관련 공시·리서치·뉴스를 찾지 못했습니다."
            )
        if summary.status == IntelCoverageStatus.PARTIAL:
            return (
                f"{heading} {status}: {total}개 중 {degraded}개 검색 차원이 실패하거나 "
                "사용 불가하여 최신 시장심리를 일부만 확인했습니다. 이 제한을 "
                "data_limitations/confidence_reason에 기록하고, 뉴스 관련 신뢰도를 낮추며, "
                "뉴스 부재를 하락 위험 부재로 해석하지 마세요."
            )
        return (
            f"{heading} {status}: {total or degraded}개 중 {degraded}개 검색 차원이 실패하거나 "
            "사용 불가하여 최신 시장심리를 확인하지 못했습니다. 이 제한을 "
            "data_limitations/confidence_reason에 기록하고, 뉴스 관련 신뢰도를 낮추며, "
            "뉴스 부재를 하락 위험 부재로 해석하지 마세요."
        )

    heading = "【新闻/舆情覆盖状态】"
    if summary.status == IntelCoverageStatus.COVERED:
        return (
            f"{heading}{status}：{successful}/{total} 个检索维度正常返回，"
            f"共取得 {summary.total_results} 条有效资讯。"
        )
    if summary.status == IntelCoverageStatus.EMPTY_CONFIRMED:
        return (
            f"{heading}{status}：{total} 个检索维度均正常返回，"
            f"主要新闻窗口（近 {days} 天）内未发现相关公告、研报或新闻。"
        )
    if summary.status == IntelCoverageStatus.PARTIAL:
        return (
            f"{heading}{status}：{total} 个检索维度中有 {degraded} 个失败或不可用，"
            "本次仅部分覆盖最新舆情。必须在 data_limitations / confidence_reason 中记录，"
            "下调消息面判断置信度，勿将“无新闻”视为“无利空”。"
        )
    return (
        f"{heading}{status}：{total or degraded} 个检索维度中有 {degraded} 个失败或不可用，"
        "本次结论未覆盖最新舆情。必须在 data_limitations / confidence_reason 中记录，"
        "下调消息面判断置信度，勿将“无新闻”视为“无利空”。"
    )
