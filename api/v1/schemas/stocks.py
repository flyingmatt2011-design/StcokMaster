# -*- coding: utf-8 -*-
"""
===================================
股票数据相关模型
===================================

职责：
1. 定义股票实时行情模型
2. 定义历史 K 线数据模型
"""

from typing import Literal, Optional, List

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StockQuote(BaseModel):
    """股票实时行情"""
    
    stock_code: str = Field(..., description="股票代码")
    stock_name: Optional[str] = Field(None, description="股票名称")
    current_price: float = Field(..., description="当前价格")
    change: Optional[float] = Field(None, description="涨跌额")
    change_percent: Optional[float] = Field(None, description="涨跌幅 (%)")
    open: Optional[float] = Field(None, description="开盘价")
    high: Optional[float] = Field(None, description="最高价")
    low: Optional[float] = Field(None, description="最低价")
    prev_close: Optional[float] = Field(None, description="昨收价")
    volume: Optional[float] = Field(None, description="成交量（股）")
    amount: Optional[float] = Field(None, description="成交额（元）")
    update_time: Optional[str] = Field(None, description="更新时间")
    source: Optional[str] = Field(None, description="本次行情数据源")
    provider_timestamp: Optional[str] = Field(None, description="数据源提供的行情时间")
    fetched_at: Optional[str] = Field(None, description="行情抓取完成时间")
    last_success_at: Optional[str] = Field(None, description="最后一次成功刷新时间")
    is_stale: bool = Field(False, description="是否正在展示旧行情")
    stale_seconds: Optional[float] = Field(None, ge=0, description="行情陈旧秒数")
    refresh_status: Literal["fresh", "cached", "stale", "failed"] = Field(
        "fresh",
        description="本次刷新状态",
    )
    failure_count: int = Field(0, ge=0, description="连续刷新失败次数")
    next_retry_at: Optional[str] = Field(None, description="失败代码的下次定向重试时间")
    
    model_config = ConfigDict(json_schema_extra={
        "example": {
            "stock_code": "600519",
            "stock_name": "贵州茅台",
            "current_price": 1800.00,
            "change": 15.00,
            "change_percent": 0.84,
            "open": 1785.00,
            "high": 1810.00,
            "low": 1780.00,
            "prev_close": 1785.00,
            "volume": 10000000,
            "amount": 18000000000,
            "update_time": "2024-01-01T15:00:00"
        }
    })


class StockQuoteBatchRequest(BaseModel):
    """Batch realtime quote request for lightweight dashboard refreshes."""

    stock_codes: List[str] = Field(..., min_length=1, max_length=100)

    @field_validator("stock_codes")
    @classmethod
    def normalize_codes(cls, values: List[str]) -> List[str]:
        normalized: List[str] = []
        seen = set()
        for value in values:
            code = str(value or "").strip()
            if not code or code.upper() in seen:
                continue
            seen.add(code.upper())
            normalized.append(code)
        if not normalized:
            raise ValueError("stock_codes 不能为空")
        return normalized


class StockQuoteBatchResponse(BaseModel):
    """Partial-success batch quote response."""

    items: List[StockQuote] = Field(default_factory=list)
    failed_codes: List[str] = Field(default_factory=list)
    update_time: str = Field(..., description="批量行情刷新完成时间")


class StockQuoteRefreshPolicy(BaseModel):
    """Server-authoritative A-share quote polling schedule."""

    market: Literal["cn"] = "cn"
    phase: Literal[
        "premarket",
        "intraday",
        "lunch_break",
        "closing_auction",
        "postmarket",
        "non_trading",
        "unknown",
    ]
    is_trading_day: Optional[bool] = None
    is_market_open_now: Optional[bool] = None
    market_local_time: str
    next_transition_at: Optional[str] = None


class KLineData(BaseModel):
    """K 线数据点"""
    
    date: str = Field(..., description="日期")
    open: float = Field(..., description="开盘价")
    high: float = Field(..., description="最高价")
    low: float = Field(..., description="最低价")
    close: float = Field(..., description="收盘价")
    volume: Optional[float] = Field(None, description="成交量")
    amount: Optional[float] = Field(None, description="成交额")
    change_percent: Optional[float] = Field(None, description="涨跌幅 (%)")
    
    model_config = ConfigDict(json_schema_extra={
        "example": {
            "date": "2024-01-01",
            "open": 1785.00,
            "high": 1810.00,
            "low": 1780.00,
            "close": 1800.00,
            "volume": 10000000,
            "amount": 18000000000,
            "change_percent": 0.84
        }
    })


class ExtractItem(BaseModel):
    """单条提取结果（代码、名称、置信度）"""

    code: Optional[str] = Field(None, description="股票代码，None 表示解析失败")
    name: Optional[str] = Field(None, description="股票名称（如有）")
    confidence: str = Field("medium", description="置信度：high/medium/low")


class ExtractFromImageResponse(BaseModel):
    """图片股票代码提取响应"""

    codes: List[str] = Field(..., description="提取的股票代码（已去重，向后兼容）")
    items: List[ExtractItem] = Field(default_factory=list, description="提取结果明细（代码+名称+置信度）")
    raw_text: Optional[str] = Field(None, description="原始 LLM 响应（调试用）")


class StockHistoryResponse(BaseModel):
    """股票历史行情响应"""
    
    stock_code: str = Field(..., description="股票代码")
    stock_name: Optional[str] = Field(None, description="股票名称")
    period: str = Field(..., description="K 线周期")
    data: List[KLineData] = Field(default_factory=list, description="K 线数据列表")
    
    model_config = ConfigDict(json_schema_extra={
        "example": {
            "stock_code": "600519",
            "stock_name": "贵州茅台",
            "period": "daily",
            "data": []
        }
    })
