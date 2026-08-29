from __future__ import annotations

from src.utils.data_processing import (
    extract_context_enrichment_detail_fields,
    extract_stockmaster_display_fields,
)


def test_extracts_existing_dashboard_fields_without_mutating_payload() -> None:
    raw = {
        "dashboard": {
            "core_conclusion": "核心结论",
            "data_perspective": {"price_position": {"support_level": "10.00", "resistance_level": "12.00", "bias_ma5": "-1.25"}},
            "intelligence": {"risk_alerts": ["风险一", ""], "positive_catalysts": ["催化一"]},
        }
    }

    extracted = extract_stockmaster_display_fields(raw)

    assert extracted == {
        "core_conclusion": "核心结论",
        "risk_alerts": ["风险一"],
        "positive_catalysts": ["催化一"],
        "support_level": "10.00",
        "resistance_level": "12.00",
        "bias_ma5": -1.25,
    }
    assert raw["dashboard"]["data_perspective"]["price_position"]["support_level"] == "10.00"


def test_missing_or_malformed_nodes_are_empty_and_truthful() -> None:
    assert extract_stockmaster_display_fields({"dashboard": {"intelligence": "not-a-dict"}}) == {
        "core_conclusion": None,
        "risk_alerts": [],
        "positive_catalysts": [],
        "support_level": None,
        "resistance_level": None,
        "bias_ma5": None,
    }


def test_extracts_structured_core_conclusion_from_dashboard() -> None:
    raw = {
        "dashboard": {
            "core_conclusion": {
                "one_sentence": "回踩支撑后再观察",
                "position_advice": {
                    "no_position": "等待确认后再建仓",
                },
            },
            "intelligence": {
                "risk_alerts": ["跌破支撑需止损"],
                "positive_catalysts": ["行业需求改善"],
            },
            "data_perspective": {
                "price_position": {
                    "support_level": 10.5,
                    "resistance_level": 12.0,
                },
            },
        },
    }

    extracted = extract_stockmaster_display_fields(raw)

    assert extracted == {
        "core_conclusion": "回踩支撑后再观察",
        "risk_alerts": ["跌破支撑需止损"],
        "positive_catalysts": ["行业需求改善"],
        "support_level": "10.5",
        "resistance_level": "12.0",
        "bias_ma5": None,
    }


def test_extracts_context_only_valuation_and_chart_patterns() -> None:
    snapshot = {
        "enhanced_context": {
            "fundamental_context": {
                "valuation": {
                    "data": {
                        "history_percentiles": {
                            "provider": "eastmoney_valuation_history",
                            "metrics": {"pe": {"current": 20.0, "percentile": 11.08}},
                        }
                    }
                }
            },
            "trend_analysis": {
                "chart_patterns": [{"type": "w_bottom", "label": "W底"}],
                "chart_pattern_summary": "W底（形成中）",
                "signal_score": 59,
            },
        }
    }

    extracted = extract_context_enrichment_detail_fields(snapshot)

    assert extracted["valuation_history"]["metrics"]["pe"]["percentile"] == 11.08
    assert extracted["chart_pattern_context"] == {
        "patterns": [{"type": "w_bottom", "label": "W底"}],
        "summary": "W底（形成中）",
        "score_included": False,
    }

    from api.v1.schemas.history import ReportDetails

    details = ReportDetails(context_snapshot=snapshot)
    assert details.valuation_history["metrics"]["pe"]["percentile"] == 11.08
    assert details.chart_pattern_context["score_included"] is False
