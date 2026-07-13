# 命理 AI Benchmark（本地参考实现）

`docs/benchmark-mcp-design.md` 的可运行落地：统一题库 + 固定 seed 评测 CLI + 公网评测服务（HTTP + MCP 双协议）。公开入口：<https://bench.sjms.ai>；远程 MCP：<https://bench.sjms.ai/mcp>。

## 快速开始（推荐 MCP）

```bash
# Claude Code
claude mcp add --transport http sjms-benchmark https://bench.sjms.ai/mcp

# Codex
codex mcp add sjms-benchmark --url https://bench.sjms.ai/mcp
```

连接后让智能体依次调用 `register_team → get_exam_paper → submit_answers → get_task`。MCP 只是传输方式：作答过程联网检索选 `online`，不联网检索选 `offline`。

本地复现与 HTTP/离线兼容方式：

```bash
node benchmark/build-data.mjs                 # 构建统一题库 → data/benchmark-v1.json + 质量报告
node benchmark/run.mjs --splits dev,holdout \
  --baselines random,majority,rules,fable5 \
  --seed 42 --k 2                             # 固定seed评测 → results/*.json + 论文表格 *.md
node --test benchmark/tests/*.test.mjs        # 34项测试（schema/切分/评分/反预言机/安全/HTTP/MCP）
node benchmark/server.mjs --port 8787         # 本地参考HTTP服务（OpenAPI见 openapi.yaml）
node benchmark/mcp-adapter.mjs                # MCP stdio 适配层（工具清单与HTTP一一对应）
```

## 数据（v1）

| 切分 | 年份 | 题数（可评分） | 用途 |
|---|---|---|---|
| train | 2010/2011/2017/2018/2020 | 134（64） | 分布先验、规则调参、污染探针语料 |
| dev | 2021–2023 | 120（120） | 公开开发集（gold 可下载） |
| public_test | 2024–2025 | 80（80） | **答案已随赛事公开**，即时揭晓成绩、仅供自查、非官方排名（旧称 holdout；2025 gold 尚未获官方逐题键交叉验证） |

- 金标溯源：2018 官方 8 出题人键；2022/2023/2024 与主办方官方答案键**逐题全吻合**（见 `train-data/official-answer-keys.json`）
- 防泄漏：题面级去重 + 命主聚类（同生辰同性别）强制同切分；构建产物含 `data-quality-report.json`
- 已知缺口：2017 无官方键（unscored）；2020 官方键未获；2012 仅金标无题面；2013-16/19 未入 v1

## 基线

| 基线 | 实现 | 说明 |
|---|---|---|
| random | 均匀乱序（seeded） | 机会水平（4选=25%，5选=20%） |
| majority | train 答案分布 | 分布先验仅来自 train，防泄漏 |
| rules | 历法引擎应期规则 | 流年冲/合日柱加权；缺生辰记录不作答（coverage体现）；论文一已证此类规则信息弱，作为下限 |
| fable5 | 答案文件 `fable5/holdout-answers.json` | ⚠️ 当前文件为**管线演示**：生成会话曾暴露部分金标（文件内含污染声明），成绩无测量意义。干净测量：在全新会话/独立环境中让模型对 `/v1/papers/holdout`（无gold）作答后重生成此文件 |

## 指标

top1 / top-k / Brier / ECE(10-bin) / 命主聚类 bootstrap 95%CI / 配对置换检验（按命主符号翻转）/ 年份×类别切片。全部走固定 seed，可复现。

## 参考服务（云端就绪边界）

- 注册发 key：`POST /v1/apps/register`（online/offline 赛道）
- 领题：`GET /v1/papers/:set`（**永不含 gold**，每应用固定乱序）；dev 可 `GET /v1/datasets/dev` 下载含 gold，public_test/private 下载 403
- 提交：离线答案 `POST /v1/submissions`；托管 endpoint `POST /v1/submissions/endpoint`（服务端分批拉取，30s 超时+单次重试，**推理费用参赛方自付**）
- 治理：dataset_version 锁定（不符 409）、每集配额、每分钟速率限制、重复答案哈希拒绝、审计日志（var/audit.log）、私有集不回逐题对错、联网/非联网分榜
- 远程 MCP（Streamable HTTP）：`https://bench.sjms.ai/mcp`
- MCP 工具：register_team / list_exam_sets / get_exam_paper / submit_answers / get_task / get_leaderboard

## 正式化加固（P0，已落地）

1. **选项确定性重映射**（防背题/位置偏置）：私有集(holdout) 领题时按 `(app,set,record)` 种子重排选项并重写字母，判分时逆映射回原始金标位。背过"第 4 题选 C"失效；公开集(dev) gold 已下发不重排。见 `optionPermutation`。
2. **SSRF 防护**：托管 endpoint 拒绝环回/私网/链路本地（含云元数据 169.254.169.254）/保留段主机，DNS 解析后校验 IP。生产恒开（`allowPrivateEndpoints` 仅测试放行 localhost mock）。见 `assertPublicHost`。
3. **榜单显著性**：每次提交的逐题命中向量服务端私有留存（`getTask` 剥离，绝不下发），榜单对每行给出 `p_vs_top`/`p_vs_prev`（按命主聚类的配对置换检验）。**排名不以点估计定高下**——p≥0.05 即与对照无显著差异。

## 已知局限与待办

- **统计功效结构性受限**：holdout 仅最新两年 80 题（防背题要求），95%CI 宽约 ±11pp；扩大 holdout 只能靠 2026+ 新赛季新题，历史年份入库落 train 无助于 holdout 功效。
- **2019/2020/2017 无官方逐题金标**（公开渠道仅得作答分布/奖表总分），只能作 unscored；未纳入可评分池。
- **私有集尚为空**：holdout 用的是 2024/2025 公开题（答案已上网），真正的抗污染需经知情同意收录的私有命例——冷启动待立项。
- **背题探针未自动化**：设计为对公开年份先跑"只给题不给盘"裸测，裸测显著高于机会水平则判泄漏并降权。
- **版权/伦理**：题面著作权属主办方与出题人、命主为真人含敏感事件——公开部署前需授权、脱敏（出生地）、下架流程、知情同意文书。
- 云端化：存储层换 Firestore、key 人工审核、女巫攻击防护（组织级限额/反馈加噪）、配额限速持久化。
