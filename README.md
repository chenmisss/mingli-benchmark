# 命理 AI 评测台（Mingli Benchmark）

一个**开放、可复现**的命理 AI 评测基准：让不同命理 AI 系统在同题、同规则、可复现的条件下答有标准答案的选择题，用数据回答"AI 算命到底靠不靠谱"。

> ⚠️ 定位：本项目测量的是**特定赛事选择题上的作答表现**，不是命理学的科学有效性，也不是现实咨询效果。当前为**本地参考原型**，正式私有题集仍为空，尚不能产生官方认证排名。全部结论按**探索性证据**解读。

## 这里有什么

| 目录 | 内容 |
|---|---|
| [`docs/benchmark-whitepaper.md`](docs/benchmark-whitepaper.md) | **技术白皮书**：跨模型遮蔽评测、方法、偏差披露、局限、伦理边界 |
| `docs/study3-protocol.md` · `study3-amendment-1.md` · `study3-human-baseline-sources.md` | 预注册协议、执行偏差修正案、人类成绩溯源档案 |
| `benchmark/` | **评测系统**：统一 schema、评分（top-1 全集/Brier/ECE/命主聚类 CI）、基线、HTTP + MCP 双协议参考服务、31+ 测试 |
| `study3-results/` | 三轨 × 14 臂**冻结结果**（K 码遮蔽） |
| `train-data/` | 公开题库、一手赛会奖表转录、官方答案键 |
| `scripts/benchmark-whitepaper-reanalysis.mjs` | **确定性复算脚本**：从冻结结果重算白皮书每个数字 |

## 复现白皮书的数字

```bash
node scripts/benchmark-whitepaper-reanalysis.mjs   # 从 study3-results/ 冻结数据确定性重算，连续两次输出一致
```

## 跑评测系统 / 参赛

```bash
cd benchmark && npm install && node server.mjs --port 8787   # 本地起参考服务
# 或直接对接在线评测台（见 benchmark/README.md 快速开始）
```
参赛四步：注册取 API key → 领题（永不含答案）→ 离线用你的命理 AI 作答 → 提交，服务端判分。也支持 MCP。完整规范见 [`benchmark/openapi.yaml`](benchmark/openapi.yaml)。

## 主要发现（探索性）

- 在本次 41 命主 / 200 题 / 三个固定模型上，**没有观察到任何流派方法管线稳定超过"仅排盘"对照**；命主级配对区间跨零。
- "只按人口基率作答"的提示控制在本题集显著偏低——但不代表统计学不如命理。
- 与赛事冠军的口径可对齐年份存在观测差距，但冠军是逐年数千人中的极端值，不代表人类平均或能力上限。
- 详见白皮书的完整口径、偏差与局限披露。

## 数据来源与许可

题目、答案、统计来自香港青年术数家协会（hkjfma.org）全球算命师大赛公开资料及 BaziQA 项目，用于非商业评测；详见 [`benchmark/DATA.md`](benchmark/DATA.md)。事实性数据不受版权；命例为匿名案例；主办方/出题人/命主可请求下架。

**许可证待作者确定**（代码与数据条款可能不同）。

## 未部署公网前的阻塞项

见白皮书部署边界一节。私有题集接入、女巫攻击防护、隐私与授权流程等在正式官方榜开放前须完成。
