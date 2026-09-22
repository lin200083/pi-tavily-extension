/**
 * Tavily extension for Pi — 5 custom tools: search / extract / map / crawl / research.
 *
 * Docs: https://docs.tavily.com
 * Config: ~/.pi/agent/extensions/tavily/config.json (apiKeys array, multiple keys
 * are used round-robin with automatic 429/432 failover).
 *
 * Rendering: oversized results are head-truncated for the LLM (pi's built-in
 * 50KB / 2000-line limits); the FULL text is written to a temp file whose path
 * is appended to the result, so the model can read specific ranges on demand
 * (read tool, offset/limit). The TUI shows a compact one-line summary that
 * expands (ctrl+e) to up to 100 lines.
 */
import {
  truncateHead,
  formatSize,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type {
  SearchParams,
  SearchResponse,
  ExtractParams,
  ExtractResponse,
  MapParams,
  MapResponse,
  CrawlParams,
  CrawlResponse,
  ResearchParams,
} from "./types.js";
import {
  tavilySearch,
  tavilyExtract,
  tavilyMap,
  tavilyCrawl,
  formatTavilyError,
} from "./client.js";
import { runResearch, readResearchFiles, type ResearchResult } from "./research.js";
import {
  resolveApiKeys,
  ensureConfigTemplate,
  CONFIG_PATH,
  resolveDefaultSearchDepth,
  resolveDefaultMaxResults,
  resolveDefaultResearchModel,
} from "./config.js";

// ============================================================
//  Shared rendering helpers (compact by default, expand on demand)
// ============================================================

/** Short one-line header for the tool call row. */
function callHeader(label: string, detail: (args: Record<string, unknown>) => string) {
  return (args: Record<string, unknown>, theme: any) => {
    let text = theme.fg("toolTitle", theme.bold(`${label} `));
    text += theme.fg("accent", detail(args));
    return new Text(text, 0, 0);
  };
}

/**
 * Compact result renderer:
 * - streaming: partial progress text
 * - error: first line of the error, in red
 * - collapsed (default): one-line summary
 * - expanded (ctrl+e): full result text (capped at 100 lines for display)
 */
function compactResult(
  partialText: string,
  summary: (result: any, theme: any) => string,
  maxDisplayLines = 100,
) {
  return (result: any, options: any, theme: any) => {
    if (options.isPartial) {
      return new Text(theme.fg("warning", partialText), 0, 0);
    }
    const content = result.content?.[0];
    const text = content?.type === "text" ? content.text : "";
    if (result.isError) {
      return new Text(theme.fg("error", text.split("\n")[0] || "Tavily 调用失败"), 0, 0);
    }
    const head = summary(result, theme);
    if (!options.expanded) return new Text(head, 0, 0);
    const lines = text.split("\n");
    const shown = lines.slice(0, maxDisplayLines).join("\n");
    const more =
      lines.length > maxDisplayLines
        ? `\n${theme.fg("muted", `…(${lines.length - maxDisplayLines} 行已省略)`)}`
        : "";
    return new Text(`${head}\n${theme.fg("dim", shown)}${more}`, 0, 0);
  };
}

const creditTag = (result: any, theme: any) => {
  const credits = result.details?.credits;
  return credits !== undefined ? theme.fg("dim", ` · ${credits} credit`) : "";
};

// ============================================================
//  Tool schemas
// ============================================================

const searchSchema = Type.Object({
  query: Type.String({ description: "The search query. Keep it under 1500 characters; for complex topics split into several focused sub-queries instead of one long query." }),
  topic: Type.Optional(StringEnum(["general", "news", "finance"] as const)),
  search_depth: Type.Optional(StringEnum(["advanced", "basic", "fast", "ultra-fast"] as const)),
  max_results: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
  time_range: Type.Optional(StringEnum(["day", "week", "month", "year"] as const)),
  start_date: Type.Optional(Type.String({ description: "Only results published after this date. Format YYYY-MM-DD. Use either time_range or start_date/end_date, not both." })),
  end_date: Type.Optional(Type.String({ description: "Only results published before this date. Format YYYY-MM-DD." })),
  include_published_date: Type.Optional(Type.Boolean({ description: "Include a `published_date` field in each result (Tavily's best estimate; null when undetectable). Automatically enabled when topic='news'. Beta." })),
  filter_by_published_date: Type.Optional(Type.Boolean({ description: "Strictly drop results outside the time_range/start_date/end_date window AND results with no detectable published date. Implies include_published_date. Needs a date window to be useful." })),
  include_answer: Type.Optional(Type.Union([Type.Boolean(), StringEnum(["basic", "advanced"] as const)])),
  include_raw_content: Type.Optional(Type.Union([Type.Boolean(), StringEnum(["markdown", "text"] as const)])),
  include_images: Type.Optional(Type.Boolean()),
  include_image_descriptions: Type.Optional(Type.Boolean({ description: "When include_images is true, also add a descriptive text for each image (only effective together with include_images)." })),
  include_favicon: Type.Optional(Type.Boolean()),
  include_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 300, description: "Only include results from these domains (e.g. sec.gov)." })),
  exclude_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 150, description: "Exclude results from these domains (e.g. reddit.com)." })),
  include_domains_mode: Type.Optional(StringEnum(["restrict", "prefer"] as const, { description: "How include_domains is applied: 'restrict' = hard filter to those domains only; 'prefer' = boost them but still search the rest of the web. Requires include_domains." })),
  country: Type.Optional(Type.String({ description: "Boost results from a specific country (general topic only), e.g. 'united states'." })),
  language: Type.Optional(Type.String({ description: "Boost results in a language: ISO 639-1 code ('en', 'zh-cn') or English name ('english'). Write your query in the same language. Requires filter_by_language to hard-filter instead of just boosting." })),
  filter_by_language: Type.Optional(Type.Boolean({ description: "Strictly drop results not matching `language` (instead of only boosting). Requires language." })),
  safe_search: Type.Optional(Type.Boolean({ description: "Filter out adult/unsafe content. Not supported for search_depth 'fast' or 'ultra-fast'." })),
  exact_match: Type.Optional(Type.Boolean({ description: "Only return results containing the exact quoted phrase(s) verbatim. Wrap target phrases in quotes in the query, e.g. '\"John Smith\" CEO Acme Corp'. Use for due diligence / data enrichment." })),
  auto_parameters: Type.Optional(Type.Boolean({ description: "Let Tavily auto-tune parameters from query intent. Note: may upgrade search_depth to advanced (2 credits)." })),
});
type SearchToolParams = Static<typeof searchSchema>;

const extractSchema = Type.Object({
  urls: Type.Array(Type.String(), { minItems: 1, maxItems: 20, description: "URLs to extract clean content from (max 20). Full page content is returned, so prefer extracting a few URLs per call." }),
  query: Type.Optional(Type.String({ description: "The information you are looking for. When provided, extracted chunks are reranked by relevance to this query and only the top chunks are returned (pairs with chunks_per_source)." })),
  chunks_per_source: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Max relevant chunks per URL (each <= 500 chars). Requires query." })),
  extract_depth: Type.Optional(StringEnum(["basic", "advanced"] as const)),
  format: Type.Optional(StringEnum(["markdown", "text"] as const)),
  include_images: Type.Optional(Type.Boolean()),
  include_favicon: Type.Optional(Type.Boolean({ description: "Whether to include the favicon URL for each result." })),
  timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 60, description: "Max seconds to wait for extraction (default: 10s basic / 30s advanced)." })),
});
type ExtractToolParams = Static<typeof extractSchema>;

const mapSchema = Type.Object({
  url: Type.String({ description: "Root URL of the site to map (e.g. docs.example.com or https://docs.example.com)." }),
  instructions: Type.Optional(Type.String({ description: "Natural-language guidance for discovery, e.g. 'Find all pages about the Python SDK'. (Doubles mapping cost.)" })),
  max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "How many levels deep to explore (default 1). Each level increases time exponentially." })),
  max_breadth: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Max links to follow per level (default 20)." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Total URL cap (default 50). Always keep this reasonable to control cost." })),
  select_paths: Type.Optional(Type.Array(Type.String(), { description: "Regex patterns to only include URLs whose path matches, e.g. ['/docs/.*']." })),
  exclude_paths: Type.Optional(Type.Array(Type.String(), { description: "Regex patterns to exclude URL paths, e.g. ['/admin/.*']." })),
  select_domains: Type.Optional(Type.Array(Type.String(), { description: "Regex patterns to only include matching domains/subdomains, e.g. ['^docs\\.example\\.com$']." })),
  exclude_domains: Type.Optional(Type.Array(Type.String(), { description: "Regex patterns to exclude domains, e.g. ['^tracking\\.example\\.com$']." })),
  allow_external: Type.Optional(Type.Boolean({ description: "Whether to include external-domain links in results (default true)." })),
  timeout: Type.Optional(Type.Number({ minimum: 10, maximum: 150, description: "Max seconds to wait (default 150)." })),
});
type MapToolParams = Static<typeof mapSchema>;

const crawlSchema = Type.Object({
  url: Type.String({ description: "Root URL to start crawling (e.g. docs.example.com or https://docs.example.com)." }),
  instructions: Type.Optional(Type.String({ description: "Natural-language guidance to focus the crawl semantically, e.g. 'Find all documentation about authentication'. Enables chunks_per_source." })),
  chunks_per_source: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Max relevant chunks per page (each <= 500 chars). Requires instructions. Keeps context small." })),
  max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "How many levels deep to crawl (default 1). Each level increases time exponentially — start at 1." })),
  max_breadth: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Max links to follow per level (default 20)." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Total page cap (default 50). ALWAYS keep this reasonable to control credit cost." })),
  select_paths: Type.Optional(Type.Array(Type.String(), { description: "Regex patterns to only crawl matching paths, e.g. ['/docs/.*', '/api/.*']." })),
  exclude_paths: Type.Optional(Type.Array(Type.String(), { description: "Regex patterns to skip paths, e.g. ['/private/.*']." })),
  select_domains: Type.Optional(Type.Array(Type.String(), { description: "Regex patterns to stay within matching domains." })),
  exclude_domains: Type.Optional(Type.Array(Type.String(), { description: "Regex patterns to exclude domains." })),
  allow_external: Type.Optional(Type.Boolean({ description: "Whether to follow links to external domains (default true)." })),
  extract_depth: Type.Optional(StringEnum(["basic", "advanced"] as const)),
  format: Type.Optional(StringEnum(["markdown", "text"] as const)),
  include_images: Type.Optional(Type.Boolean()),
  include_favicon: Type.Optional(Type.Boolean({ description: "Whether to include the favicon URL for each page." })),
  timeout: Type.Optional(Type.Number({ minimum: 10, maximum: 150, description: "Max seconds to wait (default 150)." })),
});
type CrawlToolParams = Static<typeof crawlSchema>;

const researchSchema = Type.Object({
  input: Type.String({ description: "The research task/question. Be specific: include known context, constraints and the desired output format. Complex topics benefit from model=pro; narrow questions from model=mini." }),
  model: Type.Optional(StringEnum(["auto", "mini", "pro"] as const)),
  stream: Type.Optional(Type.Boolean({ description: "Stream progress in real time (default true). Set false for a simple submit+poll flow." })),
  output_length: Type.Optional(StringEnum(["short", "standard", "long"] as const)),
  citation_format: Type.Optional(StringEnum(["numbered", "mla", "apa", "chicago"] as const)),
  include_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: "Soft preference: prioritize these domains (host-based, includes subdomains)." })),
  exclude_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: "Hard blocklist: no URL from these domains (or subdomains) appears." })),
  output_schema: Type.Optional(Type.String({ description: "Optional JSON Schema (as a JSON string, e.g. '{\"properties\":{...},\"required\":[...]}') to get structured output instead of a markdown report. Write clear field descriptions." })),
  files: Type.Optional(Type.Array(Type.String(), { maxItems: 5, description: "Local file paths (.txt/.md/.json only, max ~80k words total) to attach as research sources alongside the web." })),
  max_wait: Type.Optional(Type.Integer({ default: 600, description: "Max seconds to wait for completion in polling mode." })),
});
type ResearchToolParams = Static<typeof researchSchema>;

// ============================================================
//  Result formatting
// ============================================================

const progress = (text: string) => ({ content: [{ type: "text", text } as const], details: {} });

// ---------- Output truncation (protect the LLM context) ----------
//
// Oversized results are head-truncated to pi's built-in limits (50KB / 2000
// lines) and the FULL text is written to a temp file. The path is appended to
// the returned text so the model can pull specific ranges on demand via the
// read tool (offset/limit) instead of ingesting everything at once — nothing
// is lost, it just stops being force-fed into context.

// Files written by finalizeOutput during this process, so they can be removed
// when pi actually quits (on /reload or session switches they are kept: the
// model may still want to read them back from the transcript).
const createdTempFiles: string[] = [];

const TEMP_FILE_PREFIX = "pi-tavily-";
const TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Best-effort removal of stale spill files left behind by earlier runs. */
function sweepStaleTempFiles(): void {
  try {
    const now = Date.now();
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(TEMP_FILE_PREFIX) || !name.endsWith(".md")) continue;
      const full = join(tmpdir(), name);
      try {
        if (now - statSync(full).mtimeMs > TEMP_FILE_MAX_AGE_MS) {
          rmSync(full, { force: true });
        }
      } catch {
        // another process may be reading/writing it; ignore
      }
    }
  } catch {
    // non-fatal
  }
}

function finalizeOutput(
  text: string,
  endpoint: string,
): { text: string; truncated: boolean } {
  const t = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!t.truncated) return { text, truncated: false };

  const stats = `${t.outputLines}/${t.totalLines} 行 · ${formatSize(t.outputBytes)}/${formatSize(t.totalBytes)}`;
  // Unique per call: pi runs tools in parallel by default, so a millisecond
  // timestamp alone lets concurrent calls overwrite each other's spill file.
  const file = join(
    tmpdir(),
    `${TEMP_FILE_PREFIX}${endpoint}-${Date.now()}-${process.pid}-${randomBytes(4).toString("hex")}.md`,
  );

  // Line-based truncation keeps whole lines, so a payload containing a few
  // enormous lines (a page minified into one line, a single-line JSON blob)
  // loses them entirely and leaves the model with just the header. Detect that
  // and fall back to a hard character slice so it still sees a useful prefix.
  const maxLineBytes = text
    .split("\n")
    .reduce((m, line) => Math.max(m, Buffer.byteLength(line, "utf8")), 0);
  const lineTruncationDegenerate =
    t.firstLineExceedsLimit || maxLineBytes > DEFAULT_MAX_BYTES * 0.5;
  const head = lineTruncationDegenerate
    ? text.slice(0, Math.floor(DEFAULT_MAX_BYTES * 0.9))
    : t.content;
  const statsNote = lineTruncationDegenerate
    ? `${stats}（含超长行，已按字符硬切开头部分）`
    : stats;

  try {
    writeFileSync(file, text);
    createdTempFiles.push(file);
    return {
      text:
        `${head}\n\n` +
        `[输出已截断: ${statsNote}。完整内容已保存到 ${file}；需要更多内容时，用 read 工具按 offset/limit 分段读取该文件]`,
      truncated: true,
    };
  } catch {
    // temp file write failed: still return truncated content, minus the pointer
    return {
      text: `${head}\n\n[注意: 输出被截断至 ${statsNote}（临时文件写入失败，无法提供完整内容）]`,
      truncated: true,
    };
  }
}

/**
 * Convert a caught error into a thrown error so pi marks the tool result as failed.
 * NOTE: returning `{ isError: true }` from execute is IGNORED by pi (agent-loop hardcodes
 * `isError: false` for returned values) — only throwing sets the error flag.
 * AbortError (user pressed Esc) is rethrown unchanged so pi handles cancellation natively.
 */
function handleError(err: unknown, signal?: AbortSignal): never {
  if ((err as Error)?.name === "AbortError" || signal?.aborted) throw err;
  throw new Error(formatTavilyError(err));
}

/**
 * Render an image list compactly. Search returns objects with an optional
 * description; extract/crawl return plain URL strings. Capped so a media-heavy
 * page cannot blow up the tool output.
 */
function formatImages(
  images: Array<{ url: string; description?: string }> | string[] | undefined,
  limit = 5,
): string[] {
  if (!images?.length) return [];
  const lines: string[] = [];
  for (const img of images.slice(0, limit)) {
    const url = typeof img === "string" ? img : img.url;
    const desc = typeof img === "string" ? undefined : img.description;
    lines.push(desc ? `   🖼 ${desc} — ${url}` : `   🖼 ${url}`);
  }
  if (images.length > limit) {
    lines.push(`   🖼 …另有 ${images.length - limit} 张`);
  }
  return lines;
}

function formatSearch(resp: SearchResponse): string {
  const lines: string[] = [];
  if (resp.answer) {
    lines.push(`**Answer:** ${resp.answer}`, "");
  }
  const results = resp.results ?? [];
  if (results.length === 0) {
    lines.push("No results found.");
  }
  results.forEach((r, i) => {
    const score = typeof r.score === "number" ? r.score.toFixed(2) : "?";
    const date = r.published_date ? ` [${r.published_date}]` : "";
    lines.push(`${i + 1}. [score ${score}]${date} ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.favicon) lines.push(`   (favicon: ${r.favicon})`);
    if (r.content) lines.push(`   ${r.content}`);
    if (r.raw_content) lines.push(`   (raw content:)`, r.raw_content);
    lines.push(...formatImages(r.images));
    lines.push("");
  });
  // Top-level images are query-related and separate from the per-result ones.
  if (resp.images?.length) {
    lines.push("## Images", ...formatImages(resp.images), "");
  }
  return lines.join("\n").trim();
}

function formatExtract(resp: ExtractResponse): string {
  const lines: string[] = [];
  for (const r of resp.results ?? []) {
    lines.push(`## ${r.url}`);
    if (r.favicon) lines.push(`(favicon: ${r.favicon})`);
    lines.push(r.raw_content ?? "", "");
    lines.push(...formatImages(r.images));
  }
  const failed = resp.failed_results ?? [];
  if (failed.length > 0) {
    lines.push("Failed URLs:");
    for (const f of failed) lines.push(`- ${f.url}: ${f.error}`);
  }
  if ((resp.results ?? []).length === 0 && failed.length === 0) {
    lines.push("No results.");
  }
  return lines.join("\n").trim();
}

function formatMap(resp: MapResponse): string {
  const urls = resp.results ?? [];
  const lines = [`Discovered ${urls.length} URLs under ${resp.base_url}:`, ""];
  for (const u of urls) lines.push(`- ${u}`);
  return lines.join("\n");
}

function formatCrawl(resp: CrawlResponse): string {
  const pages = resp.results ?? [];
  const lines = [`Crawled ${pages.length} pages from ${resp.base_url}:`, ""];
  for (const p of pages) {
    lines.push(`### ${p.url}`);
    if (p.favicon) lines.push(`(favicon: ${p.favicon})`);
    lines.push(p.raw_content ?? "", "");
    lines.push(...formatImages(p.images));
  }
  if (pages.length === 0) lines.push("No pages crawled.");
  return lines.join("\n").trim();
}

function formatResearch(res: ResearchResult): string {
  const content =
    typeof res.content === "string"
      ? res.content
      : JSON.stringify(res.content, null, 2);
  const sources = res.sources ?? [];
  if (sources.length === 0) return content;
  const sourceBlock =
    "\n\n## Sources\n" +
    sources
      .map((s, i) => `${i + 1}. ${s.title} — ${s.url}`)
      .join("\n");
  return content + sourceBlock;
}

// ============================================================
//  Extension entry
// ============================================================

export default function tavilyExtension(pi: ExtensionAPI) {
  // Startup: generate config template and warn when no API keys configured
  pi.on("session_start", async (_event, ctx) => {
    ensureConfigTemplate();
    sweepStaleTempFiles();
    const keys = resolveApiKeys();
    if (keys.length === 0) {
      ctx.ui.notify(
        `Tavily 插件已加载，但未配置 API Key。请把 ${CONFIG_PATH.replace(/config\.json$/, "config.example.json")} 复制为 config.json，并在 apiKeys 中填入 Key（支持多个 Key 自动轮换）。`,
        "error",
      );
    }
  });

  // Only on a real quit: on reload / session switch the transcript may still
  // reference the spill files, so they are left to the 24h sweep instead.
  pi.on("session_shutdown", (event) => {
    if (event.reason !== "quit") return;
    for (const file of createdTempFiles.splice(0)) {
      try {
        rmSync(file, { force: true });
      } catch {
        // already gone / unreadable
      }
    }
  });

  const sessionIdOf = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();

  // ---------- tavily_search ----------
  pi.registerTool({
    name: "tavily_search",
    label: "Tavily Search",
    description:
      "Search the web with Tavily (general / news / finance topics). Returns ranked results with relevance scores and content snippets optimized for LLMs. Use this FIRST whenever you need current information or sources are unknown. For news: set topic='news' plus time_range (e.g. 'week'). For a quick AI answer include include_answer='basic'. For full page content prefer a follow-up tavily_extract call on the top URLs (score > 0.5) instead of include_raw_content. Costs 2 credits per call by default (search_depth='advanced', richest snippets); pass search_depth='basic'/'fast'/'ultra-fast' for 1 credit when you only need a quick lookup. Configurable via config.json (defaultSearchDepth).",
    promptSnippet: "Search the web for current facts, news, finance, or anything you're unsure about — use it freely and often",
    promptGuidelines: [
      "Search first, guess never: whenever the answer depends on anything after your training cutoff, or on any fact you are not fully certain about, run tavily_search instead of answering from memory. Do not ask the user for permission — just search.",
      "Prefer tavily_search over hedging or declining. A quick search costs far less than a wrong answer.",
      "Pick the right tool: quick fact or a list of sources → tavily_search (this tool); one known URL → tavily_extract; a site's structure → tavily_map; many pages of a site → tavily_crawl; a cited, synthesized report → tavily_research.",
      "Chain tools within the same turn: tavily_search first, then tavily_extract the most promising URLs (score >= 0.5) and actually read them before answering. Don't stop at the snippets.",
      "If tavily_search comes back weak or empty, retry with different phrasing or a narrower query — never fall back to answering from memory. Split complex questions into several focused tavily_search queries (each under 1500 chars).",
      "When source trust matters, use tavily_search's include_domains / exclude_domains; add include_domains_mode='prefer' to also let other sources surface.",
      "Every tavily_* tool truncates oversized output and writes the full text to a spill file whose path is appended to the result — read the rest with `read` (offset/limit) instead of answering from the truncated text alone.",
    ],
    parameters: searchSchema,
    renderCall: callHeader("tavily_search", (args) => String(args.query ?? "").slice(0, 60)),
    renderResult: compactResult(
      "🔍 搜索中…",
      (result, theme) =>
        `${theme.fg("success", `✓ ${result.details?.results_count ?? 0} 个结果`)}` +
        (result.details?.has_answer ? theme.fg("dim", " · 含 AI 摘要") : "") +
        (result.details?.truncated ? theme.fg("warning", " · 输出已截断") : "") +
        creditTag(result, theme),
    ),
    async execute(toolCallId, params: SearchToolParams, signal, onUpdate, ctx) {
      onUpdate?.(progress(`🔍 正在搜索: ${params.query}`));
      try {
        const body: SearchParams = {
          query: params.query,
          topic: params.topic ?? "general",
          // basic = 1 credit, advanced = 2 credits. Default comes from config.json
          // (defaultSearchDepth) so the cost/quality tradeoff is the user's call.
          search_depth: params.search_depth ?? resolveDefaultSearchDepth(),
          max_results: params.max_results ?? resolveDefaultMaxResults(),
        };
        // chunks_per_source is only supported for advanced/basic/fast depths
        // (not ultra-fast) per Tavily docs; omit it otherwise.
        const depth = body.search_depth;
        if (depth === "advanced" || depth === "basic" || depth === "fast") {
          body.chunks_per_source = 3;
        }
        if (params.time_range) body.time_range = params.time_range;
        if (params.start_date) body.start_date = params.start_date;
        if (params.end_date) body.end_date = params.end_date;
        if (params.include_published_date) body.include_published_date = true;
        if (params.filter_by_published_date) body.filter_by_published_date = true;
        if (params.include_answer !== undefined) body.include_answer = params.include_answer;
        if (params.include_raw_content !== undefined) body.include_raw_content = params.include_raw_content;
        if (params.include_images) body.include_images = true;
        if (params.include_image_descriptions) body.include_image_descriptions = true;
        if (params.include_favicon) body.include_favicon = true;
        if (params.include_domains?.length) {
          body.include_domains = params.include_domains;
          // include_domains_mode requires include_domains (400 otherwise)
          if (params.include_domains_mode) body.include_domains_mode = params.include_domains_mode;
        }
        if (params.exclude_domains?.length) body.exclude_domains = params.exclude_domains;
        // country is only honored for topic=general per Tavily docs; drop otherwise
        if (params.country && body.topic === "general") body.country = params.country;
        if (params.language) {
          body.language = params.language;
          // filter_by_language requires language (400 otherwise)
          if (params.filter_by_language) body.filter_by_language = true;
        }
        // safe_search is rejected for fast / ultra-fast depths
        if (params.safe_search && depth !== "fast" && depth !== "ultra-fast") {
          body.safe_search = true;
        }
        if (params.exact_match) body.exact_match = true;
        if (params.auto_parameters) body.auto_parameters = true;

        const resp = await tavilySearch(body, sessionIdOf(ctx), signal);
        const out = finalizeOutput(formatSearch(resp), "search");
        return {
          content: [{ type: "text", text: out.text }],
          details: {
            endpoint: "search",
            query: resp.query,
            results_count: (resp.results ?? []).length,
            has_answer: !!resp.answer,
            request_id: resp.request_id,
            credits: resp.usage?.credits,
            response_time: resp.response_time,
            truncated: out.truncated,
          },
        };
      } catch (err) {
        handleError(err, signal);
      }
    },
  });

  // ---------- tavily_extract ----------
  pi.registerTool({
    name: "tavily_extract",
    label: "Tavily Extract",
    description:
      "Extract clean, LLM-ready content (markdown or text) from one or more URLs (max 20). Reach for this whenever you hold URLs that may contain useful content — from tavily_search results, from the user, or anywhere else; you do not need to be asked. Pass a query to rerank chunks by relevance and keep only the most relevant parts of long pages (pairs with chunks_per_source). Failed URLs are reported separately and never charged. Costs 1 credit per 5 successful URLs (basic) or 2 per 5 (advanced).",
    promptSnippet: "Read the full content of known URLs",
    promptGuidelines: [
      "Use tavily_extract whenever you hold a URL that might contain what you need — from tavily_search results, from the user, or from your own knowledge. Don't wait to be asked; fetching a page is cheap.",
      "Batch up to 20 URLs into one tavily_extract call when several look promising; per-URL failures are reported separately and never charged.",
      "For long pages, pass the user's actual question as tavily_extract's `query` to pull only the relevant chunks out of the document.",
      "Use tavily_extract with extract_depth='advanced' for tables, embedded content, or pages that fail with basic extraction.",
    ],
    parameters: extractSchema,
    renderCall: callHeader("tavily_extract", (args) => {
      const urls = (args.urls as string[]) ?? [];
      return `${urls.length} 个 URL${urls[0] ? ` · ${urls[0].slice(0, 40)}` : ""}`;
    }),
    renderResult: compactResult(
      "📄 提取中…",
      (result, theme) =>
        `${theme.fg("success", `✓ 提取 ${result.details?.extracted_count ?? 0} 个 URL`)}` +
        (result.details?.failed_count
          ? theme.fg("warning", ` · ${result.details.failed_count} 个失败`)
          : "") +
        (result.details?.truncated ? theme.fg("warning", " · 输出已截断") : "") +
        creditTag(result, theme),
    ),
    async execute(toolCallId, params: ExtractToolParams, signal, onUpdate, ctx) {
      onUpdate?.(progress(`📄 正在提取 ${params.urls.length} 个 URL…`));
      try {
        const body: ExtractParams = {
          urls: params.urls,
          extract_depth: params.extract_depth ?? "basic",
          format: params.format ?? "markdown",
        };
        if (params.query) body.query = params.query;
        // chunks_per_source requires query per Tavily docs; drop it otherwise
        if (params.chunks_per_source && params.query) body.chunks_per_source = params.chunks_per_source;
        if (params.include_images) body.include_images = true;
        if (params.include_favicon) body.include_favicon = true;
        if (params.timeout) body.timeout = params.timeout;

        const resp = await tavilyExtract(body, sessionIdOf(ctx), signal);
        const out = finalizeOutput(formatExtract(resp), "extract");
        return {
          content: [{ type: "text", text: out.text }],
          details: {
            endpoint: "extract",
            extracted_count: (resp.results ?? []).length,
            failed_count: (resp.failed_results ?? []).length,
            request_id: resp.request_id,
            credits: resp.usage?.credits,
            response_time: resp.response_time,
            failed: resp.failed_results,
            truncated: out.truncated,
          },
        };
      } catch (err) {
        handleError(err, signal);
      }
    },
  });

  // ---------- tavily_map ----------
  pi.registerTool({
    name: "tavily_map",
    label: "Tavily Map",
    description:
      "Discover the structure of a website: returns the list of URLs found under a root URL without extracting content. Faster and cheaper than tavily_crawl. Use it to find the right pages on a site before extracting them (map + extract pattern), or to build a sitemap. Supports regex path/domain filters and natural-language instructions. Costs 1 credit per 10 pages (2 per 10 with instructions). NOTE: on JS-rendered/SPA sites, instructions or select_paths may return very few URLs — retry without them if the result looks too small.",
    promptSnippet: "Discover a site's URL structure (before crawling or extracting)",
    promptGuidelines: [
      "Use tavily_map whenever you need to locate a specific page on a site ('where is their pricing / docs page?'), map out a site's structure, or plan a focused crawl — it is cheap and fast.",
      "Prefer tavily_map before tavily_crawl when you don't yet know which pages matter, and before tavily_extract when the URL is unknown.",
      "Narrow tavily_map with select_paths / exclude_paths regex (e.g. '/docs/.*') and select_domains to stay on the right subdomain; on JS-heavy / SPA sites, retry without instructions or select_paths if the result looks too small.",
    ],
    parameters: mapSchema,
    renderCall: callHeader("tavily_map", (args) => String(args.url ?? "").slice(0, 60)),
    renderResult: compactResult(
      "🗺️ 探测中…",
      (result, theme) =>
        `${theme.fg("success", `✓ ${result.details?.url_count ?? 0} 个 URL`)}` +
        (result.details?.truncated ? theme.fg("warning", " · 输出已截断") : "") +
        creditTag(result, theme),
    ),
    async execute(toolCallId, params: MapToolParams, signal, onUpdate, ctx) {
      onUpdate?.(progress(`🗺️ 正在探测站点结构: ${params.url}…`));
      try {
        const body: MapParams = {
          url: params.url,
          max_depth: params.max_depth ?? 1,
          max_breadth: params.max_breadth ?? 20,
          limit: params.limit ?? 50,
          allow_external: params.allow_external ?? true,
        };
        if (params.instructions) body.instructions = params.instructions;
        if (params.select_paths?.length) body.select_paths = params.select_paths;
        if (params.exclude_paths?.length) body.exclude_paths = params.exclude_paths;
        if (params.select_domains?.length) body.select_domains = params.select_domains;
        if (params.exclude_domains?.length) body.exclude_domains = params.exclude_domains;
        if (params.timeout) body.timeout = params.timeout;

        const resp = await tavilyMap(body, sessionIdOf(ctx), signal);
        const out = finalizeOutput(formatMap(resp), "map");
        return {
          content: [{ type: "text", text: out.text }],
          details: {
            endpoint: "map",
            base_url: resp.base_url,
            url_count: resp.results.length,
            request_id: resp.request_id,
            credits: resp.usage?.credits,
            response_time: resp.response_time,
            truncated: out.truncated,
          },
        };
      } catch (err) {
        handleError(err, signal);
      }
    },
  });

  // ---------- tavily_crawl ----------
  pi.registerTool({
    name: "tavily_crawl",
    label: "Tavily Crawl",
    description:
      "Crawl a website starting from a root URL and extract content from every discovered page. Use when many pages of a site must be read (docs ingestion, competitive research, knowledge base). Focus with instructions (natural language), select_paths/exclude_paths (regex), and always keep limit reasonable — cost scales with pages crawled (mapping + extraction credits per page). Prefer tavily_map first to understand the site, and tavily_extract for a handful of known URLs. NOTE: on JS-rendered/SPA sites, instructions or select_paths may return very few pages — retry without them if the result looks too small.",
    promptSnippet: "Read the content of many pages of a site at once",
    promptGuidelines: [
      "Use tavily_crawl whenever you need the content of many pages of a site at once — docs ingestion, competitive research, building a knowledge base. Don't hesitate even for a modest number of pages.",
      "Focus tavily_crawl with limit (default 50), instructions, or select_paths, and keep max_depth low (1) at first — each extra level grows the crawl exponentially.",
      "Reach for tavily_map or tavily_extract instead of tavily_crawl when you don't yet know which pages matter, or only need a handful of known URLs.",
    ],
    parameters: crawlSchema,
    renderCall: callHeader("tavily_crawl", (args) => String(args.url ?? "").slice(0, 60)),
    renderResult: compactResult(
      "🕷️ 爬取中…",
      (result, theme) =>
        `${theme.fg("success", `✓ 爬取 ${result.details?.page_count ?? 0} 页`)}` +
        (result.details?.truncated ? theme.fg("warning", " · 输出已截断") : "") +
        creditTag(result, theme),
    ),
    async execute(toolCallId, params: CrawlToolParams, signal, onUpdate, ctx) {
      onUpdate?.(progress(`🕷️ 正在爬取: ${params.url}…`));
      try {
        const body: CrawlParams = {
          url: params.url,
          max_depth: params.max_depth ?? 1,
          max_breadth: params.max_breadth ?? 20,
          limit: params.limit ?? 50,
          allow_external: params.allow_external ?? true,
          extract_depth: params.extract_depth ?? "basic",
          format: params.format ?? "markdown",
        };
        if (params.instructions) {
          body.instructions = params.instructions;
          if (params.chunks_per_source) body.chunks_per_source = params.chunks_per_source;
        }
        if (params.select_paths?.length) body.select_paths = params.select_paths;
        if (params.exclude_paths?.length) body.exclude_paths = params.exclude_paths;
        if (params.select_domains?.length) body.select_domains = params.select_domains;
        if (params.exclude_domains?.length) body.exclude_domains = params.exclude_domains;
        if (params.include_images) body.include_images = true;
        if (params.include_favicon) body.include_favicon = true;
        if (params.timeout) body.timeout = params.timeout;

        const resp = await tavilyCrawl(body, sessionIdOf(ctx), signal);
        const out = finalizeOutput(formatCrawl(resp), "crawl");
        return {
          content: [{ type: "text", text: out.text }],
          details: {
            endpoint: "crawl",
            base_url: resp.base_url,
            page_count: resp.results.length,
            request_id: resp.request_id,
            credits: resp.usage?.credits,
            response_time: resp.response_time,
            truncated: out.truncated,
          },
        };
      } catch (err) {
        handleError(err, signal);
      }
    },
  });

  // ---------- tavily_research ----------
  pi.registerTool({
    name: "tavily_research",
    label: "Tavily Research",
    description:
      "Run deep multi-step research: Tavily's agent searches the web, analyzes sources, and produces a comprehensive cited report (or structured JSON when output_schema is given). Use proactively whenever a synthesized, cited answer adds value — from quick-but-thorough lookups to deep multi-source reports. Takes 30-120+ seconds; progress is streamed. Costs 15-250 credits per task by default (model='pro', multi-agent depth); pass model='mini' (4-110) for narrow, well-scoped questions.",
    promptSnippet: "Run deep multi-source research that returns a cited report",
    promptGuidelines: [
      "Reach for tavily_research whenever the user would benefit from a synthesized, cited answer — competitive or market analysis, technology surveys, decision-ready comparisons, '调研一下…', or any question where a well-sourced report beats a pile of links.",
      "Prefer tavily_research over ad-hoc tavily_search whenever thoroughness matters: it runs the multi-round searching, cross-checking and citation for you.",
      "tavily_research sends model='pro' by default (multi-agent depth, 15-250 credits; set in config.json); pass model='mini' for narrow, well-scoped questions to keep it at 4-110 credits. Pass output_schema for structured data instead of prose.",
      "Pass local file paths via tavily_research's `files` (.txt/.md/.json, up to 5) to ground the research in the user's own documents. It is long-running with streamed progress; Esc interrupts and keeps whatever was already produced.",
    ],
    parameters: researchSchema,
    renderCall: callHeader("tavily_research", (args) => String(args.input ?? "").slice(0, 60)),
    renderResult: compactResult(
      "🧠 研究中…",
      (result, theme) =>
        (result.details?.partial
          ? theme.fg("warning", "⚠ 部分结果（任务中断，已回收）")
          : theme.fg("success", "✓ 研究完成")) +
        (result.details?.source_count
          ? theme.fg("dim", ` · ${result.details.source_count} 个来源`)
          : "") +
        (result.details?.truncated ? theme.fg("warning", " · 输出已截断") : "") +
        creditTag(result, theme),
    ),
    async execute(toolCallId, params: ResearchToolParams, signal, onUpdate, ctx) {
      try {
        const researchParams: ResearchParams = {
          input: params.input,
          // "auto" can pick "pro" (up to 250 credits/task); default from config
          // keeps the worst case at mini's 110 unless the user opts in.
          model: params.model ?? resolveDefaultResearchModel(),
          stream: params.stream ?? true,
          output_length: params.output_length ?? "standard",
          citation_format: params.citation_format ?? "numbered",
        };
        if (params.include_domains?.length) researchParams.include_domains = params.include_domains;
        if (params.exclude_domains?.length) researchParams.exclude_domains = params.exclude_domains;
        if (params.output_schema) {
          let schema: unknown;
          try {
            schema = JSON.parse(params.output_schema);
          } catch {
            throw new Error(
              "output_schema 不是合法的 JSON 字符串，请检查格式（例如 {\"properties\":{...},\"required\":[...]}）。",
            );
          }
          if (!schema || typeof schema !== "object" || !("properties" in (schema as object))) {
            throw new Error(
              "output_schema 必须是包含 properties 字段的 JSON Schema 对象。",
            );
          }
          researchParams.output_schema = schema as Record<string, unknown>;
        }
        if (params.files?.length) {
          researchParams.files = readResearchFiles(params.files);
        }

        const result = await runResearch(researchParams, {
          sessionId: sessionIdOf(ctx),
          signal,
          maxWaitSeconds: params.max_wait ?? 600,
          onUpdate: (text) => onUpdate?.(progress(text)),
        });

        const out = finalizeOutput(formatResearch(result), "research");
        return {
          content: [{ type: "text", text: out.text }],
          details: {
            endpoint: "research",
            request_id: result.requestId,
            model: result.model,
            source_count: result.sources.length,
            response_time: result.responseTime,
            partial: result.partial === true,
            truncated: out.truncated,
          },
        };
      } catch (err) {
        handleError(err, signal);
      }
    },
  });
}
