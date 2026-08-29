# -*- coding: utf-8 -*-
"""
===================================
股票数据服务层
===================================

职责：
1. 封装股票数据获取逻辑
2. 提供实时行情和历史数据接口
"""

import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum
from typing import Optional, Dict, Any, List

from src.repositories.stock_repo import StockRepository

logger = logging.getLogger(__name__)


@dataclass
class _CachedRealtimeQuote:
    quote: Any
    cached_at_monotonic: float
    last_success_at: str


@dataclass
class _RealtimeQuoteFailure:
    count: int
    next_retry_monotonic: float
    next_retry_at: str


class StockService:
    """
    股票数据服务
    
    封装股票数据获取的业务逻辑
    """

    # Dashboard requests arrive from page focus, timers, and manual refreshes.
    # Keep one process-wide cache/flight so concurrent service instances do not
    # duplicate requests to the same free quote provider.
    REALTIME_QUOTE_CACHE_TTL_SECONDS = 3.0
    REALTIME_QUOTE_RETRY_BACKOFF_SECONDS = (5.0, 15.0, 30.0, 60.0)
    REALTIME_QUOTE_FLIGHT_WAIT_SECONDS = 15.0
    _quote_condition = threading.Condition(threading.RLock())
    _quote_fetch_in_progress = False
    _quote_cache: Dict[str, _CachedRealtimeQuote] = {}
    _quote_failures: Dict[str, _RealtimeQuoteFailure] = {}
    
    def __init__(self):
        """初始化股票数据服务"""
        self.repo = StockRepository()
    
    def get_realtime_quote(self, stock_code: str) -> Optional[Dict[str, Any]]:
        """
        获取股票实时行情
        
        Args:
            stock_code: 股票代码
            
        Returns:
            实时行情数据字典
        """
        try:
            # 调用数据获取器获取实时行情
            from data_provider.base import DataFetcherManager
            
            manager = DataFetcherManager()
            quote = manager.get_realtime_quote(stock_code)
            
            if quote is None:
                logger.warning(f"获取 {stock_code} 实时行情失败")
                return None
            
            # UnifiedRealtimeQuote 是 dataclass，使用 getattr 安全访问字段
            # 字段映射: UnifiedRealtimeQuote -> API 响应
            # - code -> stock_code
            # - name -> stock_name
            # - price -> current_price
            # - change_amount -> change
            # - change_pct -> change_percent
            # - open_price -> open
            # - high -> high
            # - low -> low
            # - pre_close -> prev_close
            # - volume -> volume
            # - amount -> amount
            return self._quote_to_dict(quote, stock_code)

        except ImportError:
            logger.warning("DataFetcherManager 未找到，使用占位数据")
            return self._get_placeholder_quote(stock_code)
        except Exception as e:
            logger.error(f"获取实时行情失败: {e}", exc_info=True)
            return None

    def get_realtime_quotes(self, stock_codes: List[str]) -> Dict[str, Any]:
        """Get batched quotes with shared caching, request coalescing, and retry backoff."""
        from data_provider.base import DataFetcherManager

        requested: List[tuple[str, str]] = []
        seen = set()
        for raw_code in stock_codes:
            code = str(raw_code or "").strip()
            key = code.upper()
            if not code or key in seen:
                continue
            seen.add(key)
            requested.append((code, key))

        fetched_keys: set[str] = set()
        wait_deadline = time.monotonic() + self.REALTIME_QUOTE_FLIGHT_WAIT_SECONDS
        due_codes: List[str] = []

        while requested:
            with self._quote_condition:
                now_monotonic = time.monotonic()
                due_codes = []
                for code, key in requested:
                    cached = self._quote_cache.get(key)
                    failure = self._quote_failures.get(key)
                    cache_is_fresh = (
                        cached is not None
                        and now_monotonic - cached.cached_at_monotonic
                        < self.REALTIME_QUOTE_CACHE_TTL_SECONDS
                    )
                    retry_is_deferred = (
                        failure is not None
                        and now_monotonic < failure.next_retry_monotonic
                    )
                    if not cache_is_fresh and not retry_is_deferred:
                        due_codes.append(code)

                if not due_codes:
                    break
                if not self._quote_fetch_in_progress:
                    self.__class__._quote_fetch_in_progress = True
                    break

                remaining = wait_deadline - now_monotonic
                if remaining <= 0:
                    logger.warning(
                        "实时行情共享请求等待超时，返回现有缓存: codes=%s",
                        due_codes,
                    )
                    due_codes = []
                    break
                self._quote_condition.wait(timeout=remaining)

        if due_codes:
            quotes: Dict[str, Any] = {}
            fetch_error: Optional[Exception] = None
            try:
                manager = DataFetcherManager()
                quotes = manager.get_realtime_quotes(due_codes, fallback_missing=False)
            except Exception as exc:  # Provider errors degrade to stale cached values.
                fetch_error = exc
                logger.warning(
                    "批量实时行情源请求失败，将按代码退避重试: codes=%s error=%s",
                    due_codes,
                    exc,
                )
            finally:
                with self._quote_condition:
                    now_monotonic = time.monotonic()
                    now = datetime.now().astimezone()
                    for code in due_codes:
                        key = code.upper()
                        quote = quotes.get(code) or quotes.get(key)
                        if quote is not None:
                            success_at = now.isoformat()
                            self._quote_cache[key] = _CachedRealtimeQuote(
                                quote=quote,
                                cached_at_monotonic=now_monotonic,
                                last_success_at=success_at,
                            )
                            self._quote_failures.pop(key, None)
                            fetched_keys.add(key)
                            continue

                        previous = self._quote_failures.get(key)
                        failure_count = (previous.count if previous else 0) + 1
                        delay = self.REALTIME_QUOTE_RETRY_BACKOFF_SECONDS[
                            min(failure_count - 1, len(self.REALTIME_QUOTE_RETRY_BACKOFF_SECONDS) - 1)
                        ]
                        self._quote_failures[key] = _RealtimeQuoteFailure(
                            count=failure_count,
                            next_retry_monotonic=now_monotonic + delay,
                            next_retry_at=(now + timedelta(seconds=delay)).isoformat(),
                        )
                    self.__class__._quote_fetch_in_progress = False
                    self._quote_condition.notify_all()

            if fetch_error is None:
                missing = [code for code in due_codes if code.upper() not in fetched_keys]
                if missing:
                    logger.warning("批量实时行情部分缺失，将定向退避重试: codes=%s", missing)

        return self._build_realtime_quote_response(requested, fetched_keys)

    def _build_realtime_quote_response(
        self,
        requested: List[tuple[str, str]],
        fetched_keys: set[str],
    ) -> Dict[str, Any]:
        items: List[Dict[str, Any]] = []
        failed_codes: List[str] = []
        now_monotonic = time.monotonic()
        with self._quote_condition:
            for code, key in requested:
                cached = self._quote_cache.get(key)
                failure = self._quote_failures.get(key)
                if failure is not None:
                    failed_codes.append(code)
                if cached is None:
                    if code not in failed_codes:
                        failed_codes.append(code)
                    continue

                cache_age = max(0.0, now_monotonic - cached.cached_at_monotonic)
                provider_stale = bool(getattr(cached.quote, "is_stale", False))
                is_stale = provider_stale or failure is not None
                refresh_status = (
                    "stale" if is_stale else "fresh" if key in fetched_keys else "cached"
                )
                items.append(self._quote_to_dict(
                    cached.quote,
                    code,
                    last_success_at=cached.last_success_at,
                    cache_age_seconds=cache_age,
                    refresh_status=refresh_status,
                    failure=failure,
                    force_stale=is_stale,
                ))

        return {
            "items": items,
            "failed_codes": failed_codes,
            "update_time": datetime.now().astimezone().isoformat(),
        }

    @classmethod
    def _reset_realtime_quote_state_for_tests(cls) -> None:
        """Clear process-wide quote state for deterministic tests."""
        with cls._quote_condition:
            cls._quote_cache.clear()
            cls._quote_failures.clear()
            cls._quote_fetch_in_progress = False
            cls._quote_condition.notify_all()

    @staticmethod
    def _quote_to_dict(
        quote: Any,
        stock_code: str,
        *,
        last_success_at: Optional[str] = None,
        cache_age_seconds: Optional[float] = None,
        refresh_status: str = "fresh",
        failure: Optional[_RealtimeQuoteFailure] = None,
        force_stale: bool = False,
    ) -> Dict[str, Any]:
        def serialize(value: Any) -> Any:
            if isinstance(value, Enum):
                return value.value
            if isinstance(value, datetime):
                return value.astimezone().isoformat()
            return value

        source = serialize(getattr(quote, "source", None))
        fetched_at = serialize(getattr(quote, "fetched_at", None))
        provider_timestamp = serialize(getattr(quote, "provider_timestamp", None))
        provider_stale_seconds = getattr(quote, "stale_seconds", None)
        stale_seconds = provider_stale_seconds if provider_stale_seconds is not None else cache_age_seconds
        if force_stale and cache_age_seconds is not None:
            stale_seconds = max(float(stale_seconds or 0.0), cache_age_seconds)
        return {
            "stock_code": getattr(quote, "code", stock_code),
            "stock_name": getattr(quote, "name", None),
            "current_price": getattr(quote, "price", 0.0) or 0.0,
            "change": getattr(quote, "change_amount", None),
            "change_percent": getattr(quote, "change_pct", None),
            "open": getattr(quote, "open_price", None),
            "high": getattr(quote, "high", None),
            "low": getattr(quote, "low", None),
            "prev_close": getattr(quote, "pre_close", None),
            "volume": getattr(quote, "volume", None),
            "amount": getattr(quote, "amount", None),
            "update_time": fetched_at or datetime.now().astimezone().isoformat(),
            "source": source,
            "provider_timestamp": provider_timestamp,
            "fetched_at": fetched_at,
            "last_success_at": last_success_at or fetched_at,
            "is_stale": force_stale or bool(getattr(quote, "is_stale", False)),
            "stale_seconds": stale_seconds,
            "refresh_status": refresh_status,
            "failure_count": failure.count if failure else 0,
            "next_retry_at": failure.next_retry_at if failure else None,
        }
    
    def get_history_data(
        self,
        stock_code: str,
        period: str = "daily",
        days: int = 30
    ) -> Dict[str, Any]:
        """
        获取股票历史行情
        
        Args:
            stock_code: 股票代码
            period: K 线周期 (daily/weekly/monthly)
            days: 获取天数
            
        Returns:
            历史行情数据字典
            
        Raises:
            ValueError: 当 period 不是 daily 时抛出（weekly/monthly 暂未实现）
        """
        # 验证 period 参数，只支持 daily
        if period != "daily":
            raise ValueError(
                f"暂不支持 '{period}' 周期，目前仅支持 'daily'。"
                "weekly/monthly 聚合功能将在后续版本实现。"
            )
        
        try:
            # 调用数据获取器获取历史数据
            from data_provider.base import DataFetcherManager
            
            manager = DataFetcherManager()
            df, source = manager.get_daily_data(stock_code, days=days)
            
            if df is None or df.empty:
                logger.warning(f"获取 {stock_code} 历史数据失败")
                return {"stock_code": stock_code, "period": period, "data": []}
            
            # 获取股票名称
            stock_name = manager.get_stock_name(stock_code)
            
            # 转换为响应格式
            data = []
            for _, row in df.iterrows():
                date_val = row.get("date")
                if hasattr(date_val, "strftime"):
                    date_str = date_val.strftime("%Y-%m-%d")
                else:
                    date_str = str(date_val)
                
                data.append({
                    "date": date_str,
                    "open": float(row.get("open", 0)),
                    "high": float(row.get("high", 0)),
                    "low": float(row.get("low", 0)),
                    "close": float(row.get("close", 0)),
                    "volume": float(row.get("volume", 0)) if row.get("volume") else None,
                    "amount": float(row.get("amount", 0)) if row.get("amount") else None,
                    "change_percent": float(row.get("pct_chg", 0)) if row.get("pct_chg") else None,
                })
            
            return {
                "stock_code": stock_code,
                "stock_name": stock_name,
                "period": period,
                "data": data,
            }
            
        except ImportError:
            logger.warning("DataFetcherManager 未找到，返回空数据")
            return {"stock_code": stock_code, "period": period, "data": []}
        except Exception as e:
            logger.error(f"获取历史数据失败: {e}", exc_info=True)
            return {"stock_code": stock_code, "period": period, "data": []}
    
    def _get_placeholder_quote(self, stock_code: str) -> Dict[str, Any]:
        """
        获取占位行情数据（用于测试）
        
        Args:
            stock_code: 股票代码
            
        Returns:
            占位行情数据
        """
        return {
            "stock_code": stock_code,
            "stock_name": f"股票{stock_code}",
            "current_price": 0.0,
            "change": None,
            "change_percent": None,
            "open": None,
            "high": None,
            "low": None,
            "prev_close": None,
            "volume": None,
            "amount": None,
            "update_time": datetime.now().isoformat(),
        }
