from src.search_provider_base import (
    BaseSearchProvider as ExtractedBaseSearchProvider,
    SearchResponse as ExtractedSearchResponse,
    SearchResult as ExtractedSearchResult,
)
from src.search_service import BaseSearchProvider, SearchResponse, SearchResult


def test_legacy_search_service_exports_extracted_contracts():
    assert BaseSearchProvider is ExtractedBaseSearchProvider
    assert SearchResponse is ExtractedSearchResponse
    assert SearchResult is ExtractedSearchResult


def test_search_result_and_response_serialization_contract_is_unchanged():
    result = SearchResult(title="标题", snippet="摘要", url="https://example.com", source="测试")
    response = SearchResponse(query="查询", results=[result], provider="Provider")

    assert "【测试】标题" in result.to_text()
    assert "【查询 搜索结果】（来源：Provider）" in response.to_context()
