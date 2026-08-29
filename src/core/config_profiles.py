# -*- coding: utf-8 -*-
"""Small configuration projections derived from the canonical config keys."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple


@dataclass(frozen=True)
class QuickstartField:
    key: str
    default: str
    comment: str


QUICKSTART_FIELDS: Tuple[QuickstartField, ...] = (
    QuickstartField("STOCK_LIST", "600519", "至少填写一只股票；多个代码用英文逗号分隔。"),
    QuickstartField("GENERATION_BACKEND", "litellm", "股票报告沿用默认 LiteLLM 分析链路。"),
    QuickstartField("DEEPSEEK_API_KEY", "", "填写一个可用模型密钥；也可在 StockMaster 设置页配置其他渠道。"),
    QuickstartField("TUSHARE_TOKEN", "", "可选；留空时继续使用现有免费数据源 fallback。"),
    QuickstartField("BOCHA_API_KEYS", "", "可选；中文 A 股新闻搜索首选渠道。"),
    QuickstartField("TAVILY_API_KEYS", "", "可选；新闻搜索备用渠道。"),
    QuickstartField("REPORT_LANGUAGE", "zh", "报告语言。"),
    QuickstartField("CONFIG_VALIDATE_MODE", "warn", "warn 保持兼容；strict 遇到 error 级配置问题时停止启动。"),
)


def render_quickstart_env() -> str:
    lines = [
        "# StockMaster 最小启动配置",
        "# 完整配置仍以 .env.example 和设置页配置注册表为准。",
        "# 复制为 .env 后填写密钥；未配置的可选能力会按原项目策略降级。",
        "",
    ]
    for field in QUICKSTART_FIELDS:
        lines.extend((f"# {field.comment}", f"{field.key}={field.default}", ""))
    return "\n".join(lines).rstrip() + "\n"
