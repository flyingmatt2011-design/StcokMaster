from __future__ import annotations

import os
import sys
from datetime import date
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from data_provider.baostock_fundamental_adapter import BaostockFundamentalAdapter


class _Result:
    def __init__(self, rows):
        self.error_code = "0"
        self.error_msg = "success"
        self.fields = list(rows[0]) if rows else []
        self._rows = [list(row.values()) for row in rows]
        self._index = -1

    def next(self):
        self._index += 1
        return self._index < len(self._rows)

    def get_row_data(self):
        return self._rows[self._index]


class _FakeBaoStock:
    def __init__(self):
        self.calls = []

    def login(self):
        return SimpleNamespace(error_code="0", error_msg="success")

    def logout(self):
        return SimpleNamespace(error_code="0", error_msg="success")

    def _quarter(self, name, **kwargs):
        self.calls.append((name, kwargs))
        if kwargs["year"] != 2026 or kwargs["quarter"] != 2:
            return _Result([])
        rows = {
            "profit": [{
                "code": "sh.600519", "pubDate": "2026-08-15", "statDate": "2026-06-30",
                "roeAvg": "0.179543", "gpMargin": "0.895552", "netProfit": "46033330566.78",
                "MBRevenue": "92278072083.21",
            }],
            "growth": [{
                "code": "sh.600519", "pubDate": "2026-08-15", "statDate": "2026-06-30",
                "YOYEquity": "0.052827", "YOYAsset": "0.057460", "YOYNI": "-0.020290",
                "YOYEPSBasic": "-0.016860", "YOYPNI": "-0.019516",
            }],
            "cash_flow": [{
                "code": "sh.600519", "CFOToOR": "0.779363", "CFOToNP": "1.535643",
            }],
        }
        return _Result(rows.get(name, []))

    def query_profit_data(self, **kwargs): return self._quarter("profit", **kwargs)
    def query_growth_data(self, **kwargs): return self._quarter("growth", **kwargs)
    def query_operation_data(self, **kwargs): return self._quarter("operation", **kwargs)
    def query_balance_data(self, **kwargs): return self._quarter("balance", **kwargs)
    def query_cash_flow_data(self, **kwargs): return self._quarter("cash_flow", **kwargs)
    def query_dupont_data(self, **kwargs): return self._quarter("dupont", **kwargs)

    def query_forecast_report(self, **kwargs):
        return _Result([{
            "code": "sh.600519",
            "profitForcastExpPubDate": "2026-07-01",
            "profitForcastExpStatDate": "2026-06-30",
            "profitForcastChgPctUp": "12.5",
            "profitForcastChgPctDwn": "8.5",
        }])

    def query_performance_express_report(self, **kwargs):
        return _Result([])

    def query_dividend_data(self, **kwargs):
        if kwargs["year"] != date.today().year:
            return _Result([])
        return _Result([{
            "code": "sh.600519",
            "dividPlanAnnounceDate": "2026-04-17",
            "dividRegistDate": date.today().isoformat(),
            "dividOperateDate": date.today().isoformat(),
            "dividPayDate": date.today().isoformat(),
            "dividCashPsBeforeTax": "28.02423",
        }])


def test_baostock_bundle_maps_existing_contract_and_reuses_disk_cache() -> None:
    fake = _FakeBaoStock()
    with TemporaryDirectory() as temp_dir, patch.dict(
        os.environ,
        {"DATABASE_PATH": os.path.join(temp_dir, "stock_analysis.db")},
    ), patch.dict(sys.modules, {"baostock": fake}), patch(
        "data_provider.baostock_fundamental_adapter._completed_quarters",
        return_value=[(2026, 2)],
    ):
        adapter = BaostockFundamentalAdapter()
        first = adapter.get_fundamental_bundle("600519")
        call_count = len(fake.calls)
        second = adapter.get_fundamental_bundle("600519")

    assert first["growth"]["net_profit_yoy"] == -1.9516
    assert first["growth"]["roe"] == 17.9543
    assert first["earnings"]["financial_report"]["report_date"] == "2026-06-30"
    assert first["earnings"]["financial_report"]["operating_cash_flow_to_revenue_pct"] == 77.9363
    assert first["earnings"]["forecast"]["change_pct_low"] == 8.5
    assert first["earnings"]["dividend"]["ttm_cash_dividend_per_share"] == 28.02423
    assert set(first["queried"]) >= {"financial", "forecast", "quick", "dividend"}
    assert len(fake.calls) == call_count
    assert "fundamental:baostock_cache" in second["source_chain"]
