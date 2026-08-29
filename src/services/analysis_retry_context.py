# -*- coding: utf-8 -*-
"""Short-lived prepared analysis context used for LLM-only retries."""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from typing import Any, Dict, Optional


ANALYSIS_RETRY_CONTEXT_TTL_SECONDS = 30 * 60
ANALYSIS_RETRY_CONTEXT_MAX_ITEMS = 32


class PreparedAnalysisRetryCache:
    """Keep exact runtime objects briefly so an LLM failure need not refetch data."""

    def __init__(
        self,
        *,
        ttl_seconds: int = ANALYSIS_RETRY_CONTEXT_TTL_SECONDS,
        max_items: int = ANALYSIS_RETRY_CONTEXT_MAX_ITEMS,
    ) -> None:
        self._ttl_seconds = max(1, int(ttl_seconds))
        self._max_items = max(1, int(max_items))
        self._lock = threading.RLock()
        self._items: "OrderedDict[str, tuple[float, Dict[str, Any]]]" = OrderedDict()

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

    def get(self, code: str) -> Optional[Dict[str, Any]]:
        key = self._key(code)
        if not key:
            return None
        with self._lock:
            now = time.monotonic()
            self._prune_locked(now)
            item = self._items.get(key)
            if item is None:
                return None
            self._items.move_to_end(key)
            return dict(item[1])

    def delete(self, code: str) -> None:
        key = self._key(code)
        if not key:
            return
        with self._lock:
            self._items.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


prepared_analysis_retry_cache = PreparedAnalysisRetryCache()
