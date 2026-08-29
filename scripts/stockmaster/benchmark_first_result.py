"""Read-only first-result benchmark helpers and CLI.

The harness intentionally does not submit analysis jobs yet: the parser and
statistics functions are shared by the eventual SSE runner and can be used
against captured streams without touching production data.
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path
from typing import Iterable


def median_ms(samples: Iterable[float]) -> float:
    values = [float(value) for value in samples]
    if not values:
        raise ValueError("at least one timing sample is required")
    return statistics.median(values)


def improvement_pct(baseline_ms: float, candidate_ms: float) -> float:
    if baseline_ms <= 0:
        raise ValueError("baseline_ms must be positive")
    return (baseline_ms - candidate_ms) / baseline_ms * 100.0


def parse_sse_events(chunks: Iterable[str]) -> list[dict[str, object]]:
    """Parse SSE frames from arbitrarily split chunks.

    Comments, malformed JSON frames, and duplicate completion frames are
    ignored. Duplicate suppression is keyed by ``event_id`` when supplied,
    otherwise by completed stock code.
    """

    buffer = ""
    events: list[dict[str, object]] = []
    seen: set[str] = set()
    for chunk in chunks:
        buffer += chunk
        while "\n\n" in buffer:
            frame, buffer = buffer.split("\n\n", 1)
            event_name = "message"
            data_lines: list[str] = []
            for line in frame.splitlines():
                if not line or line.startswith(":"):
                    continue
                if line.startswith("event:"):
                    event_name = line[6:].strip() or "message"
                elif line.startswith("data:"):
                    data_lines.append(line[5:].lstrip())
            if not data_lines:
                continue
            try:
                data = json.loads("\n".join(data_lines))
            except json.JSONDecodeError:
                continue
            if not isinstance(data, dict):
                continue
            if data.get("status") == "completed":
                key = str(data.get("event_id") or data.get("task_id") or data.get("stock_code") or "")
                if key and key in seen:
                    continue
                if key:
                    seen.add(key)
            events.append({"event": event_name, "data": data})
    return events


def build_summary(samples_ms: list[float], *, label: str, codes: list[str]) -> dict[str, object]:
    return {
        "label": label,
        "codes": codes,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "samples_ms": samples_ms,
        "median_ms": median_ms(samples_ms) if samples_ms else None,
        "p25_ms": statistics.quantiles(samples_ms, n=4, method="inclusive")[0] if len(samples_ms) >= 2 else None,
        "p75_ms": statistics.quantiles(samples_ms, n=4, method="inclusive")[2] if len(samples_ms) >= 2 else None,
        "note": "Read-only summary; provide captured SSE timings with --samples.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", default="local")
    parser.add_argument("--codes", default="")
    parser.add_argument("--samples", default="", help="comma-separated completed-result timings in milliseconds")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    samples = [float(item) for item in args.samples.split(",") if item.strip()]
    summary = build_summary(samples, label=args.label, codes=[item.strip() for item in args.codes.split(",") if item.strip()])
    rendered = json.dumps(summary, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
