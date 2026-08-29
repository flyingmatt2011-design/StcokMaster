# -*- coding: utf-8 -*-
"""BaoStock financial fallback using the existing fundamental field contract."""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .provider_daily_cache import read_session_cache, write_session_cache


logger = logging.getLogger(__name__)


def _number(value: Any, *, percent_ratio: bool = False) -> Optional[float]:
    if value is None or str(value).strip() in {"", "-", "--", "nan", "None"}:
        return None
    try:
        parsed = float(str(value).replace(",", "").replace("%", ""))
    except (TypeError, ValueError):
        return None
    return round(parsed * 100.0, 6) if percent_ratio else parsed


def _result_rows(result: Any) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    if result is None:
        return [], "empty_result"
    if str(getattr(result, "error_code", "")) != "0":
        return [], str(getattr(result, "error_msg", "baostock_error") or "baostock_error")
    fields = list(getattr(result, "fields", []) or [])
    rows: List[Dict[str, Any]] = []
    try:
        while result.next():
            values = result.get_row_data()
            rows.append(dict(zip(fields, values)))
    except Exception as exc:
        return rows, f"result_parse:{type(exc).__name__}"
    return rows, None


def _completed_quarters(today: Optional[date] = None, count: int = 5) -> List[Tuple[int, int]]:
    current = today or date.today()
    index = current.year * 4 + ((current.month - 1) // 3) - 1
    result: List[Tuple[int, int]] = []
    for offset in range(max(1, count)):
        value = index - offset
        result.append((value // 4, value % 4 + 1))
    return result


def _latest_by(rows: Iterable[Dict[str, Any]], *date_fields: str) -> Dict[str, Any]:
    candidates = [row for row in rows if isinstance(row, dict)]
    if not candidates:
        return {}
    return max(
        candidates,
        key=lambda row: max((str(row.get(field) or "") for field in date_fields), default=""),
    )


class BaostockFundamentalAdapter:
    """Fetch quarterly financial/earnings data without a token."""

    def _stock_code(self, stock_code: str) -> str:
        code = str(stock_code).strip().split(".", 1)[0].zfill(6)
        market = "sh" if code.startswith(("5", "6", "9")) else "sz"
        return f"{market}.{code}"

    def get_fundamental_bundle(self, stock_code: str) -> Dict[str, Any]:
        cache_key = str(stock_code).strip().split(".", 1)[0].zfill(6)
        cached = read_session_cache("baostock_fundamental", cache_key)
        if cached:
            cached = dict(cached)
            cached["source_chain"] = list(cached.get("source_chain", [])) + ["fundamental:baostock_cache"]
            return cached

        result: Dict[str, Any] = {
            "status": "not_supported",
            "growth": {},
            "earnings": {},
            "institution": {},
            "source_chain": [],
            "errors": [],
            "queried": [],
        }
        try:
            import baostock as bs
        except Exception as exc:
            result["errors"].append(f"import_baostock:{type(exc).__name__}")
            return result

        login_result = None
        try:
            login_result = bs.login()
            if str(getattr(login_result, "error_code", "")) != "0":
                result["errors"].append(
                    f"baostock_login:{getattr(login_result, 'error_msg', 'failed')}"
                )
                return result

            code = self._stock_code(stock_code)
            report_rows: Dict[str, Dict[str, Any]] = {}
            selected_period: Optional[Tuple[int, int]] = None
            query_names = (
                "profit",
                "growth",
                "operation",
                "balance",
                "cash_flow",
                "dupont",
            )
            for year, quarter in _completed_quarters():
                period_rows: Dict[str, Dict[str, Any]] = {}
                for name in query_names:
                    query = getattr(bs, f"query_{name}_data")
                    rows, error = _result_rows(query(code=code, year=year, quarter=quarter))
                    if error:
                        result["errors"].append(f"baostock_{name}:{error}")
                    if rows:
                        period_rows[name] = rows[0]
                if period_rows:
                    report_rows = period_rows
                    selected_period = (year, quarter)
                    break

            profit = report_rows.get("profit", {})
            growth = report_rows.get("growth", {})
            cash_flow = report_rows.get("cash_flow", {})
            if profit or growth:
                result["growth"] = {
                    "net_profit_yoy": _number(growth.get("YOYPNI") or growth.get("YOYNI"), percent_ratio=True),
                    "roe": _number(profit.get("roeAvg"), percent_ratio=True),
                    "gross_margin": _number(profit.get("gpMargin"), percent_ratio=True),
                    "equity_yoy": _number(growth.get("YOYEquity"), percent_ratio=True),
                    "asset_yoy": _number(growth.get("YOYAsset"), percent_ratio=True),
                    "eps_yoy": _number(growth.get("YOYEPSBasic"), percent_ratio=True),
                }
                result["growth"] = {key: value for key, value in result["growth"].items() if value is not None}

            financial_report = {
                "report_date": profit.get("statDate") or growth.get("statDate"),
                "publication_date": profit.get("pubDate") or growth.get("pubDate"),
                "revenue": _number(profit.get("MBRevenue")),
                "net_profit_parent": _number(profit.get("netProfit")),
                "operating_cash_flow": None,
                "operating_cash_flow_to_revenue_pct": _number(cash_flow.get("CFOToOR"), percent_ratio=True),
                "operating_cash_flow_to_net_profit_pct": _number(cash_flow.get("CFOToNP"), percent_ratio=True),
                "roe": _number(profit.get("roeAvg"), percent_ratio=True),
            }
            financial_report = {key: value for key, value in financial_report.items() if value is not None}
            if financial_report:
                result["earnings"]["financial_report"] = financial_report

            start_date = (date.today() - timedelta(days=550)).isoformat()
            end_date = date.today().isoformat()
            forecast_rows, forecast_error = _result_rows(
                bs.query_forecast_report(code=code, start_date=start_date, end_date=end_date)
            )
            if forecast_error:
                result["errors"].append(f"baostock_forecast:{forecast_error}")
            forecast = _latest_by(
                forecast_rows,
                "profitForcastExpPubDate",
                "profitForcastExpStatDate",
            )
            if forecast:
                change_low = _number(forecast.get("profitForcastChgPctDwn"))
                change_high = _number(forecast.get("profitForcastChgPctUp"))
                result["earnings"]["forecast"] = {
                    "publication_date": forecast.get("profitForcastExpPubDate"),
                    "report_date": forecast.get("profitForcastExpStatDate"),
                    "change_pct_low": change_low,
                    "change_pct_high": change_high,
                }
                if change_low is not None or change_high is not None:
                    low_text = f"{change_low:.2f}%" if change_low is not None else "未知"
                    high_text = f"{change_high:.2f}%" if change_high is not None else "未知"
                    result["earnings"]["forecast_summary"] = f"业绩预告同比变动区间：{low_text} 至 {high_text}"

            quick_rows, quick_error = _result_rows(
                bs.query_performance_express_report(code=code, start_date=start_date, end_date=end_date)
            )
            if quick_error:
                result["errors"].append(f"baostock_quick:{quick_error}")
            quick = _latest_by(
                quick_rows,
                "performanceExpUpdateDate",
                "performanceExpPubDate",
                "performanceExpStatDate",
            )
            if quick:
                net_profit_yoy = _number(quick.get("performanceExpressOPYOY"))
                result["earnings"]["quick_report"] = {
                    "publication_date": quick.get("performanceExpPubDate"),
                    "report_date": quick.get("performanceExpStatDate"),
                    "net_profit_yoy": net_profit_yoy,
                    "roe": _number(quick.get("performanceExpressROEWa")),
                }
                if net_profit_yoy is not None:
                    result["earnings"]["quick_report_summary"] = f"业绩快报净利润同比：{net_profit_yoy:.2f}%"

            if selected_period:
                result["queried"].append("financial")
                result["source_chain"].append(
                    f"fundamental:baostock:{selected_period[0]}Q{selected_period[1]}"
                )
            result["queried"].extend(["forecast", "quick"])
            if forecast:
                result["source_chain"].append("earnings_forecast:baostock")
            if quick:
                result["source_chain"].append("earnings_quick:baostock")

            dividend_rows: List[Dict[str, Any]] = []
            for dividend_year in (date.today().year, date.today().year - 1):
                rows, dividend_error = _result_rows(
                    bs.query_dividend_data(code=code, year=dividend_year, yearType="operate")
                )
                if dividend_error:
                    result["errors"].append(f"baostock_dividend:{dividend_error}")
                dividend_rows.extend(rows)
            result["queried"].append("dividend")
            dividend_events: List[Dict[str, Any]] = []
            ttm_start = date.today() - timedelta(days=365)
            for row in dividend_rows:
                event_date = str(row.get("dividOperateDate") or row.get("dividPayDate") or "")
                per_share = _number(row.get("dividCashPsBeforeTax"))
                if not event_date or per_share is None or per_share <= 0:
                    continue
                try:
                    parsed_date = date.fromisoformat(event_date)
                except ValueError:
                    continue
                if parsed_date > date.today():
                    continue
                dividend_events.append(
                    {
                        "event_date": event_date,
                        "ex_dividend_date": event_date,
                        "record_date": row.get("dividRegistDate") or None,
                        "announcement_date": row.get("dividPlanAnnounceDate") or None,
                        "cash_dividend_per_share": per_share,
                        "is_pre_tax": True,
                    }
                )
            if dividend_events:
                dividend_events.sort(key=lambda item: item["event_date"], reverse=True)
                ttm_events = [
                    item for item in dividend_events
                    if ttm_start <= date.fromisoformat(item["event_date"]) <= date.today()
                ]
                result["earnings"]["dividend"] = {
                    "events": dividend_events[:5],
                    "ttm_event_count": len(ttm_events),
                    "ttm_cash_dividend_per_share": (
                        round(sum(float(item["cash_dividend_per_share"]) for item in ttm_events), 6)
                        if ttm_events else None
                    ),
                    "coverage": "cash_dividend_pre_tax",
                    "as_of": date.today().isoformat(),
                }
                result["source_chain"].append("dividend:baostock")
        except Exception as exc:
            logger.debug("BaoStock fundamental fallback failed for %s: %s", stock_code, exc)
            result["errors"].append(f"baostock:{type(exc).__name__}")
        finally:
            if login_result is not None:
                try:
                    bs.logout()
                except Exception:
                    pass

        has_content = bool(result["growth"] or result["earnings"])
        result["status"] = "partial" if has_content else "not_supported"
        if has_content:
            write_session_cache("baostock_fundamental", cache_key, result)
        return result
