# -*- coding: utf-8 -*-
"""Small, fail-open session cache for public data-provider responses.

The cache lives beside the configured database so desktop runtimes keep it in
their own writable data directory.  A session follows the latest weekday: a
Friday cache remains valid through the weekend and is refreshed on Monday.
"""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional


_CACHE_SCHEMA = 1
_WRITE_LOCK = threading.RLock()


def effective_session_date(value: Optional[date] = None) -> date:
    """Return the latest weekday without requiring a remote calendar call."""
    current = value or date.today()
    while current.weekday() >= 5:
        current -= timedelta(days=1)
    return current


def _cache_root() -> Path:
    database_path = Path(os.getenv("DATABASE_PATH", "./data/stock_analysis.db")).expanduser()
    if not database_path.is_absolute():
        database_path = Path.cwd() / database_path
    return database_path.resolve().parent / "provider_cache"


def _safe_component(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value).strip())
    return normalized[:120] or "default"


def _cache_path(namespace: str, key: str) -> Path:
    return _cache_root() / _safe_component(namespace) / f"{_safe_component(key)}.json"


def read_session_cache(
    namespace: str,
    key: str,
    *,
    session_date: Optional[date] = None,
) -> Optional[Dict[str, Any]]:
    """Read a payload only when it belongs to the current effective session."""
    path = _cache_path(namespace, key)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(raw, dict) or raw.get("schema") != _CACHE_SCHEMA:
        return None
    expected = effective_session_date(session_date).isoformat()
    if raw.get("session_date") != expected:
        return None
    payload = raw.get("payload")
    return payload if isinstance(payload, dict) else None


def write_session_cache(
    namespace: str,
    key: str,
    payload: Dict[str, Any],
    *,
    session_date: Optional[date] = None,
) -> bool:
    """Atomically persist a JSON-compatible provider payload."""
    if not isinstance(payload, dict):
        return False
    path = _cache_path(namespace, key)
    envelope = {
        "schema": _CACHE_SCHEMA,
        "session_date": effective_session_date(session_date).isoformat(),
        "written_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "payload": payload,
    }
    temp_path = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        with _WRITE_LOCK:
            path.parent.mkdir(parents=True, exist_ok=True)
            temp_path.write_text(
                json.dumps(envelope, ensure_ascii=False, separators=(",", ":"), default=str),
                encoding="utf-8",
            )
            os.replace(temp_path, path)
        return True
    except OSError:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        return False
