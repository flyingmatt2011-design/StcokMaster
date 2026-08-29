# -*- coding: utf-8 -*-
"""LiteLLM generation backend wrapper."""

from __future__ import annotations

import logging
import threading
import time
from contextlib import contextmanager
from typing import Any, Callable, Dict, Optional, Tuple

from src.llm.generation_backend import (
    GenerationBackend,
    GenerationCapabilities,
    GenerationResult,
)


LiteLLMCallable = Callable[..., Tuple[str, str, Dict[str, Any]]]
logger = logging.getLogger(__name__)


class _GenerationConcurrencyGate:
    """Process-wide gate shared by all per-task LiteLLM backend instances."""

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._active = 0

    @contextmanager
    def slot(self, limit: int):
        normalized_limit = max(1, int(limit or 1))
        wait_started_at = time.monotonic()
        with self._condition:
            while self._active >= normalized_limit:
                self._condition.wait()
            self._active += 1
        waited_ms = int((time.monotonic() - wait_started_at) * 1000)
        if waited_ms >= 100:
            logger.info(
                "[generation_concurrency] backend=litellm waited_ms=%d limit=%d",
                waited_ms,
                normalized_limit,
            )
        try:
            yield
        finally:
            with self._condition:
                self._active = max(0, self._active - 1)
                self._condition.notify_all()


_LITELLM_GENERATION_GATE = _GenerationConcurrencyGate()


def _provider_from_model(model: str) -> str:
    if not model:
        return ""
    if "/" in model:
        return model.split("/", 1)[0]
    return "openai"


class LiteLLMGenerationBackend(GenerationBackend):
    """Thin adapter around the existing LiteLLM analyzer call path."""

    backend_id = "litellm"
    capabilities = GenerationCapabilities(
        supports_json=True,
        supports_tools=True,
        supports_stream=True,
        supports_vision=False,
        supports_health_check=False,
        supports_smoke_test=False,
    )

    def __init__(
        self,
        completion_callable: LiteLLMCallable,
        *,
        max_concurrency: int = 1,
    ):
        self._completion_callable = completion_callable
        try:
            self._max_concurrency = max(1, int(max_concurrency))
        except (TypeError, ValueError):
            self._max_concurrency = 1

    def generate(
        self,
        prompt: str,
        generation_config: Dict[str, Any],
        *,
        system_prompt: Optional[str] = None,
        stream: bool = False,
        stream_progress_callback: Optional[Callable[[int], None]] = None,
        response_validator: Optional[Callable[[str], None]] = None,
        audit_context: Optional[Dict[str, Any]] = None,
    ) -> GenerationResult:
        with _LITELLM_GENERATION_GATE.slot(self._max_concurrency):
            text, model, usage = self._completion_callable(
                prompt,
                generation_config,
                system_prompt=system_prompt,
                stream=stream,
                stream_progress_callback=stream_progress_callback,
                response_validator=response_validator,
                audit_context=audit_context,
            )
        provider = str((usage or {}).get("provider") or _provider_from_model(model))
        return GenerationResult(
            text=text,
            model=model,
            provider=provider,
            backend=self.backend_id,
            usage=usage or {},
            raw=None,
            diagnostics={},
        )
