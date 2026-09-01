# Kronos 实验性走势预测

StockMaster 可以在 A 股个股分析完成后调用 Kronos，预测未来若干交易日的 OHLCVA 路径，并在最终报告的“分析要点”和“资讯动态”之间展示。

## 能力边界

- Kronos 优先读取数据库中已经保存的已完成日线；少于 120 根时，仅为预测阶段通过现有日线数据源补取历史数据并回填数据库。该补取发生在最终评分和建议定稿之后，不会改变本轮分析输入。
- 预测在 LLM 输出、原有评分、结构约束、市场阶段护栏和最终操作建议全部定稿后运行。
- 预测结果不进入 LLM Prompt、Analysis Context、评分轨迹、技术评分或操作建议。
- 报告会明确标注“实验性”和“不计入评分”。
- 缺少依赖、历史数据不足、模型权重下载失败或推理失败时，只记录预测状态，股票主分析仍会保存并显示。

这意味着 Kronos 不能被理解为确定性目标价，也不能替代 StockMaster 的原有分析结论。

## 上游同步保护

Kronos 的后端接入路径已登记在 `stockmaster/algorithm-update-policy.json` 的 `strongRequirementPaths`。同步 daily_stock_analysis 时仍会吸收不冲突的算法更新；如果远端改动与这些本地强需求发生真实冲突，候选运行时保留完整 StockMaster 文件并记录冲突，不会用远端版本直接覆盖。Web 报告面板、可选依赖文件和本文档本身不属于远端算法同步范围。

## 安装与启用

Kronos 使用 PyTorch，依赖体积较大，因此不加入默认 `requirements.txt`。在运行 StockMaster 的同一个 Python 环境中执行：

```bash
python -m pip install -r requirements-kronos.txt
```

随后在设置页的“实验性预测”中开启 Kronos，或在 `.env` 中配置：

```dotenv
KRONOS_ENABLED=true
KRONOS_MODEL=NeoQuasar/Kronos-small
KRONOS_TOKENIZER=NeoQuasar/Kronos-Tokenizer-base
KRONOS_LOOKBACK=400
KRONOS_PRED_LEN=5
KRONOS_SAMPLE_COUNT=5
KRONOS_DEVICE=auto
KRONOS_NEUTRAL_BAND_PCT=1.0
```

首次预测会从 Hugging Face 下载模型和 tokenizer 权重，耗时取决于网络和设备。后续会使用本机 Hugging Face 缓存，并在当前后端进程内复用已经加载的模型。

## 配置建议

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `KRONOS_ENABLED` | `false` | 总开关，默认关闭以保持现有性能和行为 |
| `KRONOS_MODEL` | `NeoQuasar/Kronos-small` | 模型权重 ID |
| `KRONOS_TOKENIZER` | `NeoQuasar/Kronos-Tokenizer-base` | tokenizer 权重 ID |
| `KRONOS_LOOKBACK` | `400` | 输入已完成日线数量，范围 120 到 512 |
| `KRONOS_PRED_LEN` | `5` | 未来 A 股交易日数量，范围 1 到 20 |
| `KRONOS_SAMPLE_COUNT` | `5` | 内部采样并平均的路径数量；越高越慢 |
| `KRONOS_DEVICE` | `auto` | 自动选择 CUDA 或 CPU，也可显式指定 |
| `KRONOS_NEUTRAL_BAND_PCT` | `1.0` | 仅用于预测面板的方向标签 |

## 来源与许可

模型实现来自 [shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos)，固定到 revision `67b630e67f6a18c9e9be918d9b4337c960db1e9a`。MIT 许可和来源记录保存在 `src/vendor/kronos/`。模型权重由配置的 Hugging Face 仓库提供。
