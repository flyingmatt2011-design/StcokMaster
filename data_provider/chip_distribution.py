# -*- coding: utf-8 -*-
"""基于日线与换手率的本地筹码分布估算。

算法移植并适配自：
https://github.com/jangviktor-web/a-stock-data-quant/blob/master/lib/chip_distribution.py

原实现 Copyright (c) 2026 lao-liu，按 MIT License 发布。StockMaster 在保留
“换手率衰减 + 高斯核”算法的基础上，增加现有 :class:`ChipDistribution` 契约所需
的 70%/90% 成本区间与集中度计算；不参与也不修改上层评分公式。

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Optional


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def _cost_center(bar: Dict[str, Any], low: float, high: float) -> float:
    volume = _safe_float(bar.get("volume"))
    amount = _safe_float(bar.get("amount"))
    if volume > 0 and amount > 0:
        return _clamp(amount / volume, low, high)

    close = _safe_float(bar.get("close"), (low + high) / 2)
    return _clamp((low + high + close) / 3, low, high)


def _add_chip_kernel(
    distribution: List[float],
    *,
    volume: float,
    center: float,
    low: float,
    high: float,
    min_price: float,
    bin_width: float,
) -> None:
    """按高斯核将当日成交量分配到价格区间。"""
    if volume <= 0:
        return

    sigma = max((high - low) / 4, bin_width / 2)
    weights: List[float] = []
    for index in range(len(distribution)):
        price = min_price + (index + 0.5) * bin_width
        distance = (price - center) / sigma
        weights.append(math.exp(-0.5 * distance * distance))

    weight_sum = sum(weights)
    if weight_sum <= 0:
        return
    scale = volume / weight_sum
    for index, weight in enumerate(weights):
        distribution[index] += weight * scale


def _weighted_percentile_price(items: List[Dict[str, float]], percentile: float) -> float:
    target = _clamp(percentile, 0.0, 1.0)
    cumulative = 0.0
    for item in items:
        cumulative += item["ratio"]
        if cumulative >= target:
            return item["price"]
    return items[-1]["price"] if items else 0.0


def _concentration(low: float, high: float) -> float:
    denominator = low + high
    if low <= 0 or high <= 0 or denominator <= 0:
        return 0.0
    return max(0.0, (high - low) / denominator)


def calculate_chip_distribution(
    klines: Iterable[Dict[str, Any]],
    *,
    bins: int = 80,
) -> Optional[Dict[str, Any]]:
    """根据按日期升序的日线计算筹码分布。

    ``turnover`` 使用百分数语义，例如 ``1.25`` 表示换手率 1.25%。输入必须至少
    有两个有效交易日，且至少一个交易日包含正换手率；否则无法执行换手衰减，
    返回 ``None`` 让上层继续使用其他数据源。
    """
    valid_bars: List[Dict[str, Any]] = []
    for raw_bar in klines:
        low = _safe_float(raw_bar.get("low"))
        high = _safe_float(raw_bar.get("high"))
        close = _safe_float(raw_bar.get("close"))
        volume = _safe_float(raw_bar.get("volume"))
        if low <= 0 or high < low or close <= 0 or volume <= 0:
            continue
        valid_bars.append(dict(raw_bar))

    if len(valid_bars) < 2:
        return None

    positive_turnover_count = sum(
        1 for bar in valid_bars if _safe_float(bar.get("turnover")) > 0
    )
    if positive_turnover_count == 0:
        return None

    bin_count = max(10, min(int(bins), 300))
    min_price = min(_safe_float(bar["low"]) for bar in valid_bars)
    max_price = max(_safe_float(bar["high"]) for bar in valid_bars)
    if min_price <= 0 or max_price <= min_price:
        return None

    bin_width = (max_price - min_price) / bin_count
    distribution = [0.0] * bin_count

    for bar in valid_bars:
        low = _safe_float(bar["low"])
        high = _safe_float(bar["high"])
        turnover = _clamp(_safe_float(bar.get("turnover")) / 100, 0.0, 0.98)
        retention = 1 - turnover
        for index in range(bin_count):
            distribution[index] *= retention

        _add_chip_kernel(
            distribution,
            volume=_safe_float(bar.get("volume")),
            center=_cost_center(bar, low, high),
            low=low,
            high=high,
            min_price=min_price,
            bin_width=bin_width,
        )

    total_volume = sum(distribution)
    if total_volume <= 0:
        return None

    items: List[Dict[str, float]] = []
    for index, volume in enumerate(distribution):
        price = min_price + (index + 0.5) * bin_width
        items.append({"price": price, "volume": volume, "ratio": volume / total_volume})

    current_price = _safe_float(valid_bars[-1].get("close"))
    avg_cost = sum(item["price"] * item["ratio"] for item in items)
    profit_ratio = sum(item["ratio"] for item in items if item["price"] <= current_price)

    cost_90_low = _weighted_percentile_price(items, 0.05)
    cost_90_high = _weighted_percentile_price(items, 0.95)
    cost_70_low = _weighted_percentile_price(items, 0.15)
    cost_70_high = _weighted_percentile_price(items, 0.85)
    top_bins = sorted(items, key=lambda item: item["volume"], reverse=True)[:5]

    return {
        "date": str(valid_bars[-1].get("date") or ""),
        "days": len(valid_bars),
        "bins": bin_count,
        "current": current_price,
        "avg_cost": avg_cost,
        "profit_ratio": _clamp(profit_ratio, 0.0, 1.0),
        "min_price": min_price,
        "max_price": max_price,
        "sum_vol": total_volume,
        "items": items,
        "top_concentration": sum(item["ratio"] for item in top_bins),
        "top_bins": top_bins,
        "cost_90_low": cost_90_low,
        "cost_90_high": cost_90_high,
        "concentration_90": _concentration(cost_90_low, cost_90_high),
        "cost_70_low": cost_70_low,
        "cost_70_high": cost_70_high,
        "concentration_70": _concentration(cost_70_low, cost_70_high),
        "turnover_coverage": positive_turnover_count / len(valid_bars),
    }
