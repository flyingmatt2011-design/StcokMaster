# -*- coding: utf-8 -*-
"""
Tests for fundamental adapter helpers.
"""

import os
import sys
import unittest
from datetime import datetime, timedelta
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import pandas as pd

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from data_provider.fundamental_adapter import (
    AkshareFundamentalAdapter,
    _attach_financial_freshness,
    _build_dividend_payload,
    _extract_latest_row,
    _parse_dividend_plan_to_per_share,
    _safe_amount_float,
)


class TestFundamentalAdapter(unittest.TestCase):
    def test_financial_freshness_marks_statement_behind_newer_forecast_period(self) -> None:
        earnings = {
            "financial_report": {"report_date": "2026-03-31"},
            "forecast": {"report_date": "2026-06-30"},
        }

        _attach_financial_freshness(earnings)

        self.assertEqual(
            earnings["data_freshness"],
            {
                "status": "lagging_reference_period",
                "financial_report_date": "2026-03-31",
                "latest_reference_period": "2026-06-30",
            },
        )

    def test_newer_reference_period_triggers_financial_refresh_attempt(self) -> None:
        baostock = SimpleNamespace(
            get_fundamental_bundle=lambda _code: {
                "status": "partial",
                "growth": {"net_profit_yoy": 10.0},
                "earnings": {
                    "financial_report": {"report_date": "2026-03-31"},
                    "forecast": {"report_date": "2026-06-30"},
                },
                "institution": {},
                "source_chain": ["fundamental:baostock:2026Q1"],
                "errors": [],
                "queried": ["financial", "forecast", "quick", "dividend"],
            }
        )
        adapter = AkshareFundamentalAdapter(baostock_adapter=baostock)
        financial_df = pd.DataFrame(
            {
                "股票代码": ["600519"],
                "报告期": ["2026-06-30"],
                "归母净利润同比": [68.0],
                "归母净利润": [391.7],
            }
        )
        calls = []

        def fake_candidates(candidates):
            calls.append(candidates)
            if candidates and candidates[0][0] == "stock_financial_abstract":
                return financial_df, "stock_financial_abstract", []
            return None, None, []

        with patch.object(adapter, "_call_df_candidates", side_effect=fake_candidates):
            result = adapter.get_fundamental_bundle("600519")

        self.assertTrue(
            any(candidates[0][0] == "stock_financial_abstract" for candidates in calls)
        )
        self.assertEqual(
            result["earnings"]["financial_report"]["report_date"],
            "2026-06-30",
        )
        self.assertEqual(
            result["earnings"]["data_freshness"]["status"],
            "current_to_reference_period",
        )

    def test_safe_amount_float_normalizes_cn_units(self) -> None:
        self.assertEqual(_safe_amount_float("-8.70亿"), -870_000_000.0)
        self.assertEqual(_safe_amount_float("125.5万"), 1_255_000.0)

    def test_capital_flow_uses_shared_ths_ranking_fallback(self) -> None:
        adapter = AkshareFundamentalAdapter()
        rank_df = pd.DataFrame(
            {
                "股票代码": ["600519"],
                "净额": ["-8.70亿"],
            }
        )
        with patch.object(
            adapter,
            "_call_df_candidates",
            side_effect=[(None, None, ["eastmoney:ProxyError"]), (None, None, [])],
        ), patch.object(
            adapter,
            "_get_individual_flow_rank_fallback",
            return_value=rank_df,
        ):
            result = adapter.get_capital_flow("600519")

        self.assertEqual(result["stock_flow"]["main_net_inflow"], -870_000_000.0)
        self.assertIn("capital_stock:stock_fund_flow_individual", result["source_chain"])

    def test_capital_flow_falls_back_when_shared_rank_does_not_contain_stock(self) -> None:
        adapter = AkshareFundamentalAdapter()
        shared_rank = pd.DataFrame({"股票代码": ["600000"], "净额": ["1.00亿"]})
        per_stock = pd.DataFrame({"股票代码": ["000039"], "主力净流入": ["3200万"]})

        with patch.object(
            adapter,
            "_get_individual_flow_rank_fallback",
            return_value=shared_rank,
        ), patch.object(
            adapter,
            "_call_df_candidates",
            return_value=(per_stock, "stock_individual_fund_flow", []),
        ) as candidates:
            result = adapter.get_capital_flow("000039")

        self.assertEqual(result["stock_flow"]["main_net_inflow"], 32_000_000.0)
        self.assertIn("capital_stock:stock_individual_fund_flow", result["source_chain"])
        self.assertTrue(candidates.called)

    def test_ths_capital_flow_ranking_reuses_session_disk_cache(self) -> None:
        frame = pd.DataFrame({"股票代码": ["600519"], "净额": ["1.25亿"]})
        fake_akshare = SimpleNamespace(stock_fund_flow_individual=lambda **_kwargs: frame)
        adapter_cls = AkshareFundamentalAdapter
        original_frame = adapter_cls._individual_flow_rank_cache
        original_at = adapter_cls._individual_flow_rank_cache_at
        try:
            with TemporaryDirectory() as temp_dir, patch.dict(
                os.environ,
                {"DATABASE_PATH": os.path.join(temp_dir, "stock_analysis.db")},
            ), patch.dict(sys.modules, {"akshare": fake_akshare}):
                adapter_cls._individual_flow_rank_cache = None
                adapter_cls._individual_flow_rank_cache_at = 0.0
                first = adapter_cls._get_individual_flow_rank_fallback()
                adapter_cls._individual_flow_rank_cache = None
                adapter_cls._individual_flow_rank_cache_at = 0.0
                fake_akshare.stock_fund_flow_individual = lambda **_kwargs: (_ for _ in ()).throw(
                    AssertionError("network should not be called after a session-cache hit")
                )
                second = adapter_cls._get_individual_flow_rank_fallback()
        finally:
            adapter_cls._individual_flow_rank_cache = original_frame
            adapter_cls._individual_flow_rank_cache_at = original_at

        self.assertIsNotNone(first)
        self.assertIsNotNone(second)
        self.assertEqual(str(second.iloc[0]["股票代码"]), "600519")

    def test_parse_dividend_plan_to_per_share_supports_cn_patterns(self) -> None:
        self.assertAlmostEqual(_parse_dividend_plan_to_per_share("10派3元(含税)"), 0.3, places=6)
        self.assertAlmostEqual(_parse_dividend_plan_to_per_share("每10股派发2.5元"), 0.25, places=6)
        self.assertAlmostEqual(_parse_dividend_plan_to_per_share("每股派0.8元"), 0.8, places=6)
        self.assertIsNone(_parse_dividend_plan_to_per_share("仅送股，不现金分红"))

    def test_extract_latest_row_returns_none_when_code_mismatch(self) -> None:
        df = pd.DataFrame(
            {
                "股票代码": ["600000", "000001"],
                "值": [1, 2],
            }
        )
        row = _extract_latest_row(df, "600519")
        self.assertIsNone(row)

    def test_extract_latest_row_fallback_when_no_code_column(self) -> None:
        df = pd.DataFrame({"值": [1, 2]})
        row = _extract_latest_row(df, "600519")
        self.assertIsNotNone(row)
        self.assertEqual(row["值"], 1)

    def test_dragon_tiger_no_match_with_code_column_is_ok(self) -> None:
        adapter = AkshareFundamentalAdapter()
        df = pd.DataFrame(
            {
                "股票代码": ["600000"],
                "日期": ["2026-01-01"],
            }
        )
        with patch.object(adapter, "_call_df_candidates", return_value=(df, "stock_lhb_stock_statistic_em", [])):
            result = adapter.get_dragon_tiger_flag("600519")
        self.assertEqual(result["status"], "ok")
        self.assertFalse(result["is_on_list"])
        self.assertEqual(result["recent_count"], 0)

    def test_dragon_tiger_match_is_ok(self) -> None:
        adapter = AkshareFundamentalAdapter()
        today = pd.Timestamp.now().strftime("%Y-%m-%d")
        df = pd.DataFrame(
            {
                "股票代码": ["600519"],
                "日期": [today],
            }
        )
        with patch.object(adapter, "_call_df_candidates", return_value=(df, "stock_lhb_stock_statistic_em", [])):
            result = adapter.get_dragon_tiger_flag("600519")
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["is_on_list"])
        self.assertGreaterEqual(result["recent_count"], 1)

    def test_fundamental_bundle_includes_financial_report_and_dividend_payload(self) -> None:
        adapter = AkshareFundamentalAdapter()
        now = datetime.now()
        within_ttm = (now - timedelta(days=30)).strftime("%Y-%m-%d")
        future_day = (now + timedelta(days=10)).strftime("%Y-%m-%d")
        old_day = (now - timedelta(days=500)).strftime("%Y-%m-%d")
        fin_df = pd.DataFrame(
            {
                "股票代码": ["600519"],
                "报告期": [within_ttm],
                "营业总收入": [1000.0],
                "归母净利润": [300.0],
                "经营活动产生的现金流量净额": [500.0],
                "净资产收益率": [18.2],
                "营业收入同比": [12.0],
                "净利润同比": [9.5],
            }
        )
        forecast_df = pd.DataFrame({"股票代码": ["600519"], "预告": ["预增"]})
        quick_df = pd.DataFrame({"股票代码": ["600519"], "快报": ["快报摘要"]})
        dividend_df = pd.DataFrame(
            {
                "股票代码": ["600519", "600519", "600519", "600519"],
                "除息日": [within_ttm, within_ttm, future_day, old_day],
                "分配方案": ["10派3元(含税)", "10派3元(含税)", "10派5元", "10派1元"],
            }
        )

        with patch.object(
            adapter,
            "_call_df_candidates",
            side_effect=[
                (fin_df, "stock_financial_abstract", []),
                (forecast_df, "stock_yjyg_em", []),
                (quick_df, "stock_yjkb_em", []),
                (dividend_df, "stock_fhps_detail_em", []),
                (None, None, []),
                (None, None, []),
            ],
        ):
            result = adapter.get_fundamental_bundle("600519")

        financial_report = result["earnings"].get("financial_report", {})
        self.assertEqual(financial_report.get("report_date"), within_ttm)
        self.assertEqual(financial_report.get("revenue"), 1000.0)
        self.assertEqual(financial_report.get("net_profit_parent"), 300.0)
        self.assertEqual(financial_report.get("operating_cash_flow"), 500.0)
        self.assertEqual(financial_report.get("roe"), 18.2)

        dividend_payload = result["earnings"].get("dividend", {})
        events = dividend_payload.get("events", [])
        self.assertEqual(len(events), 2)  # duplicate + future day filtered
        self.assertEqual(dividend_payload.get("ttm_event_count"), 1)
        self.assertAlmostEqual(dividend_payload.get("ttm_cash_dividend_per_share"), 0.3, places=6)

    def test_institution_candidates_use_periods_and_aggregate_holdings(self) -> None:
        adapter = AkshareFundamentalAdapter()
        captured = []
        institution_df = pd.DataFrame(
            {
                "持股机构类型": ["基金", "基金"],
                "持股比例增幅": [0.06, -0.01],
            }
        )
        top10_df = pd.DataFrame(
            {
                "股东名称": ["甲", "乙"],
                "占总流通股本持股比例": [10.0, 5.5],
                "变动比率": [1.2, -0.4],
            }
        )

        def fake_candidates(candidates):
            captured.append(candidates)
            index = len(captured)
            if index == 5:
                return institution_df, "stock_institute_hold_detail", []
            if index == 6:
                return top10_df, "stock_gdfx_free_top_10_em", []
            return None, None, []

        with patch.object(adapter, "_call_df_candidates", side_effect=fake_candidates):
            result = adapter.get_fundamental_bundle("600519")

        institution_candidates = captured[4]
        top10_candidates = captured[5]
        self.assertTrue(all(name == "stock_institute_hold_detail" for name, _ in institution_candidates))
        self.assertTrue(all("quarter" in kwargs for _, kwargs in institution_candidates))
        self.assertEqual(top10_candidates[0][0], "stock_gdfx_free_top_10_em")
        self.assertEqual(top10_candidates[0][1]["symbol"], "sh600519")
        self.assertEqual(result["institution"]["institution_count"], 2)
        self.assertAlmostEqual(result["institution"]["institution_holding_change"], 0.05, places=6)
        self.assertAlmostEqual(result["institution"]["top10_holder_change"], 0.8, places=6)
        self.assertAlmostEqual(result["institution"]["top10_total_holding_pct"], 15.5, places=6)

    def test_build_dividend_payload_returns_empty_when_code_not_matched(self) -> None:
        now = datetime.now().strftime("%Y-%m-%d")
        df = pd.DataFrame(
            {
                "股票代码": ["000001"],
                "除息日": [now],
                "分配方案": ["10派3元(含税)"],
            }
        )

        payload = _build_dividend_payload(df, stock_code="600519")
        self.assertEqual(payload, {})

    def test_build_dividend_payload_skips_after_tax_plan(self) -> None:
        now = datetime.now().strftime("%Y-%m-%d")
        df = pd.DataFrame(
            {
                "股票代码": ["600519"],
                "除息日": [now],
                "分配方案": ["10派3元(税后)"],
            }
        )

        payload = _build_dividend_payload(df, stock_code="600519")
        self.assertEqual(payload, {})

    def test_build_dividend_payload_ttm_window_boundary(self) -> None:
        now = datetime.now()
        day_365 = (now - timedelta(days=365)).strftime("%Y-%m-%d")
        day_366 = (now - timedelta(days=366)).strftime("%Y-%m-%d")
        df = pd.DataFrame(
            {
                "股票代码": ["600519", "600519"],
                "除息日": [day_365, day_366],
                "分配方案": ["10派3元(含税)", "10派5元(含税)"],
            }
        )

        payload = _build_dividend_payload(df, stock_code="600519")
        self.assertEqual(payload.get("ttm_event_count"), 1)
        self.assertAlmostEqual(payload.get("ttm_cash_dividend_per_share"), 0.3, places=6)


if __name__ == "__main__":
    unittest.main()
