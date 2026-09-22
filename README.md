# pi-tavily-extension

[Pi](https://github.com/earendil-works/pi) 编码助手的 Tavily 联网扩展：为 AI 装上实时搜索、网页提取、站点探测/爬取和深度研究能力。开箱即用、按积分计费、多 Key 自动轮询。

## 特性

- **5 个工具**：`tavily_search` / `tavily_extract` / `tavily_map` / `tavily_crawl` / `tavily_research`，由模型按需自动调用，并通过 `promptSnippet` / `promptGuidelines` 引导选型
- **多 API Key 轮询 + 故障转移**：429 限流自动切换 Key，积分用尽（432）的 Key 当月自动跳过，任务不中断
- **上下文保护**：超大结果自动截断，全文写入临时文件并把路径附在结果里，AI 可用 read 工具按需读回，内容不丢失
- **实时进度**：research 流式输出研究过程，Esc 可随时中断并保留已产生的部分结果
- **中文错误信息**：附带 `request_id`，便于向 Tavily 客服排查

## 环境要求

- pi >= 0.86（开发与测试基于 0.87.0）
- 至少一个 Tavily API Key（[免费额度 1000 积分/月](https://tavily.com)）

## 安装

```bash
# Linux / macOS / WSL
git clone https://github.com/lin200083/pi-tavily-extension.git ~/.pi/agent/extensions/tavily
```

```powershell
# Windows（PowerShell）
git clone https://github.com/lin200083/pi-tavily-extension.git $env:USERPROFILE\.pi\agent\extensions\tavily
```

将仓库克隆到 `~/.pi/agent/extensions/tavily` 后，**重启 pi 即自动加载**（或运行 `/reload`）。运行时无需 `npm install`——`@earendil-works/*` 依赖由 pi 内置解析，装依赖只是为了本地类型检查。

## 快速开始

1. 把目录下的 `config.example.json` 复制为 `config.json`，在 `apiKeys` 数组中填入你的 Tavily Key（支持多个，自动轮询）
2. 重启 pi，直接提问即可，模型会自动挑选合适的工具

> ⚠️ **安全提示**：`config.json` 含有 API 密钥，已被 `.gitignore` 排除，**切勿提交或分享该文件**。

## 工具

| 工具 | 能力 | 计费参考 |
|------|------|---------|
| `tavily_search` | 网页/新闻/财经搜索，带相关度评分与 AI 摘要 | **advanced 2 积分/次（默认）**；basic / fast / ultra-fast 各 1 积分/次 |
| `tavily_extract` | 从 URL 提取干净正文（markdown/text，支持按意图重排） | 1 积分/5 URL（basic）；advanced 2 积分/5 URL，失败不计费 |
| `tavily_map` | 探测网站结构，返回 URL 清单 | 1 积分/10 页；带 instructions 2 积分/10 页 |
| `tavily_crawl` | 整站爬取+内容提取（支持语义指令、路径过滤） | = mapping + extraction 之和（basic 爬 10 页 ≈ 3 积分） |
| `tavily_research` | 深度研究：多轮搜索+交叉验证+带引用报告（实时进度） | pro 15–250 积分/次（默认）；mini 4–110 |

## 配置 API Key

编辑 `config.json`（本目录下）：

```json
{
  "apiKeys": [
    "tvly-xxx-key-1",
    "tvly-xxx-key-2",
    "tvly-xxx-key-3"
  ],
  "projectId": "pi-agent"
}
```

- **支持多个 Key**：自动轮询使用（round-robin），单个 Key 触发限流（429）或积分用尽（432）时自动切换，任务不中断。
- 积分用尽的 Key 会被临时跳过，**次月 1 号自动恢复**。
- 免费账号每个 Key 每月 1000 积分，多个 Key 叠加使用。
- `projectId` 可选：用于在 Tavily 后台按项目追踪用量（`X-Project-ID` 请求头）。
- 首次启动若目录下没有配置文件，会生成 `config.example.json` 模板，**把它复制为 `config.json` 再填 Key**。

### 可选默认值

下面是各配置项的**默认值**（可直接照抄）；可选项见下表。

```json
{
  "apiKeys": ["tvly-..."],
  "projectId": "pi-agent",
  "defaultSearchDepth": "advanced",
  "defaultMaxResults": 5,
  "defaultResearchModel": "pro"
}
```

| 配置项 | 取值 | 说明 |
| --- | --- | --- |
| `defaultSearchDepth` | `advanced`(默认) / `basic` / `fast` / `ultra-fast` | `advanced` 2 积分/次，内容量最大（实测约为 `basic` 的 4.5 倍）；`basic`/`fast`/`ultra-fast` 1 积分/次。Tavily 官方 agent 指南推荐 `advanced`。 |
| `defaultMaxResults` | 0-20，默认 5 | 官方建议：聚焦答案用 5，广泛调研用 10。 |
| `defaultResearchModel` | `pro`(默认) / `mini` / `auto` | 单次任务积分区间：pro 15-250、mini 4-110、auto 由服务端挑选。pro 是多代理深度研究。 |

### 限流（官方数据）

| 端点 | 开发 Key | 生产 Key |
| --- | --- | --- |
| 常规（search/extract/map） | 100 RPM | 1000 RPM |
| `/crawl` | 100 RPM | 100 RPM |
| `/research`（创建任务） | 20 RPM | 20 RPM |
| `/usage` | 10 次/10 分钟 | 10 次/10 分钟 |

Key 前缀 `tvly-dev-` 是开发键（100 RPM）。多 Key 轮询可以叠加各 Key 的额度；触发 429 时插件会读 `Retry-After` 并切换 Key。

## 使用

配置好后重启 pi（或 `/reload`），直接提问即可，AI 会自动调用合适的工具：

```
最近一周 AI 行业有什么大新闻？
→ 自动调用 tavily_search (topic=news, time_range=week)

把 https://docs.tavily.com/documentation/api-credits 的内容总结一下
→ 自动调用 tavily_extract

调研一下 2026 年 AI 编码助手的竞争格局，出一份带引用的报告
→ 自动调用 tavily_research（进度实时显示，可 Esc 中断）

爬取某个文档站的全部页面
→ 自动调用 tavily_crawl
```

## 机制说明

- 每次请求自动携带 `X-Session-Id`（按 pi 会话分组，方便在 Tavily 后台追溯）。
- 429 限流：多 Key 时立即切换；单 Key 时按 `retry-after` 等待后重试。research 流式在**收到任何 SSE 数据之前**同样会按 432/429 切换 Key，一旦开始收流则不再重试（长连接无法在另一个 Key 上重放）。
- 非流式请求带有客户端超时（search/research 60s；extract/map/crawl 取服务端 timeout +5s），挂起时会明确报错而不会一直卡住；超时不会切换到其他 Key。按 Esc 始终原样中断。
- 错误信息为中文并附 `request_id`，方便联系 Tavily 客服排查。
- research 支持附加本地文件（`files` 参数，.txt/.md/.json，最多 5 个）——AI 会结合你的文件+网络资料做研究。
- research 流式模式超时/断流时不再丢弃全部结果：已收到的报告片段与来源会以「⚠ 部分结果」形式回收（实测断开后服务端会取消任务，无法事后轮询取回，部分结果是唯一可挽回的产出）。任务真实 ID 取自响应头 `x-request-id`（流事件里的 id 是分块序号，不可用于查询）。
- 所有请求可被 Esc 中断（`AbortSignal`）。
- **`tavily_search` 默认 `search_depth=advanced`（2 积分/次）**，与 Tavily 官方 agent 指南一致；想省积分就在 `config.json` 里把 `defaultSearchDepth` 改成 `basic`（1 积分/次），模型也可以在单次调用时显式传 `search_depth` 覆盖。
- search 支持按发布日期过滤（`include_published_date` / `filter_by_published_date`）、域名偏好模式（`include_domains_mode`）、语言提升与硬过滤（`language` / `filter_by_language`）以及 `safe_search`。
- **输出截断保护**：单次工具结果超过 50KB / 2000 行时，发送给 LLM 的内容只保留最前面的部分，完整原文会写入系统临时目录（如 `%TEMP%/pi-tavily-crawl-*.md`），并把文件路径附在结果末尾——AI 需要更多细节时会用 read 工具按 offset/limit 自行取回，内容不会丢失。TUI 摘要行会显示「输出已截断」提示。
  - 文件名含 pid + 随机后缀，避免 pi 并行执行工具时互相覆盖。
  - 若内容含超长行（例如整页被压缩成一行），按行截断会把它整行丢掉，此时退化为按字符硬切开头，保证 AI 至少看得到内容。
  - 退出 pi 时清理本次产生的文件；`/reload` 或切换会话时保留（转录里可能还要引用）；启动时会顺手清掉 24 小时前的残留文件。

## 文件结构

```
tavily/
├── index.ts            # 入口：注册 5 个工具
├── client.ts           # API 客户端：多 Key 轮询、故障转移、超时、错误处理
├── research.ts         # 深度研究：轮询 + SSE 实时进度 + 本地文件
├── config.ts           # 配置读取
├── types.ts            # 类型定义
├── config.example.json # 配置模板（复制为 config.json 使用）
├── config.json         # API Key 配置（含密钥，已被 .gitignore 排除）
├── README.md           # 本文档
└── tsconfig.json       # 类型检查配置（需先 npm install）
```

## 开发

```bash
npm install        # 仅为类型检查所需；pi 运行时不依赖 node_modules
npx tsc --noEmit   # 类型检查
```

## 常见问题

- **提示"未配置 API Key"**：检查 `config.json` 是否存在且 `apiKeys` 数组非空。
- **提示积分用尽（432）**：该 Key 本月额度已用完，添加新 Key 或等下月。
- **报错带 `request_id`**：可凭此 ID 联系 support@tavily.com 排查。
