# -*- coding: utf-8 -*-
"""Short-lived prepared analysis context used for LLM-only retries."""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections import OrderedDict
from datetime import date, datetime
from enum import Enum
from pathlib import Path
from typing import Any, Dict, Optional


ANALYSIS_RETRY_CONTEXT_TTL_SECONDS = 30 * 60
ANALYSIS_RETRY_CONTEXT_MAX_ITEMS = 32
logger = logging.getLogger(__name__)


class PreparedAnalysisRetryCache:
    """Keep exact runtime objects briefly so an LLM failure need not refetch data."""

    def __init__(
        self,
        *,
        ttl_seconds: int = ANALYSIS_RETRY_CONTEXT_TTL_SECONDS,
        max_items: int = ANALYSIS_RETRY_CONTEXT_MAX_ITEMS,
        storage_path: Optional[str] = None,
    ) -> None:
        self._ttl_seconds = max(1, int(ttl_seconds))
        self._max_items = max(1, int(max_items))
        self._lock = threading.RLock()
        self._items: "OrderedDict[str, tuple[float, Dict[str, Any]]]" = OrderedDict()
        self._storage_path = storage_path

    def _resolved_storage_path(self) -> Optional[Path]:
        raw = self._storage_path
        if raw is None:
            raw = os.getenv("STOCKMASTER_ANALYSIS_CHECKPOINT_PATH", "").strip()
        return Path(raw) if raw else None

    @classmethod
    def _encode(cls, value: Any) -> Any:
        from data_provider.realtime_types import ChipDistribution, UnifiedRealtimeQuote
        from src.stock_analyzer import TrendAnalysisResult

        if isinstance(value, UnifiedRealtimeQuote):
            return {"__type__": "UnifiedRealtimeQuote", "value": cls._encode(value.to_dict())}
        if isinstance(value, ChipDistribution):
            return {"__type__": "ChipDistribution", "value": cls._encode(value.to_dict())}
        if isinstance(value, TrendAnalysisResult):
            return {"__type__": "TrendAnalysisResult", "value": cls._encode(value.to_dict())}
        if isinstance(value, Enum):
            return value.value
        if isinstance(value, (datetime, date)):
            return value.isoformat()
        if isinstance(value, dict):
            return {str(key): cls._encode(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [cls._encode(item) for item in value]
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if hasattr(value, "to_dict") and callable(value.to_dict):
            return cls._encode(value.to_dict())
        if hasattr(value, "model_dump") and callable(value.model_dump):
            return cls._encode(value.model_dump(mode="json"))
        raise TypeError(f"unsupported checkpoint value: {type(value).__name__}")

    @classmethod
    def _decode(cls, value: Any) -> Any:
        if isinstance(value, list):
            return [cls._decode(item) for item in value]
        if not isinstance(value, dict):
            return value
        type_name = value.get("__type__")
        payload = value.get("value")
        if type_name == "UnifiedRealtimeQuote" and isinstance(payload, dict):
            from data_provider.realtime_types import RealtimeSource, UnifiedRealtimeQuote

            data = dict(payload)
            try:
                data["source"] = RealtimeSource(data.get("source", "fallback"))
            except ValueError:
                data["source"] = RealtimeSource.FALLBACK
            return UnifiedRealtimeQuote(**data)
        if type_name == "ChipDistribution" and isinstance(payload, dict):
            from data_provider.realtime_types import ChipDistribution

            return ChipDistribution(**payload)
        if type_name == "TrendAnalysisResult" and isinstance(payload, dict):
            from src.stock_analyzer import (
                BuySignal,
                MACDStatus,
                RSIStatus,
                TrendAnalysisResult,
                TrendStatus,
                VolumeStatus,
            )

            data = dict(payload)
            enum_fields = {
                "trend_status": TrendStatus,
                "volume_status": VolumeStatus,
                "buy_signal": BuySignal,
                "macd_status": MACDStatus,
                "rsi_status": RSIStatus,
            }
            for field_name, enum_type in enum_fields.items():
                try:
                    data[field_name] = enum_type(data[field_name])
                except (KeyError, ValueError):
                    data.pop(field_name, None)
            data.pop("chart_patterns_score_included", None)
            return TrendAnalysisResult(**data)
        return {key: cls._decode(item) for key, item in value.items()}

    def _read_disk_locked(self) -> Dict[str, Any]:
        path = self._resolved_storage_path()
        if path is None or not path.exists():
            return {}
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            return raw if isinstance(raw, dict) else {}
        except (OSError, ValueError) as exc:
            logger.warning("analysis checkpoint read failed: %s", exc)
            return {}

    def _write_disk_locked(self, items: Dict[str, Any]) -> None:
        path = self._resolved_storage_path()
        if path is None:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(path.suffix + ".tmp")
            temporary.write_text(
                json.dumps(items, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            os.replace(temporary, path)
        except (OSError, TypeError, ValueError) as exc:
            logger.warning("analysis checkpoint write failed: %s", exc)

    def _persist_payload_locked(self, key: str, payload: Dict[str, Any]) -> None:
        if self._resolved_storage_path() is None:
            return
        items = self._read_disk_locked()
        items[key] = {"created_at": time.time(), "payload": self._encode(payload)}
        now = time.time()
        items = {
            item_key: item
            for item_key, item in items.items()
            if isinstance(item, dict)
            and now - float(item.get("created_at", 0)) <= self._ttl_seconds
        }
        if len(items) > self._max_items:
            ordered = sorted(items.items(), key=lambda pair: float(pair[1].get("created_at", 0)))
            items = dict(ordered[-self._max_items :])
        self._write_disk_locked(items)

    @staticmethod
    def _key(code: str) -> str:
        return str(code or "").strip().upper()

    def _prune_locked(self, now: float) -> None:
        expired = [
            key
            for key, (created_at, _payload) in self._items.items()
            if now - created_at > self._ttl_seconds
        ]
        for key in expired:
            self._items.pop(key, None)
        while len(self._items) > self._max_items:
            self._items.popitem(last=False)

    def put(self, code: str, payload: Dict[str, Any]) -> None:
        key = self._key(code)
        if not key:
            return
        with self._lock:
            now = time.monotonic()
            self._prune_locked(now)
            self._items.pop(key, None)
            self._items[key] = (now, dict(payload))
            self._prune_locked(now)
            try:
                self._persist_payload_locked(key, payload)
            except (TypeError, ValueError) as exc:
                logger.warning("analysis checkpoint serialization skipped: %s", exc)

    def get(self, code: str) -> Optional[Dict[str, Any]]:
        key = self._key(code)
        if not key:
            return None
        with self._lock:
            now = time.monotonic()
            self._prune_locked(now)
            item = self._items.get(key)
            if item is None:
                disk_items = self._read_disk_locked()
                disk_item = disk_items.get(key)
                if not isinstance(disk_item, dict):
                    return None
                if time.time() - float(disk_item.get("created_at", 0)) > self._ttl_seconds:
                    disk_items.pop(key, None)
                    self._write_disk_locked(disk_items)
                    return None
                try:
                    payload = self._decode(disk_item.get("payload"))
                except (TypeError, ValueError) as exc:
                    logger.warning("analysis checkpoint decode failed: %s", exc)
                    return None
                if not isinstance(payload, dict):
                    return None
                self._items[key] = (now, payload)
                item = self._items[key]
            self._items.move_to_end(key)
            return dict(item[1])

    def delete(self, code: str) -> None:
        key = self._key(code)
        if not key:
            return
        with self._lock:
            self._items.pop(key, None)
            disk_items = self._read_disk_locked()
            if key in disk_items:
                disk_items.pop(key, None)
                self._write_disk_locked(disk_items)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()
            path = self._resolved_storage_path()
            if path is not None and path.exists():
                try:
                    path.unlink()
                except OSError as exc:
                    logger.warning("analysis checkpoint cleanup failed: %s", exc)


prepared_analysis_retry_cache = PreparedAnalysisRetryCache()
