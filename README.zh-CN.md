# pi 的 Tavily 扩展

[English](README.md) | 简体中文

为 [pi](https://github.com/earendil-works/pi) 提供五个联网工具 —— `tavily_search`、
`tavily_extract`、`tavily_map`、`tavily_crawl`、`tavily_research` —— 支持可选的
单会话积分上限、多密钥故障转移、响应缓存、上下文安全的截断，并完整使用 pi 的
工具契约（声明、guidelines、渲染器、结构化输出、嵌套调用）。每次调用的积分会显示在
TUI 结果行；底部状态栏没有会话花费汇总（原因见[设计取舍](#设计取舍)）。

## 安装

需要支持扩展的 pi（`@earendil-works/pi-coding-agent`）。pi 用 `jiti` 加载 TypeScript，
所以没有构建步骤。

### 方式 A —— clone 到扩展目录（推荐）

```bash
mkdir -p ~/.pi/agent/extensions
git clone https://github.com/lin200083/pi-tavily-extension.git \
  ~/.pi/agent/extensions/tavily

cp ~/.pi/agent/extensions/tavily/config.example.json \
   ~/.pi/agent/extensions/tavily/config.json
# 然后编辑 config.json，填入 apiKeys
```

pi 会自动加载 `~/.pi/agent/extensions/` 下含 `index.ts` 入口的子目录，不需要改动
settings 文件。`config.json` 已被 git 忽略，`git pull` 不会覆盖你的密钥：

```bash
git -C ~/.pi/agent/extensions/tavily pull
```

### 方式 B —— 作为 pi 包安装

```bash
pi install git:github.com/lin200083/pi-tavily-extension
pi list        # 确认来源已写入配置
```

`pi install` 会把来源记录到 `~/.pi/agent/settings.json`；加 `--local` 则写入当前项目的
`.pi/settings.json`。`pi update --extensions` 会重新对齐 checkout，所以请把 `config.json`
放在它的上一级目录（扩展也会向上查找），或在更新后重新复制。

不安装、只试用一次：

```bash
pi -e git:github.com/lin200083/pi-tavily-extension
```

### 两种方式共同的步骤

重启 pi（或执行 `/reload`）。首次启动时，若还没有配置文件，扩展会写出
`config.example.json`；把它复制为 `config.json` 并填入 `apiKeys`。

运行时依赖由 pi 提供（`@earendil-works/*`、`typebox`），没有 `npm install` 步骤。
密钥只从 `config.json` 读取 —— 不支持用环境变量覆盖。

## 配置

`config.json` 位于本目录 —— 已被 git 忽略，仓库只跟踪 `config.example.json`，
真实密钥不会进入仓库。计费相关字段在每次调用时重新读取；工具描述在加载时生成，
所以改动 `defaultSearchDepth` / `defaultResearchModel` 后需要 `/reload`。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `apiKeys` | — | 一个或多个 Tavily 密钥。轮询使用；401/429/432/433 和 5xx 会自动切换到下一个密钥。 |
| `projectId` | — | 作为 `X-Project-ID` 发送（用于控制台归因）。 |
| `humanId` | — | 作为 `X-Human-Id` 发送（由 Tavily 做哈希）。 |
| `defaultSearchDepth` | `advanced` | `advanced` 为 2 积分/次，`basic`/`fast`/`ultra-fast` 为 1 积分/次。 |
| `defaultMaxResults` | `10` | 取值 1–20。 |
| `defaultResearchModel` | `pro` | `pro` 为 15–250 积分/任务，`mini` 为 4–110，`auto` 由服务端决定。 |
| `maxSessionCredits` | `0` | **单会话**硬上限；在 `session_start` 时重置。`0` 表示不限制。估算值是上界，进行中的调用会预留估算额度，缓存命中不计费。 |
| `searchTimeoutMs` | `60000` | 客户端 `/search` 超时时间。 |
| `cacheTtlSeconds` | `300` | 同一会话内相同的 search/extract 在 N 秒内直接复用，不重复计费。`0` 表示关闭。 |

命令行参数 `--tavily-depth basic|advanced|fast|ultra-fast` 可在本次运行中覆盖
`defaultSearchDepth`。在无头模式下，`tavily_research` 会拒绝 `files` 参数，除非传入
`--tavily-allow-file-upload`（内容仍会做凭据扫描）；交互模式会先请求确认。

## 工具

| 工具 | 适用场景 | 备注 |
|---|---|---|
| `tavily_search` | 不知道来源时 | `topic='news'` 仅用于新闻；要时效性请设 `time_range`/日期 |
| `tavily_extract` | 1–20 个已知 URL | 失败的 URL 按条报告，且不计费 |
| `tavily_map` | 不清楚站点结构 | 只返回 URL，不返回页面内容 |
| `tavily_crawl` | 抓取单个站点的多页 | 支持路径/域名正则过滤、`instructions` |
| `tavily_research` | 综述、报告、带引用的对比 | 耗时 30–120s 以上，最贵；`background=true`、`extract_sources=true` 需显式开启 |

## 值得了解的行为

- **预算闸门** —— 每次调用前（包括来自 codemode 的嵌套调用），`tool_call`
  处理器都会检查 `maxSessionCredits` 并预留估算额度，避免并行的调用同时通过剩余
  预算检查。积分在拿到工具结果后记录一次；预算与缓存在 `session_start` 时重置。
  预算耗尽后，缓存命中（0 积分）依然可用。
- **密钥防护** —— 看起来像密钥、token、JWT 或私钥的 query/URL 会在离开本机前被拒绝。
  `research.files` 的内容也会扫描，不只是路径。
- **文件上传确认** —— 交互模式下，带 `files` 的 `tavily_research` 会在把本地文件内容
  发给 Tavily 前询问。无头模式默认拦截，除非传入 `--tavily-allow-file-upload`。
- **响应缓存** —— `cacheTtlSeconds` 内完全相同的 search/extract 调用会立即返回，
  记 0 积分（`details.cached`）。
- **重复标记** —— 真正用 `extract`/`crawl` 抓取过的 URL，在此后的结果里会标记
  `[已在本会话抓取过]`。搜索摘要不会把 URL 标记为已抓取。
- **输出截断** —— 超长输出对模型保留开头，完整文本写入临时文件
  （`details.full_output_path`，用 `read` 配 `offset`/`limit` 读取）。文件仅属主可读，
  退出后保留以便恢复的会话仍能读取，7 天后清理。
- **结构化输出** —— 每个工具都声明 `outputSchema` 并返回 `structuredContent`；
  大体积页面正文在这里也有字节上限（`structured_truncated`）。
- **失败处理** —— 以 `isError: true` 加 `details.status` / `request_id` 返回，而不是抛出异常，
  这样失败元数据不会丢失。
- **图片** —— `media: true` 会把最多 2 张结果图片作为 pi 图片块附加。私有/回环地址的
  图片主机会被拒绝，重定向会重新校验，读取时正文上限 2 MB。
- **后台 research** —— `background: true` 会立即返回，报告完成后作为新消息投递；
  会话关闭时中止。
- **提示词丢失自检** —— 如果自定义系统提示词丢掉了本扩展的 guidelines，
  首次运行时会给出一次警告；无头模式下输出到 stderr。

## 语言策略

工具声明（模型最先读到的部分）用英文。错误信息是中英双语的，因为用户读中文，
而模型和 codemode 脚本通常以英文为先。TUI 文案为中文。

## 设计取舍

- **直接暴露工具。** 五个工具都是直接声明的。改成 `exposure: "codemode"` 并不省 token
  （codemode 会把声明内联，预算 3000 token），反而在模型和一行搜索之间插入了一步写脚本。
- **不用环境变量配置。** 密钥只存在 `config.json`；项目级副本否则就得把密钥放进仓库。
- **不做花费 UI。** 会话花费按会话跟踪，用于 `maxSessionCredits` 闸门，并在
  `session_start` 时重置；每次调用的积分显示在 TUI 结果行，但底栏不渲染任何内容。
  持久账本（`appendEntry`）属于后续工作。
- **`reachesTools` / `prepareLoadout` 未使用。** 它们只对编排其他工具的工具才有意义；
  唯一的嵌套调用（research → extract）是硬编码的，不由模型命名。

## 文件

| 文件 | 作用 |
|---|---|
| `index.ts` | 工具注册、防护、渲染器、会话状态 |
| `client.ts` | HTTP、多密钥故障转移、SSE、错误映射 |
| `research.ts` | 流式/轮询 research、文件附件 |
| `config.ts` | 读取 `config.json` 与默认值 |
| `schemas.ts` | TypeBox 参数与输出 schema |
| `params.ts` | 工具参数 → API 请求体，`dropped` 上报 |
| `format.ts` | 面向模型的文本、截断辅助、重复标记 |
| `images.ts` | Tavily 图片 URL → pi 图片块 |
| `countries.ts` | 国家别名与归一化 |
| `prompts.ts` | 描述、片段、12 条策略规则 |
| `PROMPT.md` | 提示词设计说明与 token 预算 |

## 验证改动

用 pi 的 jiti 加载器加载扩展，配合 mock 的 HTTP 走通各工具路径，然后跑一次真实的
`pi -p --tavily-depth basic` 冒烟调用。

## 许可证

[MIT](LICENSE)
