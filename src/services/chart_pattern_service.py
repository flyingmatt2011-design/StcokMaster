# -*- coding: utf-8 -*-
"""Deterministic, context-only chart-pattern recognition.

The ZigZag/pattern approach is adapted from
``a-stock-data-quant/lib/patterns.py`` (MIT License,
Copyright (c) 2026 lao-liu).  Results are descriptive evidence only and are
deliberately excluded from StockMaster's existing signal score.
"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence, Tuple

import numpy as np
import pandas as pd


def _pivot_points(values: Sequence[float], step: int = 3) -> List[Tuple[int, int, float]]:
    prices = np.asarray(values, dtype=float)
    if len(prices) < step * 2 + 1:
        return []
    candidates: List[Tuple[int, int, float]] = []
    for index in range(step, len(prices) - step):
        window = prices[index - step:index + step + 1]
        price = float(prices[index])
        pivot_type = 1 if price >= float(np.max(window)) else -1 if price <= float(np.min(window)) else 0
        if not pivot_type:
            continue
        if candidates and candidates[-1][1] == pivot_type:
            previous = candidates[-1]
            if (pivot_type == 1 and price > previous[2]) or (pivot_type == -1 and price < previous[2]):
                candidates[-1] = (index, pivot_type, price)
            continue
        candidates.append((index, pivot_type, price))
    return candidates


def _near(left: float, right: float, tolerance: float = 0.06) -> bool:
    return right > 0 and abs(left - right) / right <= tolerance


def _date_at(frame: pd.DataFrame, index: int) -> str:
    if "date" not in frame.columns or index >= len(frame):
        return ""
    return str(frame.iloc[index].get("date") or "")[:10]


def _volume_confirmation(frame: pd.DataFrame, breakout_index: int) -> Dict[str, Any]:
    if "volume" not in frame.columns or breakout_index < 0 or breakout_index >= len(frame):
        return {"available": False, "confirmed": False, "ratio": None}
    volume = pd.to_numeric(frame["volume"], errors="coerce")
    start = max(0, breakout_index - 20)
    baseline = volume.iloc[start:breakout_index].dropna()
    current = volume.iloc[breakout_index]
    if baseline.empty or pd.isna(current) or float(baseline.mean()) <= 0:
        return {"available": False, "confirmed": False, "ratio": None}
    ratio = float(current) / float(baseline.mean())
    return {"available": True, "confirmed": ratio >= 1.2, "ratio": round(ratio, 2)}


def analyze_chart_patterns(frame: pd.DataFrame, *, step: int = 3) -> Dict[str, Any]:
    """Return recent deterministic patterns without producing a trade score."""
    if frame is None or frame.empty or "close" not in frame.columns or len(frame) < 20:
        return {"status": "insufficient_data", "patterns": [], "summary": "形态样本不足"}
    ordered = frame.sort_values("date").reset_index(drop=True) if "date" in frame.columns else frame.reset_index(drop=True)
    close = pd.to_numeric(ordered["close"], errors="coerce")
    valid = close.notna() & (close > 0)
    ordered = ordered.loc[valid].reset_index(drop=True)
    close = pd.to_numeric(ordered["close"], errors="coerce")
    if len(close) < 20:
        return {"status": "insufficient_data", "patterns": [], "summary": "形态样本不足"}

    pivots = _pivot_points(close.tolist(), step=step)
    patterns: List[Dict[str, Any]] = []

    for first, middle, second in zip(pivots, pivots[1:], pivots[2:]):
        a, a_type, a_price = first
        b, b_type, b_price = middle
        c, c_type, c_price = second
        if (a_type, b_type, c_type) == (-1, 1, -1) and _near(a_price, c_price):
            depth = (b_price - min(a_price, c_price)) / max(min(a_price, c_price), 1e-9)
            if depth >= 0.05:
                breakout = len(close) - 1
                confirmed = float(close.iloc[-1]) > b_price
                volume = _volume_confirmation(ordered, breakout)
                patterns.append({
                    "type": "w_bottom",
                    "label": "W底",
                    "start_date": _date_at(ordered, a),
                    "end_date": _date_at(ordered, c),
                    "neckline": round(b_price, 4),
                    "depth_pct": round(depth * 100, 2),
                    "status": "confirmed" if confirmed else "forming",
                    "volume_confirmation": volume,
                })
        if (a_type, b_type, c_type) == (1, -1, 1):
            drop = (a_price - b_price) / max(a_price, 1e-9)
            recovery = (c_price - b_price) / max(a_price - b_price, 1e-9)
            down_bars = max(1, b - a)
            up_bars = max(1, c - b)
            if drop >= 0.05 and recovery >= 0.6 and up_bars / down_bars <= 1.2:
                patterns.append({
                    "type": "v_reversal",
                    "label": "V型反转",
                    "start_date": _date_at(ordered, a),
                    "end_date": _date_at(ordered, c),
                    "bottom_price": round(b_price, 4),
                    "drop_pct": round(drop * 100, 2),
                    "recovery_pct": round(recovery * 100, 2),
                    "status": "confirmed",
                    "volume_confirmation": _volume_confirmation(ordered, c),
                })

    for index in range(max(0, len(pivots) - 9), len(pivots) - 4):
        group = pivots[index:index + 5]
        types = tuple(item[1] for item in group)
        prices = [item[2] for item in group]
        if types == (-1, 1, -1, 1, -1):
            bottoms = [prices[0], prices[2], prices[4]]
            if max(bottoms) > 0 and (max(bottoms) - min(bottoms)) / max(bottoms) <= 0.07:
                neckline = min(prices[1], prices[3])
                depth = (neckline - min(bottoms)) / max(min(bottoms), 1e-9)
                if depth >= 0.05:
                    patterns.append({
                        "type": "triple_bottom",
                        "label": "三重底",
                        "start_date": _date_at(ordered, group[0][0]),
                        "end_date": _date_at(ordered, group[-1][0]),
                        "neckline": round(neckline, 4),
                        "depth_pct": round(depth * 100, 2),
                        "status": "confirmed" if float(close.iloc[-1]) > neckline else "forming",
                        "volume_confirmation": _volume_confirmation(ordered, len(close) - 1),
                    })

        # 杯柄：两侧杯沿接近，中间形成足够深的圆弧低点；随后手柄回撤
        # 小于杯深的一半，并由最后一个高点重新靠近/突破杯沿。
        if types == (1, -1, 1, -1, 1):
            left_rim, cup_low, right_rim, handle_low, breakout = prices
            rim = min(left_rim, right_rim)
            cup_depth = (rim - cup_low) / max(rim, 1e-9)
            handle_depth = (right_rim - handle_low) / max(right_rim, 1e-9)
            if (
                _near(left_rim, right_rim, tolerance=0.08)
                and cup_depth >= 0.10
                and 0.0 < handle_depth <= min(0.12, cup_depth * 0.5)
                and breakout >= rim * 0.98
            ):
                patterns.append({
                    "type": "cup_and_handle",
                    "label": "杯柄形态",
                    "start_date": _date_at(ordered, group[0][0]),
                    "end_date": _date_at(ordered, group[-1][0]),
                    "rim_price": round(rim, 4),
                    "cup_depth_pct": round(cup_depth * 100, 2),
                    "handle_depth_pct": round(handle_depth * 100, 2),
                    "status": "confirmed" if float(close.iloc[-1]) >= rim else "forming",
                    "volume_confirmation": _volume_confirmation(ordered, group[-1][0]),
                })

    for first, peak, pullback in zip(pivots, pivots[1:], pivots[2:]):
        if (first[1], peak[1], pullback[1]) != (-1, 1, -1):
            continue
        rise = (peak[2] - first[2]) / max(first[2], 1e-9)
        retrace = (peak[2] - pullback[2]) / max(peak[2] - first[2], 1e-9)
        if rise >= 0.10 and 0.10 <= retrace <= 0.50 and pullback[0] >= len(close) - 20:
            patterns.append({
                "type": "trend_pullback",
                "label": "上涨后回踩",
                "start_date": _date_at(ordered, first[0]),
                "end_date": _date_at(ordered, pullback[0]),
                "support_price": round(pullback[2], 4),
                "rise_pct": round(rise * 100, 2),
                "retrace_ratio": round(retrace, 3),
                "status": "forming",
                "volume_confirmation": _volume_confirmation(ordered, pullback[0]),
            })

    patterns.sort(key=lambda item: item.get("end_date") or "", reverse=True)
    recent = patterns[:4]
    summary = "；".join(
        f"{item['label']}（{'已确认' if item['status'] == 'confirmed' else '形成中'}）"
        for item in recent
    ) or "未识别到满足阈值的典型形态"
    return {
        "status": "ok",
        "method": "zigzag_price_volume_context_only",
        "score_included": False,
        "patterns": recent,
        "summary": summary,
    }
