from datetime import datetime, timezone

import src.analyzer as analyzer
import src.storage as storage
from src.analysis_text_normalization import (
    _localized_text as extracted_localized_text,
    _normalize_risk_warning_values as extracted_normalize_risk_warning_values,
)
from src.core import pipeline
from src.core.pipeline_helpers import (
    _share_image_payload as extracted_share_image_payload,
    _supports_explicit_keyword as extracted_supports_explicit_keyword,
    _symbol_scope_lookup_values as extracted_symbol_scope_lookup_values,
)
from src.storage_time import (
    to_utc_naive_datetime as extracted_to_utc_naive_datetime,
    utc_naive_now as extracted_utc_naive_now,
)


def test_analyzer_private_compatibility_exports_point_to_extracted_helpers():
    assert analyzer._localized_text is extracted_localized_text
    assert analyzer._normalize_risk_warning_values is extracted_normalize_risk_warning_values
    assert analyzer._normalize_risk_warning_values(["风险", ["提示"]]) == ["风险", "提示"]


def test_pipeline_private_compatibility_exports_point_to_extracted_helpers():
    assert pipeline._share_image_payload is extracted_share_image_payload
    assert pipeline._supports_explicit_keyword is extracted_supports_explicit_keyword
    assert pipeline._symbol_scope_lookup_values is extracted_symbol_scope_lookup_values
    assert "SH600519" in pipeline._symbol_scope_lookup_values("600519", "cn")


def test_storage_compatibility_exports_point_to_extracted_time_helpers():
    assert storage.utc_naive_now is extracted_utc_naive_now
    assert storage.to_utc_naive_datetime is extracted_to_utc_naive_datetime
    aware = datetime(2026, 1, 1, 8, 0, tzinfo=timezone.utc)
    assert storage.to_utc_naive_datetime(aware) == datetime(2026, 1, 1, 8, 0)
