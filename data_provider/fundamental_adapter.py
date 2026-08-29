# -*- coding: utf-8 -*-
"""
AkShare fundamental adapter (fail-open).

This adapter intentionally uses capability probing against multiple AkShare
endpoint candidates. It should never raise to caller; partial data is allowed.
"""

from __future__ import annotations

import logging
import re
import time
from datetime import date, datetime, timedelta
from threading import RLock
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

from .provider_daily_cache import read_session_cache, write_session_cache

logger = logging.getLogger(__name__)

_DIVIDEND_KEYWORD_MAP: Dict[str, List[str]] = {
    "per_share": [
        "每股派息",
        "每股现金红利",
        "每股分红",
        "每股派现",
        "派现(元/股)",
        "派息(元/股)",
        "税前派息(元/股)",
        "现金分红(税前)",
    ],
    "plan_text": [
        "分配方案",
        "分红方案",
        "实施方案",
        "派息方案",
        "方案",
        "预案",
        "方案说明",
    ],
    "ex_dividend_date": ["除权除息日", "除息日", "除权日", "除权除息", "除息日期"],
    "record_date": ["股权登记日", "登记日"],
    "announce_date": ["公告日期", "公告日", "实施公告日", "预案公告日"],
    "report_date": ["报告期", "报告日期", "截止日期", "统计截止日期"],
}


def _safe_float(value: Any) -> Optional[float]:
    """Best-effort float conversion."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
    s = str(value).strip().replace(",", "").replace("%", "")
    if not s:
        return None
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _safe_amount_float(value: Any) -> Optional[float]:
    """Parse common Chinese amount units into yuan without changing sign."""
    if value is None:
        return None
    text = str(value).strip().replace(",", "")
    if not text or text in {"-", "--", "nan", "None"}:
        return None
    multiplier = 1.0
    if text.endswith("亿"):
        multiplier = 100_000_000.0
        text = text[:-1]
    elif text.endswith("万"):
        multiplier = 10_000.0
        text = text[:-1]
    parsed = _safe_float(text)
    return round(parsed * multiplier, 4) if parsed is not None else None


def _safe_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _safe_datetime(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    try:
        parsed = pd.to_datetime(value)
    except Exception:
        return None
    if pd.isna(parsed):
        return None
    try:
        return parsed.to_pydatetime()
    except Exception:
        return None


def _normalize_code(raw: Any) -> str:
    s = _safe_str(raw).upper()
    if "." in s:
        s = s.split(".", 1)[0]
    s = re.sub(r"^(SH|SZ|BJ)", "", s)
    return s


def _pick_by_keywords(row: pd.Series, keywords: List[str]) -> Optional[Any]:
    """
    Return first non-empty row value whose column name contains any keyword.
    """
    for col in row.index:
        col_s = str(col)
        if any(k in col_s for k in keywords):
            val = row.get(col)
            if val is not None and str(val).strip() not in ("", "-", "nan", "None"):
                return val
    return None


def _parse_dividend_plan_to_per_share(plan_text: str) -> Optional[float]:
    """Parse per-share cash dividend from Chinese plan text."""
    text = _safe_str(plan_text)
    if not text:
        return None

    for pattern in (
        r"(?:每)?\s*10\s*股?\s*派(?:发)?\s*([0-9]+(?:\.[0-9]+)?)\s*元",
        r"10\s*派\s*([0-9]+(?:\.[0-9]+)?)\s*元",
    ):
        match = re.search(pattern, text)
        if match:
            parsed = _safe_float(match.group(1))
            if parsed is not None and parsed > 0:
                return parsed / 10.0

    match_per_share = re.search(r"每\s*股\s*派(?:发)?\s*([0-9]+(?:\.[0-9]+)?)\s*元", text)
    if match_per_share:
        parsed = _safe_float(match_per_share.group(1))
        if parsed is not None and parsed > 0:
            return parsed
    return None


def _extract_cash_dividend_per_share(row: pd.Series) -> Optional[float]:
    """Extract pre-tax cash dividend per share from a row."""
    plan_text = _safe_str(_pick_by_keywords(row, _DIVIDEND_KEYWORD_MAP["plan_text"]))
    # Keep pre-tax semantics; skip explicit after-tax plans unless pre-tax marker exists.
    if "税后" in plan_text and "税前" not in plan_text and "含税" not in plan_text:
        return None

    direct = _safe_float(_pick_by_keywords(row, _DIVIDEND_KEYWORD_MAP["per_share"]))
    if direct is not None and direct > 0:
        return direct
    return _parse_dividend_plan_to_per_share(plan_text)


def _filter_rows_by_code(df: pd.DataFrame, stock_code: str) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame()
    code_cols = [c for c in df.columns if any(k in str(c) for k in ("代码", "股票代码", "证券代码", "symbol", "ts_code"))]
    if not code_cols:
        return df

    target = _normalize_code(stock_code)
    for col in code_cols:
        try:
            series = df[col].astype(str).map(_normalize_code)
            filtered = df[series == target]
            if not filtered.empty:
                return filtered
        except Exception:
            continue
    return pd.DataFrame()


def _normalize_report_date(value: Any) -> Optional[str]:
    parsed = _safe_datetime(value)
    return parsed.date().isoformat() if parsed else None


def _build_dividend_payload(
    dividend_df: pd.DataFrame,
    stock_code: str,
    max_events: int = 5,
) -> Dict[str, Any]:
    work_df = _filter_rows_by_code(dividend_df, stock_code)
    if work_df.empty:
        return {}

    now_date = datetime.now().date()
    ttm_start_date = now_date - timedelta(days=365)
    dedupe_keys = set()
    events: List[Dict[str, Any]] = []

    for _, row in work_df.iterrows():
        if not isinstance(row, pd.Series):
            continue
        ex_dt = _safe_datetime(_pick_by_keywords(row, _DIVIDEND_KEYWORD_MAP["ex_dividend_date"]))
        record_dt = _safe_datetime(_pick_by_keywords(row, _DIVIDEND_KEYWORD_MAP["record_date"]))
        announce_dt = _safe_datetime(_pick_by_keywords(row, _DIVIDEND_KEYWORD_MAP["announce_date"]))
        event_dt = ex_dt or record_dt or announce_dt
        if event_dt is None:
            continue
        event_date = event_dt.date()
        if event_date > now_date:
            continue

        per_share = _extract_cash_dividend_per_share(row)
        if per_share is None or per_share <= 0:
            continue

        dedupe_key = (event_date.isoformat(), round(per_share, 6))
        if dedupe_key in dedupe_keys:
            continue
        dedupe_keys.add(dedupe_key)

        events.append(
            {
                "event_date": event_date.isoformat(),
                "ex_dividend_date": ex_dt.date().isoformat() if ex_dt else None,
                "record_date": record_dt.date().isoformat() if record_dt else None,
                "announcement_date": announce_dt.date().isoformat() if announce_dt else None,
                "cash_dividend_per_share": round(per_share, 6),
                "is_pre_tax": True,
            }
        )

    if not events:
        return {}

    events.sort(key=lambda item: item.get("event_date") or "", reverse=True)
    ttm_events: List[Dict[str, Any]] = []
    for item in events:
        event_dt = _safe_datetime(item.get("event_date"))
        if event_dt is None:
            continue
        event_date = event_dt.date()
        if ttm_start_date <= event_date <= now_date:
            ttm_events.append(item)

    return {
        "events": events[:max(1, max_events)],
        "ttm_event_count": len(ttm_events),
        "ttm_cash_dividend_per_share": (
            round(sum(float(item.get("cash_dividend_per_share") or 0.0) for item in ttm_events), 6)
            if ttm_events else None
        ),
        "coverage": "cash_dividend_pre_tax",
        "as_of": now_date.isoformat(),
    }


def _extract_latest_row(df: pd.DataFrame, stock_code: str) -> Optional[pd.Series]:
    """
    Select the most relevant row for the given stock.
    """
    if df is None or df.empty:
        return None

    code_cols = [c for c in df.columns if any(k in str(c) for k in ("代码", "股票代码", "证券代码", "ts_code", "symbol"))]
    target = _normalize_code(stock_code)
    if code_cols:
        for col in code_cols:
            try:
                series = df[col].astype(str).map(_normalize_code)
                matched = df[series == target]
                if not matched.empty:
                    return matched.iloc[0]
            except Exception:
                continue
        return None

    # When a single-stock endpoint omits the code column, prefer the newest
    # disclosure/report row instead of assuming provider order.
    date_cols = [
        col for col in df.columns
        if any(keyword in str(col) for keyword in ("日期", "报告期", "截止日", "公告日", "统计时间"))
    ]
    for col in date_cols:
        try:
            parsed = pd.to_datetime(df[col], errors="coerce")
            if parsed.notna().any():
                return df.loc[parsed.idxmax()]
        except Exception:
            continue

    # Fallback when the payload has neither code nor date metadata.
    return df.iloc[0]


def _recent_completed_quarter_tokens(count: int = 5) -> List[Tuple[str, str]]:
    """Return (Bao/AkShare quarter token, quarter-end date) newest first."""
    current = date.today()
    index = current.year * 4 + ((current.month - 1) // 3) - 1
    tokens: List[Tuple[str, str]] = []
    quarter_ends = {1: "0331", 2: "0630", 3: "0930", 4: "1231"}
    for offset in range(max(1, count)):
        value = index - offset
        year, quarter = value // 4, value % 4 + 1
        tokens.append((f"{year}{quarter}", f"{year}{quarter_ends[quarter]}"))
    return tokens


def _exchange_symbol(stock_code: str) -> str:
    code = _normalize_code(stock_code).zfill(6)
    prefix = "sh" if code.startswith(("5", "6", "9")) else "bj" if code.startswith(("4", "8")) else "sz"
    return f"{prefix}{code}"


def _merge_meaningful(target: Dict[str, Any], incoming: Dict[str, Any]) -> Dict[str, Any]:
    """Merge provider payloads without replacing usable values with blanks."""
    for key, value in incoming.items():
        if isinstance(value, dict):
            current = target.get(key)
            if not isinstance(current, dict):
                current = {}
            target[key] = _merge_meaningful(dict(current), value)
        elif value is not None and str(value).strip() not in {"", "nan", "None"}:
            target[key] = value
    return target


def _iso_report_date(value: Any) -> Optional[date]:
    """Parse a normalized report-period date without raising."""
    text = _safe_str(value)
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def _financial_reference_period(earnings: Dict[str, Any]) -> Optional[date]:
    """Return the newest period disclosed by forecast/quick-report evidence."""
    candidates: List[date] = []
    for key in ("forecast", "quick_report"):
        payload = earnings.get(key)
        if not isinstance(payload, dict):
            continue
        parsed = _iso_report_date(payload.get("report_date"))
        if parsed is not None:
            candidates.append(parsed)
    return max(candidates) if candidates else None


def _attach_financial_freshness(earnings: Dict[str, Any]) -> None:
    """Expose when structured statements lag a newer disclosed period."""
    financial_report = earnings.get("financial_report")
    if not isinstance(financial_report, dict):
        return
    financial_period = _iso_report_date(financial_report.get("report_date"))
    reference_period = _financial_reference_period(earnings)
    if financial_period is None or reference_period is None:
        return
    earnings["data_freshness"] = {
        "status": (
            "lagging_reference_period"
            if financial_period < reference_period
            else "current_to_reference_period"
        ),
        "financial_report_date": financial_period.isoformat(),
        "latest_reference_period": reference_period.isoformat(),
    }


class AkshareFundamentalAdapter:
    """AkShare adapter for fundamentals, capital flow and dragon-tiger signals."""

    _individual_flow_rank_cache_lock = RLock()
    _individual_flow_rank_cache: Optional[pd.DataFrame] = None
    _individual_flow_rank_cache_at = 0.0
    _INDIVIDUAL_FLOW_RANK_CACHE_TTL_SECONDS = 300.0

    def __init__(self, baostock_adapter: Optional[Any] = None, *, enable_disk_cache: bool = False):
        self._baostock_adapter = baostock_adapter
        self._enable_disk_cache = bool(enable_disk_cache)

    @classmethod
    def _get_individual_flow_rank_fallback(cls) -> Optional[pd.DataFrame]:
        """Load the free THS all-stock flow ranking once and share it per batch."""
        with cls._individual_flow_rank_cache_lock:
            now = time.monotonic()
            if (
                isinstance(cls._individual_flow_rank_cache, pd.DataFrame)
                and not cls._individual_flow_rank_cache.empty
                and now - cls._individual_flow_rank_cache_at
                <= cls._INDIVIDUAL_FLOW_RANK_CACHE_TTL_SECONDS
            ):
                return cls._individual_flow_rank_cache

            cached = read_session_cache("akshare_capital_flow", "ths_individual_rank")
            cached_records = cached.get("records") if isinstance(cached, dict) else None
            if isinstance(cached_records, list) and cached_records:
                frame = pd.DataFrame(cached_records)
                if not frame.empty:
                    cls._individual_flow_rank_cache = frame
                    cls._individual_flow_rank_cache_at = time.monotonic()
                    return frame

            try:
                import akshare as ak

                frame = ak.stock_fund_flow_individual(symbol="即时")
            except Exception as exc:
                logger.debug("THS individual capital-flow fallback failed: %s", exc)
                return None
            if not isinstance(frame, pd.DataFrame) or frame.empty:
                return None
            cls._individual_flow_rank_cache = frame
            cls._individual_flow_rank_cache_at = time.monotonic()
            write_session_cache(
                "akshare_capital_flow",
                "ths_individual_rank",
                {"records": frame.to_dict(orient="records")},
            )
            return frame

    def _call_df_candidates(
        self,
        candidates: List[Tuple[str, Dict[str, Any]]],
    ) -> Tuple[Optional[pd.DataFrame], Optional[str], List[str]]:
        errors: List[str] = []
        try:
            import akshare as ak
        except Exception as exc:
            return None, None, [f"import_akshare:{type(exc).__name__}"]

        for func_name, kwargs in candidates:
            fn = getattr(ak, func_name, None)
            if fn is None:
                continue
            try:
                df = fn(**kwargs)
                if isinstance(df, pd.Series):
                    df = df.to_frame().T
                if isinstance(df, pd.DataFrame) and not df.empty:
                    return df, func_name, errors
            except Exception as exc:
                errors.append(f"{func_name}:{type(exc).__name__}")
                continue
        return None, None, errors

    def get_fundamental_bundle(self, stock_code: str) -> Dict[str, Any]:
        """
        Return normalized fundamental blocks from AkShare with partial tolerance.
        """
        result: Dict[str, Any] = {
            "status": "not_supported",
            "growth": {},
            "earnings": {},
            "institution": {},
            "source_chain": [],
            "errors": [],
        }

        # BaoStock is a fast, token-free source for quarterly statements.  It
        # seeds the existing contract; AkShare remains the preferred source
        # for any newer or richer values collected below.
        if self._baostock_adapter is not None:
            try:
                baostock_bundle = self._baostock_adapter.get_fundamental_bundle(stock_code)
            except Exception as exc:
                baostock_bundle = {"errors": [f"baostock:{type(exc).__name__}"]}
            if isinstance(baostock_bundle, dict):
                baostock_queried = set(baostock_bundle.get("queried") or [])
                result["growth"] = dict(baostock_bundle.get("growth") or {})
                result["earnings"] = dict(baostock_bundle.get("earnings") or {})
                result["source_chain"].extend(baostock_bundle.get("source_chain") or [])
                result["errors"].extend(baostock_bundle.get("errors") or [])
            else:
                baostock_queried = set()
        else:
            baostock_queried = set()

        # Financial indicators
        financial_report_seed = result["earnings"].get("financial_report")
        seed_report_period = (
            _iso_report_date(financial_report_seed.get("report_date"))
            if isinstance(financial_report_seed, dict)
            else None
        )
        reference_period = _financial_reference_period(result["earnings"])
        needs_financial = (
            not result["growth"]
            or not isinstance(financial_report_seed, dict)
            or (
                seed_report_period is not None
                and reference_period is not None
                and seed_report_period < reference_period
            )
        )
        if needs_financial:
            fin_df, fin_source, fin_errors = self._call_df_candidates([
                ("stock_financial_abstract", {"symbol": stock_code}),
                ("stock_financial_analysis_indicator", {"symbol": stock_code}),
                ("stock_financial_analysis_indicator", {}),
            ])
        else:
            fin_df, fin_source, fin_errors = None, None, []
        result["errors"].extend(fin_errors)
        if fin_df is not None:
            row = _extract_latest_row(fin_df, stock_code)
            if row is not None:
                revenue_yoy = _safe_float(_pick_by_keywords(row, ["营业收入同比", "营收同比", "收入同比", "同比增长"]))
                profit_yoy = _safe_float(_pick_by_keywords(row, ["净利润同比", "净利同比", "归母净利润同比"]))
                roe = _safe_float(_pick_by_keywords(row, ["净资产收益率", "ROE", "净资产收益"]))
                gross_margin = _safe_float(_pick_by_keywords(row, ["毛利率"]))
                report_date = _normalize_report_date(_pick_by_keywords(row, _DIVIDEND_KEYWORD_MAP["report_date"]))
                revenue = _safe_float(_pick_by_keywords(row, ["营业总收入", "营业收入", "营收"]))
                net_profit_parent = _safe_float(_pick_by_keywords(row, ["归母净利润", "母公司股东净利润", "净利润"]))
                operating_cash_flow = _safe_float(
                    _pick_by_keywords(row, ["经营活动产生的现金流量净额", "经营现金流", "经营活动现金流"])
                )
                result["growth"] = _merge_meaningful(result["growth"], {
                    "revenue_yoy": revenue_yoy,
                    "net_profit_yoy": profit_yoy,
                    "roe": roe,
                    "gross_margin": gross_margin,
                })
                financial_report_payload = {
                    "report_date": report_date,
                    "revenue": revenue,
                    "net_profit_parent": net_profit_parent,
                    "operating_cash_flow": operating_cash_flow,
                    "roe": roe,
                }
                if any(v is not None for v in financial_report_payload.values()):
                    result["earnings"]["financial_report"] = _merge_meaningful(
                        dict(result["earnings"].get("financial_report") or {}),
                        financial_report_payload,
                    )
                result["source_chain"].append(f"growth:{fin_source}")

        # Earnings forecast
        if "forecast" in baostock_queried or result["earnings"].get("forecast_summary"):
            forecast_df, forecast_source, forecast_errors = None, None, []
        else:
            forecast_df, forecast_source, forecast_errors = self._call_df_candidates([
                ("stock_yjyg_em", {"symbol": stock_code}),
                ("stock_yjyg_em", {}),
                ("stock_yjbb_em", {"symbol": stock_code}),
                ("stock_yjbb_em", {}),
            ])
        result["errors"].extend(forecast_errors)
        if forecast_df is not None:
            row = _extract_latest_row(forecast_df, stock_code)
            if row is not None:
                result["earnings"]["forecast_summary"] = _safe_str(
                    _pick_by_keywords(row, ["预告", "业绩变动", "内容", "摘要", "公告"])
                )[:200]
                result["source_chain"].append(f"earnings_forecast:{forecast_source}")

        # Earnings quick report
        if "quick" in baostock_queried or result["earnings"].get("quick_report_summary"):
            quick_df, quick_source, quick_errors = None, None, []
        else:
            quick_df, quick_source, quick_errors = self._call_df_candidates([
                ("stock_yjkb_em", {"symbol": stock_code}),
                ("stock_yjkb_em", {}),
            ])
        result["errors"].extend(quick_errors)
        if quick_df is not None:
            row = _extract_latest_row(quick_df, stock_code)
            if row is not None:
                result["earnings"]["quick_report_summary"] = _safe_str(
                    _pick_by_keywords(row, ["快报", "摘要", "公告", "说明"])
                )[:200]
                result["source_chain"].append(f"earnings_quick:{quick_source}")

        # Dividend details (cash dividend, pre-tax)
        if "dividend" in baostock_queried or result["earnings"].get("dividend"):
            dividend_df, dividend_source, dividend_errors = None, None, []
        else:
            dividend_df, dividend_source, dividend_errors = self._call_df_candidates([
                ("stock_fhps_detail_em", {"symbol": stock_code}),
                ("stock_history_dividend_detail", {"symbol": stock_code, "indicator": "分红", "date": ""}),
                ("stock_dividend_cninfo", {"symbol": stock_code}),
            ])
        result["errors"].extend(dividend_errors)
        if dividend_df is not None:
            dividend_payload = _build_dividend_payload(dividend_df, stock_code, max_events=5)
            if dividend_payload:
                result["earnings"]["dividend"] = dividend_payload
                result["source_chain"].append(f"dividend:{dividend_source}")

        # Institution / top shareholders.  These endpoints require explicit
        # report periods; parameterless calls silently returned irrelevant
        # default-period rows in earlier builds.
        institution_cache_key = _normalize_code(stock_code).zfill(6)
        institution_cached = (
            read_session_cache("akshare_institution", institution_cache_key)
            if self._enable_disk_cache else None
        )
        cached_institution = (
            institution_cached.get("institution") if isinstance(institution_cached, dict) else None
        )
        if not isinstance(cached_institution, dict) or not cached_institution.get("institution_count"):
            institution_cached = None
        if institution_cached:
            result["institution"] = dict(institution_cached.get("institution") or {})
            result["source_chain"].extend(institution_cached.get("source_chain") or [])
            inst_df = top10_df = None
            inst_source = top10_source = None
            inst_errors = top10_errors = []
        else:
            quarter_tokens = _recent_completed_quarter_tokens(count=3)
            inst_df, inst_source, inst_errors = self._call_df_candidates([
                ("stock_institute_hold_detail", {"stock": institution_cache_key, "quarter": quarter})
                for quarter, _ in quarter_tokens
            ])
        result["errors"].extend(inst_errors)
        if inst_df is not None and not inst_df.empty:
            # stock_institute_hold_detail contains institution codes, not the
            # analyzed stock code.  Do not feed it through the stock-code row
            # matcher or every valid result is discarded.
            change_col = next((col for col in inst_df.columns if "持股比例增幅" in str(col)), None)
            changes = pd.to_numeric(inst_df[change_col], errors="coerce") if change_col else pd.Series(dtype=float)
            result["institution"]["institution_holding_change"] = (
                round(float(changes.dropna().sum()), 6) if not changes.dropna().empty else None
            )
            result["institution"]["institution_count"] = int(len(inst_df))
            result["source_chain"].append(f"institution:{inst_source}")

        if not institution_cached:
            top10_df, top10_source, top10_errors = self._call_df_candidates([
                ("stock_gdfx_free_top_10_em", {"symbol": _exchange_symbol(stock_code), "date": report_date})
                for _, report_date in quarter_tokens
            ] + [
                ("stock_zh_a_gdhs_detail_em", {"symbol": institution_cache_key}),
            ])
        result["errors"].extend(top10_errors)
        if top10_df is not None:
            row = _extract_latest_row(top10_df, stock_code)
            if row is not None:
                if str(top10_source).startswith("stock_gdfx_"):
                    change_col = next((col for col in top10_df.columns if "变动比率" in str(col)), None)
                    changes = (
                        pd.to_numeric(top10_df[change_col], errors="coerce").dropna()
                        if change_col else pd.Series(dtype=float)
                    )
                    holder_change = round(float(changes.sum()), 6) if not changes.empty else None
                else:
                    holder_change = _safe_float(
                        _pick_by_keywords(row, ["增减比例", "持股变化", "股东户数-增减比例"])
                    )
                result["institution"]["top10_holder_change"] = holder_change
                ratio_col = next(
                    (col for col in top10_df.columns if "持股比例" in str(col) or "持股比" in str(col)),
                    None,
                )
                if ratio_col:
                    ratios = pd.to_numeric(top10_df[ratio_col], errors="coerce").dropna()
                    if not ratios.empty:
                        result["institution"]["top10_total_holding_pct"] = round(float(ratios.sum()), 6)
                result["source_chain"].append(f"top10:{top10_source}")

        if (
            not institution_cached
            and result["institution"].get("institution_count")
            and self._enable_disk_cache
        ):
            write_session_cache(
                "akshare_institution",
                institution_cache_key,
                {
                    "institution": result["institution"],
                    "source_chain": [
                        item for item in result["source_chain"]
                        if str(item).startswith(("institution:", "top10:"))
                    ],
                },
            )

        _attach_financial_freshness(result["earnings"])
        has_content = bool(result["growth"] or result["earnings"] or result["institution"])
        result["status"] = "partial" if has_content else "not_supported"
        return result

    def get_capital_flow(self, stock_code: str, top_n: int = 5) -> Dict[str, Any]:
        """
        Return stock + sector capital flow.
        """
        result: Dict[str, Any] = {
            "status": "not_supported",
            "stock_flow": {},
            "sector_rankings": {"top": [], "bottom": []},
            "source_chain": [],
            "errors": [],
        }

        market = "sh" if str(stock_code).startswith(("5", "6", "9")) else "bj" if str(stock_code).startswith(("4", "8")) else "sz"
        # The shared THS ranking is one free request for the whole watchlist
        # and proved materially more reliable than waiting for three
        # sequential EastMoney endpoints. Prefer it, then retain the original
        # chain as fallback so the data contract and calculation stay intact.
        stock_df = self._get_individual_flow_rank_fallback()
        stock_source = "stock_fund_flow_individual" if stock_df is not None else None
        stock_errors: List[str] = []

        def _apply_stock_flow(frame: Optional[pd.DataFrame], source: Optional[str]) -> bool:
            if frame is None:
                return False
            row = _extract_latest_row(frame, stock_code)
            if row is None:
                return False
            values = {
                "main_net_inflow": _safe_amount_float(
                    _pick_by_keywords(row, ["主力净流入", "净流入", "净额"])
                ),
                "inflow_5d": _safe_float(_pick_by_keywords(row, ["5日", "五日"])),
                "inflow_10d": _safe_float(_pick_by_keywords(row, ["10日", "十日"])),
            }
            if not any(value is not None for value in values.values()):
                return False
            result["stock_flow"] = values
            result["source_chain"].append(f"capital_stock:{source}")
            return True

        has_stock_flow_value = _apply_stock_flow(stock_df, stock_source)
        if not has_stock_flow_value:
            stock_df, stock_source, stock_errors = self._call_df_candidates([
                ("stock_individual_fund_flow", {"stock": stock_code, "market": market}),
                ("stock_main_fund_flow", {"symbol": stock_code}),
                ("stock_main_fund_flow", {}),
            ])
            has_stock_flow_value = _apply_stock_flow(stock_df, stock_source)
        result["errors"].extend(stock_errors)
        sector_df = None
        sector_source = None
        sector_errors: List[str] = []
        # Sector-flow rankings are supplemental. Once the stock-level flow is
        # available, do not hold that decisive input hostage to another slow
        # full-market endpoint; industry/board context has its own provider chain.
        if not has_stock_flow_value:
            sector_df, sector_source, sector_errors = self._call_df_candidates([
                ("stock_sector_fund_flow_rank", {}),
                ("stock_sector_fund_flow_summary", {}),
            ])
            result["errors"].extend(sector_errors)
        if sector_df is not None:
            name_col = next((c for c in sector_df.columns if any(k in str(c) for k in ("板块", "行业", "名称", "name"))), None)
            flow_col = next((c for c in sector_df.columns if any(k in str(c) for k in ("净流入", "主力", "flow", "净额"))), None)
            if name_col and flow_col:
                work_df = sector_df[[name_col, flow_col]].copy()
                work_df[flow_col] = pd.to_numeric(work_df[flow_col], errors="coerce")
                work_df = work_df.dropna(subset=[flow_col])
                top_df = work_df.nlargest(top_n, flow_col)
                bottom_df = work_df.nsmallest(top_n, flow_col)
                result["sector_rankings"] = {
                    "top": [{"name": _safe_str(r[name_col]), "net_inflow": float(r[flow_col])} for _, r in top_df.iterrows()],
                    "bottom": [{"name": _safe_str(r[name_col]), "net_inflow": float(r[flow_col])} for _, r in bottom_df.iterrows()],
                }
                result["source_chain"].append(f"capital_sector:{sector_source}")

        has_content = bool(result["stock_flow"] or result["sector_rankings"]["top"] or result["sector_rankings"]["bottom"])
        result["status"] = "partial" if has_content else "not_supported"
        return result

    def get_dragon_tiger_flag(self, stock_code: str, lookback_days: int = 20) -> Dict[str, Any]:
        """
        Return dragon-tiger signal in lookback window.
        """
        result: Dict[str, Any] = {
            "status": "not_supported",
            "is_on_list": False,
            "recent_count": 0,
            "latest_date": None,
            "source_chain": [],
            "errors": [],
        }

        df, source, errors = self._call_df_candidates([
            ("stock_lhb_stock_statistic_em", {}),
            ("stock_lhb_detail_em", {}),
            ("stock_lhb_jgmmtj_em", {}),
        ])
        result["errors"].extend(errors)
        if df is None:
            return result

        # Try code filter
        code_cols = [c for c in df.columns if any(k in str(c) for k in ("代码", "股票代码", "证券代码"))]
        target = _normalize_code(stock_code)
        matched = pd.DataFrame()
        for col in code_cols:
            try:
                series = df[col].astype(str).map(_normalize_code)
                cur = df[series == target]
                if not cur.empty:
                    matched = cur
                    break
            except Exception:
                continue
        if matched.empty:
            result["source_chain"].append(f"dragon_tiger:{source}")
            result["status"] = "ok" if code_cols else "partial"
            return result

        date_col = next((c for c in matched.columns if any(k in str(c) for k in ("日期", "上榜", "交易日", "time"))), None)
        parsed_dates: List[datetime] = []
        if date_col is not None:
            for val in matched[date_col].astype(str).tolist():
                try:
                    parsed_dates.append(pd.to_datetime(val).to_pydatetime())
                except Exception:
                    continue
        now = datetime.now()
        start = now - timedelta(days=max(1, lookback_days))
        recent_dates = [d for d in parsed_dates if start <= d <= now]

        result["is_on_list"] = bool(recent_dates)
        result["recent_count"] = len(recent_dates) if recent_dates else int(len(matched))
        result["latest_date"] = max(recent_dates).date().isoformat() if recent_dates else (
            max(parsed_dates).date().isoformat() if parsed_dates else None
        )
        result["status"] = "ok"
        result["source_chain"].append(f"dragon_tiger:{source}")
        return result
