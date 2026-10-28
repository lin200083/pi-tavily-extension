/**
 * Tavily extension for Pi — 5 custom tools: search / extract / map / crawl / research.
 * Docs: https://docs.tavily.com
 *
 * Install: put this directory in ~/.pi/agent/extensions/tavily (or run `pi install /path/to/tavily`)
 * and restart pi. No `npm install` is needed at runtime: pi provides @earendil-works/* and typebox.
 *
 * Config: config.json in this directory. If it is missing at startup the session shows a
 * notification and config.example.json is written as a template; copy it and fill in apiKeys.
 *   apiKeys:              required; multiple keys are used round-robin with 401 invalid-key skip,
 *                         429 cooldown, 432/433 limit skip and 5xx failover
 *   projectId / humanId:  optional X-Project-ID / X-Human-Id tracking headers
 *   defaultSearchDepth:   "advanced" (2 credits/call) | basic / fast / ultra-fast (1 credit)
 *   defaultMaxResults:    10 (1-20)
 *   defaultResearchModel: "pro" (15-250 credits/task, deepest) | mini (4-110) | auto
 *   maxSessionCredits:    0 = unlimited; otherwise a hard per-session ceiling reset on
 *                         session_start and enforced before every call (estimates are upper
 *                         bounds; in-flight calls reserve their estimate)
 *   searchTimeoutMs:      client-side /search deadline (default 60000)
 *   cacheTtlSeconds:      reuse an identical search/extract within a session for N seconds
 *                         (default 300, 0 = off)
 * Config is re-read on every call, but the tool descriptions (which state the current costs)
 * are generated at load: restart pi or /reload after changing the defaults.
 *
 * Files: client.ts (HTTP + multi-key failover), research.ts (poll/SSE research),
 * config.ts (config.json), countries.ts (country aliases), types.ts (API types),
 * prompts.ts (policy rules + declarations), schemas.ts (parameters + output),
 * params.ts (request assembly), format.ts (model-facing text), images.ts (image blocks).
 *
 * Rendering: oversized results are head-truncated for the LLM (pi's built-in
 * 50KB / 2000-line limits); the FULL text is written to a temp file whose path
 * is appended to the result, so the model can read specific ranges on demand
 * (read tool, offset/limit). The TUI shows a compact one-line summary that
 * expands (ctrl+o) to up to 100 lines. Session spend is tracked internally for
 * the maxSessionCredits budget gate; per-call credits are rendered in the
 * result line, and nothing is rendered in the footer.
 */
import {
  truncateHead,
  formatSize,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir as readdirAsync, stat as statAsync, rm as rmAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Text } from "@earendil-works/pi-tui";
import type { ResearchParams } from "./types.js";
import {
  searchSchema,
  extractSchema,
  mapSchema,
  crawlSchema,
  researchSchema,
  searchOutputSchema,
  extractOutputSchema,
  mapOutputSchema,
  crawlOutputSchema,
  researchOutputSchema,
  type SearchToolParams,
  type ExtractToolParams,
  type MapToolParams,
  type CrawlToolParams,
  type ResearchToolParams,
} from "./schemas.js";
import { buildToolPrompts, TAVILY_NAMESPACE, RULES } from "./prompts.js";
import {
  buildSearchBody,
  buildExtractBody,
  buildMapBody,
  buildCrawlBody,
} from "./params.js";
import {
  formatSearch,
  formatExtract,
  formatMap,
  formatCrawl,
  formatResearch,
  clean,
  sliceByBytes,
  capStructuredText,
  exceedsCap,
  type FormattedOutput,
  type SeenUrls,
} from "./format.js";
import {
  tavilySearch,
  tavilyExtract,
  tavilyMap,
  tavilyCrawl,
  tavilyResearchGet,
  formatTavilyError,
  keyManager,
} from "./client.js";
import { runResearch, readResearchFiles, ALLOWED_FILE_EXT, MAX_FILES, MAX_TOTAL_ENCODED_BYTES, type ResearchResult } from "./research.js";
import { fetchImageBlocks } from "./images.js";
import {
  resolveApiKeys,
  ensureConfigTemplate,
  configReadError,
  CONFIG_PATH,
  TEMPLATE_PATH,
  resolveDefaultSearchDepth,
  resolveDefaultMaxResults,
  resolveDefaultResearchModel,
  resolveMaxSessionCredits,
  resolveCacheTtlSeconds,
} from "./config.js";
import { resolveCountry } from "./countries.js";

// ============================================================
//  Shared tool metadata (pi extension contract)
// ============================================================

/**
 * All five tools are read-only web calls: they never mutate local state, so a
 * permission-gate extension can skip the confirmation prompt, per pi's
 * extensions.md contract.
 *
 * `idempotentHint` is false on purpose: retrying a call is free of local side
 * effects but not free of cost — every attempt is billed by Tavily, and a hint
 * that says "safe to retry blindly" would invite exactly that.
 */
const TAVILY_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: true,
  idempotentHint: false,
} as const;

/**
 * Research is the exception: one call starts a long, separately billed server
 * task and may upload local files (`files`).
 */
const TAVILY_RESEARCH_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: true,
  idempotentHint: false,
} as const;

/**
 * Ask providers that support constrained sampling to keep tool arguments
 * inside the TypeBox schema (same request pi's built-in tools make). `prefer`
 * degrades to normal sampling where the provider cannot honor it.
 */
const TAVILY_CONSTRAINED_SAMPLING = { type: "json_schema", strict: "prefer" } as const;

// ============================================================
//  Session state
// ============================================================

/** Credits spent in the current pi session (reset on session_start). */
let sessionCredits = 0;
/** URLs already fetched this session, used to mark repeats in results. */
const seenUrls: SeenUrls = new Set();

/**
 * Estimates reserved by calls that passed the budget gate but have not produced
 * a tool_result yet. Without this, parallel calls all read the same
 * `sessionCredits` and can overshoot maxSessionCredits together.
 */
const reservedCredits = new Map<string, { estimate: number; at: number }>();
/** A reservation older than this is stale (aborted/blocked call, or a lost result). */
const RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;

function pruneReservations(now = Date.now()): void {
  for (const [id, reservation] of reservedCredits) {
    if (now - reservation.at > RESERVATION_TTL_MS) reservedCredits.delete(id);
  }
}

function reservedCreditTotal(): number {
  pruneReservations();
  let total = 0;
  for (const reservation of reservedCredits.values()) total += reservation.estimate;
  return total;
}

/** A pi process can host several sessions (/new, resume, fork); budget and caches are session-scoped. */
function resetSessionAccounting(): void {
  sessionCredits = 0;
  reservedCredits.clear();
}

/** Temp files written by finalizeOutput during this process (capped). */
const createdTempFiles: string[] = [];
const MAX_TRACKED_TEMP_FILES = 200;

/** Background research tasks, aborted on session shutdown. */
const backgroundTasks = new Set<AbortController>();

/**
 * In-session response cache for identical search/extract calls.
 *
 * The prompt already tells the model not to repeat a query, but a prompt is
 * advice: a repeat costs credits. A five-minute cache makes the rule cheap to
 * follow and turns a re-run into an instant, zero-credit result.
 */
interface CacheEntry {
  at: number;
  content: string;
  structuredContent: Record<string, unknown>;
  details: Record<string, unknown>;
}
const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 32;

function cacheKey(endpoint: string, body: unknown, dropped: readonly string[] = []): string {
  // `dropped` is part of the key: two calls can have the same API body while one
  // reports "[dropped: country ...]" and the other does not.
  return `${endpoint}|${JSON.stringify(body)}|${dropped.join(";")}`;
}

function cacheGet(key: string, ttlSeconds: number): CacheEntry | undefined {
  if (ttlSeconds <= 0) return undefined;
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlSeconds * 1000) {
    cache.delete(key);
    return undefined;
  }
  // Refresh insertion order so Map iteration is LRU.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cachePut(key: string, entry: Omit<CacheEntry, "at">, ttlSeconds: number): void {
  if (ttlSeconds <= 0) return;
  cache.set(key, { ...entry, at: Date.now() });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Report something to the user; in headless modes the notification would be dropped. */
function warn(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
    return;
  }
  // In print/JSON/RPC mode notify() is a no-op, so a startup warning would be
  // invisible until the first failing call. stderr keeps it observable.
  console.error(`[tavily] ${message}`);
}

// ============================================================
//  Shared rendering helpers (compact by default, expand on demand)
// ============================================================

/**
 * pi's built-in renderers reuse `context.lastComponent` and call `setText` on it
 * instead of allocating a new component per frame (readRenderer/renderResult in
 * pi's own tool definitions). Streaming research re-renders on every SSE update,
 * so reuse avoids a component (and layout) per token. Falls back to a new Text
 * when the previous component is not ours or the slot is empty.
 */
function renderText(context: any, text: string): Text {
  const previous = context?.lastComponent;
  if (previous && typeof previous.setText === "function") {
    previous.setText(text);
    return previous as Text;
  }
  return new Text(text, 0, 0);
}

/** Short one-line header for the tool call row. */
function callHeader(label: string, detail: (args: Record<string, unknown>) => string) {
  return (args: Record<string, unknown>, theme: any, context?: any) => {
    let text = theme.fg("toolTitle", theme.bold(`${label} `));
    text += theme.fg("accent", detail(args));
    return renderText(context, text);
  };
}

/**
 * Elapsed time for a finished call: pi sets `context.durationMs` on the final
 * render only (undefined while streaming). One decimal below a minute, m/s above.
 */
function durationTag(context: any, theme: any): string {
  const ms = context?.durationMs;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  let text: string;
  if (ms < 1000) {
    text = `${Math.round(ms)}ms`;
  } else {
    const totalSeconds = Math.round(ms / 1000);
    text =
      totalSeconds < 60
        ? `${(ms / 1000).toFixed(1)}s`
        : `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, "0")}s`;
  }
  return theme.fg("dim", ` · ${text}`);
}

/**
 * Compact result renderer:
 * - streaming: the streamed progress text from `onUpdate`
 * - error: first line of the error, in red
 * - collapsed (default): one-line summary plus elapsed time
 * - expanded (ctrl+o): full result text (capped at 100 lines for display)
 */
function compactResult(
  partialText: string,
  summary: (result: any, theme: any) => string,
  maxDisplayLines = 100,
) {
  return (result: any, options: any, theme: any, context?: any) => {
    if (options.isPartial) {
      // pi passes the streamed onUpdate payload as result.content (interactive-mode:
      // updateResult({ ...event.partialResult }, true)). Show it so long calls —
      // research polls for minutes — display real progress instead of one static label.
      const streamed = result.content?.find?.((block: any) => block?.type === "text")?.text;
      return renderText(context, theme.fg("warning", streamed || partialText));
    }
    const content = result.content?.[0];
    const text = content?.type === "text" ? content.text : "";
    if (result.isError) {
      return renderText(context, theme.fg("error", text.split("\n")[0] || "Tavily 调用失败"));
    }
    const head = summary(result, theme) + durationTag(context, theme);
    if (!options.expanded) return renderText(context, head);
    const lines = text.split("\n");
    const shown = lines.slice(0, maxDisplayLines).join("\n");
    const more =
      lines.length > maxDisplayLines
        ? `\n${theme.fg("muted", `…(${lines.length - maxDisplayLines} 行已省略)`)}`
        : "";
    return renderText(context, `${head}\n${theme.fg("dim", shown)}${more}`);
  };
}

const creditTag = (result: any, theme: any) => {
  const credits = result.details?.credits;
  if (result.details?.cached) return theme.fg("dim", " · 缓存 0 credit");
  return credits !== undefined
    ? theme.fg("dim", ` · ${credits} ${credits === 1 ? "credit" : "credits"}`)
    : "";
};

// ============================================================
//  Result formatting
// ============================================================

const progress = (text: string) => ({ content: [{ type: "text", text } as const], details: {} });

/** Progress text for a 429 cooldown wait, so a slow call never looks hung. */
const waitProgress = (seconds: number) => progress(`⏳ 所有 Key 限流中，等待 ${seconds}s…`);

// ---------- Output truncation (protect the LLM context) ----------
//
// Oversized results are head-truncated to pi's built-in limits (50KB / 2000
// lines) and the FULL text is written to a temp file. The path is appended to
// the returned text so the model can pull specific ranges on demand via the
// read tool (offset/limit) instead of ingesting everything at once — nothing
// is lost, it just stops being force-fed into context.

const TEMP_FILE_PREFIX = "pi-tavily-";
/**
 * Spill files are referenced from transcripts, and a session can be resumed
 * days later. 24h was too aggressive: a resumed session pointed at a file that
 * had already been swept. A week covers normal use and still bounds the temp dir.
 */
const TEMP_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Sweep at most this often when writing new spill files (always runs at session start). */
const SWEEP_THROTTLE_MS = 60 * 60 * 1000;
let lastSweepAt = 0;

/**
 * Best-effort removal of stale spill files left behind by earlier runs, so a
 * crashed or simply closed process does not leave them in the temp directory
 * forever. The 7-day TTL is the owner of a file's lifetime: spill files are
 * kept on quit because a transcript can be resumed later and still references
 * `full_output_path`.
 *
 * Runs asynchronously: a large temp directory (Windows) must not delay session
 * start. Files this process created are skipped — the transcript may still
 * reference them and they are swept by a later process after the TTL.
 */
async function sweepStaleTempFiles(): Promise<void> {
  lastSweepAt = Date.now();
  try {
    const names = await readdirAsync(tmpdir());
    const now = Date.now();
    await Promise.all(
      names
        .filter((name) => name.startsWith(TEMP_FILE_PREFIX) && name.endsWith(".md"))
        .map(async (name) => {
          const full = join(tmpdir(), name);
          if (createdTempFiles.includes(full)) return;
          try {
            const info = await statAsync(full);
            if (now - info.mtimeMs > TEMP_FILE_MAX_AGE_MS) await rmAsync(full, { force: true });
          } catch {
            // another process may be reading/writing it; ignore
          }
        }),
    );
  } catch {
    // non-fatal
  }
}

/** Cheap re-sweep when a new spill is written; at most once per SWEEP_THROTTLE_MS. */
function maybeSweepStaleTempFiles(): void {
  if (Date.now() - lastSweepAt > SWEEP_THROTTLE_MS) void sweepStaleTempFiles();
}

/**
 * Formatted result in two views: `full` is the untruncated text (written to
 * the spill file), `head` is the per-item-capped text shown to the model first.
 */
function finalizeOutput(
  input: string | FormattedOutput,
  endpoint: string,
): { text: string; truncated: boolean; spillPath?: string } {
  const full = typeof input === "string" ? input : input.full;
  const headSource = typeof input === "string" ? input : input.head;

  const t = truncateHead(headSource, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  // Per-item capping is itself a truncation: when only that fired, the old code
  // stopped here and silently dropped the item tails even though the note told
  // the model to read them from the spill file. Always spill when full != headSource.
  const itemCapped = headSource !== full;
  if (!t.truncated && !itemCapped) return { text: full, truncated: false };

  // Unique per call: pi runs tools in parallel by default, so a millisecond
  // timestamp alone lets concurrent calls overwrite each other's spill file.
  const file = join(
    tmpdir(),
    `${TEMP_FILE_PREFIX}${endpoint}-${Date.now()}-${process.pid}-${randomBytes(4).toString("hex")}.md`,
  );

  // Line-based truncation keeps whole lines, so a payload containing a few
  // enormous lines (a page minified into one line, a single-line JSON blob)
  // loses them entirely and leaves the model with just the header. Detect that
  // and fall back to a byte-safe hard slice so it still sees a useful prefix.
  const maxLineBytes = headSource
    .split("\n")
    .reduce((m, line) => Math.max(m, Buffer.byteLength(line, "utf8")), 0);
  const lineTruncationDegenerate =
    t.firstLineExceedsLimit || maxLineBytes > DEFAULT_MAX_BYTES * 0.5;
  const head = lineTruncationDegenerate
    ? sliceByBytes(headSource, Math.floor(DEFAULT_MAX_BYTES * 0.9))
    : t.content;

  const reasons: string[] = [];
  if (itemCapped) reasons.push("单条内容过长已压缩");
  if (t.truncated) {
    const stats = `${t.outputLines}/${t.totalLines} 行 · ${formatSize(t.outputBytes)}/${formatSize(t.totalBytes)}`;
    reasons.push(
      lineTruncationDegenerate
        ? `输出已截断: ${stats}（含超长行，已按字节硬切开头部分）`
        : `输出已截断: ${stats}`,
    );
  }
  const note = reasons.join("；");

  try {
    // 0o600: the file holds full third-party page text; keep it owner-only.
    writeFileSync(file, full, { mode: 0o600 });
    createdTempFiles.push(file);
    if (createdTempFiles.length > MAX_TRACKED_TEMP_FILES) createdTempFiles.shift();
    maybeSweepStaleTempFiles();
    return {
      text:
        `${head}\n\n` +
        `[${note}。完整内容已保存到 ${file}，用 read 工具按 offset/limit 分段读取` +
        ` / full text saved to ${file}; read it with offset/limit]`,
      truncated: true,
      spillPath: file,
    };
  } catch {
    // temp file write failed: still return the head, minus the pointer
    return {
      text: `${head}\n\n[注意: ${note}（临时文件写入失败，无法提供完整内容）]`,
      truncated: true,
    };
  }
}

// ---------- Failure results ----------
//
// Failures are returned with `isError: true` instead of thrown so the details
// (endpoint, status, request_id) survive into the transcript and the renderer;
// a thrown error carries nothing but its message. User cancellation is the one
// exception: it propagates as AbortError so pi handles it natively.
function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return (err as Error)?.name === "AbortError" || signal?.aborted === true;
}

function failure(endpoint: string, err: unknown, extra: Record<string, unknown> = {}) {
  const te = err as { status?: number; requestId?: string };
  return {
    content: [{ type: "text" as const, text: formatTavilyError(err) }],
    details: {
      endpoint,
      error: true,
      status: te?.status,
      request_id: te?.requestId,
      ...extra,
    },
    isError: true,
  };
}

// ============================================================
//  Guards: secrets, budget, file uploads
// ============================================================

/**
 * Patterns that must never leave the machine inside a query or URL. The prompt
 * asks the model not to leak secrets; this makes it a fact instead of a hope.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\btvly-[A-Za-z0-9_-]{8,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
];

function findSecretLike(value: unknown, path = "input"): string | undefined {
  if (typeof value === "string") {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(value)) return path;
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findSecretLike(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const found = findSecretLike(inner, `${path}.${key}`);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Upper-bound credit estimate used by the budget gate. Tavily bills by usage,
 * so these are deliberately conservative: extract is priced per 5 URLs,
 * map/crawl per 10 pages, and crawl is mapping + extraction (see
 * https://docs.tavily.com/documentation/api-credits).
 */
function estimateCredits(toolName: string, input: Record<string, unknown>): number {
  if (toolName === "tavily_research") {
    const model = input.model ?? resolveDefaultResearchModel();
    return model === "mini" ? 110 : 250;
  }

  if (toolName === "tavily_extract") {
    const urls = Array.isArray(input.urls) ? input.urls.length : 1;
    const perFive = input.extract_depth === "advanced" ? 2 : 1;
    return Math.max(1, Math.ceil(Math.max(urls, 1) / 5) * perFive);
  }

  if (toolName === "tavily_map") {
    const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : 50;
    const perTen = input.instructions ? 2 : 1;
    return Math.max(1, Math.ceil(limit / 10) * perTen);
  }

  if (toolName === "tavily_crawl") {
    const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : 50;
    const mapPerTen = input.instructions ? 2 : 1;
    const extractPerFive = input.extract_depth === "advanced" ? 2 : 1;
    return Math.max(
      1,
      Math.ceil(limit / 10) * mapPerTen + Math.ceil(limit / 5) * extractPerFive,
    );
  }

  // Search: advanced costs 2, and auto_parameters can also select a 2-credit
  // path; use 2 as the upper bound regardless of the requested depth.
  return 2;
}

/**
 * Cache key for a call that would be served from the in-session cache, if any.
 * Used by the budget gate to let a zero-credit cache hit run even after the
 * session budget is exhausted. Returns undefined when the tool is not cached
 * (map/crawl/research) or the input does not build (the schema rejects it).
 */
function cachedCallKey(
  toolName: string,
  input: Record<string, unknown>,
  searchDepth: NonNullable<SearchToolParams["search_depth"]>,
  maxResults: number,
): string | undefined {
  try {
    if (toolName === "tavily_search" && input.media !== true) {
      const { body, dropped } = buildSearchBody(input as SearchToolParams, {
        searchDepth,
        maxResults,
        resolveCountry,
      });
      return cacheKey("search", body, dropped);
    }
    if (toolName === "tavily_extract" && input.media !== true) {
      const { body, dropped } = buildExtractBody(input as ExtractToolParams);
      return cacheKey("extract", body, dropped);
    }
  } catch {
    // Invalid arguments are rejected by pi's schema validation before execute.
  }
  return undefined;
}

/**
 * Scan research attachment contents before they leave the machine.
 *
 * The argument scan above only sees file paths; a `.json` or `.md` attachment
 * can itself contain a key or token. Files are stat'ed first so an oversized
 * file is never read into memory here (readResearchFiles rejects it later).
 * Returns the offending path, or flags a size failure; `findSecretLike` on the
 * argument object cannot see inside the files.
 */
function scanResearchFilesForSecrets(
  paths: string[],
  cwd: string,
): { secretAt?: string; tooLarge?: boolean } {
  let total = 0;
  for (const path of paths.slice(0, MAX_FILES)) {
    const absolute = resolve(cwd, path);
    if (!ALLOWED_FILE_EXT.has(extname(absolute).toLowerCase())) continue;
    let size = 0;
    try {
      const info = statSync(absolute);
      if (!info.isFile()) continue;
      size = info.size;
    } catch {
      // Missing/unreadable file: readResearchFiles reports the concrete error.
      continue;
    }
    total += size;
    if (total > MAX_TOTAL_ENCODED_BYTES) {
      return { tooLarge: true };
    }
    try {
      const text = readFileSync(absolute, "utf8");
      if (findSecretLike(text, absolute)) return { secretAt: absolute };
    } catch {
      // Let readResearchFiles produce the read error.
    }
  }
  return {};
}

// ============================================================
//  Extension entry
// ============================================================

export default function tavilyExtension(pi: ExtensionAPI) {
  // ---------- Startup ----------
  pi.on("session_start", async (_event, ctx) => {
    ensureConfigTemplate();
    void sweepStaleTempFiles();
    // A pi process can host several sessions; budget, response cache and the
    // fetched-URL set must not leak across them.
    resetSessionAccounting();
    cache.clear();
    seenUrls.clear();
    keyManager.update(resolveApiKeys());
    // Distinguish "config.json is malformed" from "no keys configured": the former
    // points at the syntax error, the latter at the template to copy.
    const parseError = configReadError();
    if (parseError) {
      warn(
        ctx,
        `Tavily 插件已加载，但 config.json 解析失败：${parseError}。请检查 ${CONFIG_PATH} 的 JSON 格式（多余的逗号、引号等）。`,
        "error",
      );
      return;
    }
    if (resolveApiKeys().length === 0) {
      warn(
        ctx,
        `Tavily 插件已加载，但未配置 API Key。请把 ${TEMPLATE_PATH} 复制为 config.json，并在 apiKeys 中填入 Key（支持多个 Key 自动轮换）。`,
        "error",
      );
      return;
    }
  });

  // Spill files are intentionally kept on quit: a transcript can be resumed
  // days later and still references `full_output_path`, so their lifetime is
  // owned by the 7-day temp sweep rather than by process shutdown.
  pi.on("session_shutdown", () => {
    for (const controller of backgroundTasks) controller.abort();
    backgroundTasks.clear();
  });

  // ---------- Guards ----------
  //
  // tool_call runs before every call, including nested ones issued through
  // ctx.executeTool(), so a codemode script cannot bypass the budget either.
  pi.on("tool_call", async (event, ctx) => {
    if (!event.toolName.startsWith("tavily_")) return;
    const input = (event.input ?? {}) as Record<string, unknown>;

    const secretAt = findSecretLike(input);
    if (secretAt) {
      return {
        block: true,
        reason:
          `检测到疑似密钥/令牌出现在 ${secretAt}。Tavily 会把参数发送到第三方服务器，` +
          `请改写查询，不要把密钥、token 或私钥放进搜索参数。 / ` +
          `Refusing to send what looks like a credential in ${secretAt}.`,
      };
    }

    const max = resolveMaxSessionCredits();
    if (max > 0) {
      // A cache hit costs 0 credits, so it must stay usable after the budget is
      // exhausted. Build the same key execute() will use.
      const cacheKeyForCall = cachedCallKey(
        event.toolName,
        input,
        resolveDepth(),
        resolveDefaultMaxResults(),
      );
      const cached = cacheKeyForCall
        ? cacheGet(cacheKeyForCall, resolveCacheTtlSeconds())
        : undefined;
      if (!cached) {
        const estimate = estimateCredits(event.toolName, input);
        const used = sessionCredits + reservedCreditTotal();
        if (used >= max || used + estimate > max) {
          return {
            block: true,
            reason:
              `Tavily 会话预算 ${max} credits 不足：已用 ${sessionCredits}，进行中预留 ${reservedCreditTotal()}，本次预估 ${estimate}。` +
              `继续请调大 config.json 的 maxSessionCredits，或改用更便宜的参数（search_depth=basic / model=mini）。`,
          };
        }
        reservedCredits.set(event.toolCallId, { estimate, at: Date.now() });
      }
    }

    if (
      event.toolName === "tavily_research" &&
      Array.isArray(input.files) &&
      input.files.length > 0
    ) {
      const files = input.files.map(String);
      const scan = scanResearchFilesForSecrets(files, ctx.cwd);
      if (scan.tooLarge) {
        return {
          block: true,
          reason:
            "Research 附加文件总大小超过限制（约 80,000 词 / 500KB，按上传后的大小计算），请精简文件内容。",
        };
      }
      if (scan.secretAt) {
        return {
          block: true,
          reason:
            `研究附件内容疑似包含密钥/令牌：${scan.secretAt}。文件会被发送到 api.tavily.com，` +
            `请移除或改写其中的凭证后再试。 / Refusing to upload what looks like a credential in ${scan.secretAt}.`,
        };
      }

      if (!ctx.hasUI) {
        // No dialog in print/JSON/RPC mode: uploading local file contents
        // without an explicit opt-in would be silent. Require the flag.
        if (pi.getFlag("tavily-allow-file-upload") !== true) {
          return {
            block: true,
            reason:
              "无 UI 模式下拒绝上传本地研究文件（无法弹窗确认）。如确需上传，请加 --tavily-allow-file-upload；" +
              "文件内容仍会做密钥扫描。 / Headless file uploads require --tavily-allow-file-upload.",
          };
        }
      } else {
        const ok = await ctx.ui.confirm(
          "上传本地文件到 Tavily?",
          `以下文件内容会被发送到 api.tavily.com（已做密钥扫描）：\n${files.join("\n")}`,
        );
        if (!ok) return { block: true, reason: "用户拒绝把本地文件上传到 Tavily" };
      }
    }
  });

  // ---------- Rule-injection self-check ----------
  // pi builds the <rules> block from the promptGuidelines of the *declared* tools,
  // and skips that block entirely when a customPrompt / forced system prompt is
  // configured. The tools keep working either way, so without this check the loss
  // is silent: the model gets five web tools and no policy for when to use them.
  const RULES_FINGERPRINT = RULES.safety;
  let warnedRulesMissing = false;
  pi.on("before_agent_start", (event, ctx) => {
    if (warnedRulesMissing) return;
    const opts = event.systemPromptOptions;
    const declared = (opts?.selectedTools ?? []).filter((name) => name.startsWith("tavily_"));
    if (declared.length === 0) return;
    // Hidden declarations (a codemode loadout) are deliberate: the orchestrating
    // tool is expected to present the guidance itself, so stay quiet there.
    const hidden = opts?.hiddenTools ?? [];
    if (declared.some((name) => hidden.includes(name))) return;
    const guidelines = opts?.toolGuidelines ?? {};
    if (!declared.some((name) => (guidelines[name]?.length ?? 0) > 0)) return;
    if (event.systemPrompt.includes(RULES_FINGERPRINT)) return;
    warnedRulesMissing = true;
    warn(
      ctx,
      "Tavily 工具已启用，但它的路由/证据/安全规则没有进入系统提示（通常是设置了 customPrompt 或强制系统提示）。" +
        "工具仍可用，但模型不会知道何时该用哪个；把这些规则并入你的自定义提示，或去掉自定义系统提示。",
      "warning",
    );
  });

  // ---------- CLI flag + shortcut ----------
  //
  // `prepareLoadout` / `reachesTools` (review item C15) are deliberately not used:
  // they exist for orchestrating tools that hide or discover other tools, while
  // these five are declared directly. The one nested call (research → extract via
  // ctx.executeTool) is hardcoded, not named by the model, so no reach declaration
  // is involved.
  pi.registerFlag("tavily-depth", {
    description: "Override tavily_search default search_depth (basic|advanced|fast|ultra-fast)",
    type: "string",
  });
  pi.registerFlag("tavily-allow-file-upload", {
    description:
      "Allow tavily_research `files` uploads in headless modes (no UI confirmation). Contents are still scanned for credentials.",
    type: "boolean",
  });
  const sessionIdOf = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();

  /** Effective search depth: CLI flag > config > "advanced". */
  const resolveDepth = (): NonNullable<SearchToolParams["search_depth"]> => {
    const flag = pi.getFlag("tavily-depth");
    if (typeof flag === "string") {
      const normalized = flag.trim().toLowerCase();
      if (["basic", "advanced", "fast", "ultra-fast"].includes(normalized)) {
        return normalized as NonNullable<SearchToolParams["search_depth"]>;
      }
    }
    return resolveDefaultSearchDepth() ?? "advanced";
  };

  // Prompt text (description, snippet, guidelines) is built once at load from
  // config; execute() re-reads config per call, so billing is never stale.
  const prompts = buildToolPrompts({
    defaultSearchDepth: resolveDepth(),
    defaultResearchModel: resolveDefaultResearchModel() ?? "pro",
  });

  // Background research calls addCredits directly when its task finishes; every
  // other call is recorded once by the tool_result handler below.
  const addCredits = (credits: number | undefined) => {
    if (typeof credits === "number" && Number.isFinite(credits) && credits > 0) {
      sessionCredits += credits;
    }
  };

  // Record actual spend from the result itself. Doing this in each execute path
  // double-counted nested calls (research -> extract_sources) and could not see
  // cache hits or failures; the reservation is released here as well.
  pi.on("tool_result", (event) => {
    if (!event.toolName.startsWith("tavily_")) return;
    reservedCredits.delete(event.toolCallId);
    const details = event.details as { credits?: unknown } | undefined;
    const credits = details?.credits;
    if (typeof credits === "number") addCredits(credits);
  });

  // A call blocked by another extension (or aborted before it starts) never
  // produces a tool_result, so drop its reservation when the turn ends. A
  // background research uses a `bg:` key and must keep its reservation until the
  // task itself finishes.
  pi.on("turn_end", () => {
    for (const id of [...reservedCredits.keys()]) {
      if (!id.startsWith("bg:")) reservedCredits.delete(id);
    }
  });

  // ---------- tavily_search ----------
  pi.registerTool({
    name: "tavily_search",
    label: "Tavily Search",
    annotations: TAVILY_ANNOTATIONS,
    constrainedSampling: TAVILY_CONSTRAINED_SAMPLING,
    namespace: TAVILY_NAMESPACE,
    ...prompts.tavily_search,
    parameters: searchSchema,
    outputSchema: searchOutputSchema,
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
        const { body, dropped } = buildSearchBody(params, {
          searchDepth: resolveDepth(),
          maxResults: resolveDefaultMaxResults(),
          resolveCountry,
        });

        // Media results carry image blocks and are never cached.
        const ttl = resolveCacheTtlSeconds();
        const key = cacheKey("search", body, dropped);
        if (!params.media) {
          const hit = cacheGet(key, ttl);
          if (hit) {
            return {
              content: [{ type: "text" as const, text: hit.content }],
              structuredContent: clean({ ...hit.structuredContent, cached: true, credits: 0 }),
              details: { ...hit.details, cached: true, credits: 0 },
            };
          }
        }

        const resp = await tavilySearch(
          body,
          sessionIdOf(ctx),
          signal,
          (s) => onUpdate?.(waitProgress(s)),
        );
        const out = finalizeOutput(formatSearch(resp, dropped, seenUrls), "search");
        const rawResults = resp.results ?? [];
        const structuredCapped = rawResults.some((r) => r.raw_content && exceedsCap(r.raw_content));
        const structuredContent = clean({
          endpoint: "search" as const,
          query: resp.query,
          results_count: rawResults.length,
          has_answer: !!resp.answer,
          answer: resp.answer,
          results: rawResults.map((r) =>
            clean({
              title: r.title ?? "",
              url: r.url ?? "",
              score: r.score,
              published_date: r.published_date,
              content: r.content,
              raw_content: r.raw_content ? capStructuredText(r.raw_content) : r.raw_content,
            }),
          ),
          request_id: resp.request_id,
          credits: resp.usage?.credits,
          response_time: resp.response_time,
          truncated: out.truncated,
          structured_truncated: structuredCapped || undefined,
          full_output_path: out.spillPath,
          dropped_params: dropped.length ? dropped : undefined,
        });
        const details = {
          endpoint: "search",
          query: resp.query,
          results_count: rawResults.length,
          has_answer: !!resp.answer,
          request_id: resp.request_id,
          credits: resp.usage?.credits,
          response_time: resp.response_time,
          truncated: out.truncated,
          full_output_path: out.spillPath,
          ...(dropped.length ? { dropped_params: dropped } : {}),
        };

        if (!params.media) cachePut(key, { content: out.text, structuredContent, details }, ttl);

        const images = params.media
          ? await fetchImageBlocks(
              [
                ...(resp.images ?? []).map((i) => i.url),
                ...rawResults.flatMap((r) => (r.images ?? []).map((i) => i.url)),
              ],
              { signal },
            )
          : [];

        return {
          content: [{ type: "text" as const, text: out.text }, ...images],
          structuredContent,
          details,
        };
      } catch (err) {
        if (isAbort(err, signal)) throw err;
        return failure("search", err, { query: params.query });
      }
    },
  });

  // ---------- tavily_extract ----------
  pi.registerTool({
    name: "tavily_extract",
    label: "Tavily Extract",
    annotations: TAVILY_ANNOTATIONS,
    constrainedSampling: TAVILY_CONSTRAINED_SAMPLING,
    namespace: TAVILY_NAMESPACE,
    ...prompts.tavily_extract,
    parameters: extractSchema,
    outputSchema: extractOutputSchema,
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
        const { body, dropped } = buildExtractBody(params);

        const ttl = resolveCacheTtlSeconds();
        const key = cacheKey("extract", body, dropped);
        if (!params.media) {
          const hit = cacheGet(key, ttl);
          if (hit) {
            return {
              content: [{ type: "text" as const, text: hit.content }],
              structuredContent: clean({ ...hit.structuredContent, cached: true, credits: 0 }),
              details: { ...hit.details, cached: true, credits: 0 },
            };
          }
        }

        const resp = await tavilyExtract(
          body,
          sessionIdOf(ctx),
          signal,
          (s) => onUpdate?.(waitProgress(s)),
        );
        const out = finalizeOutput(formatExtract(resp, dropped, seenUrls), "extract");
        const structuredCapped = (resp.results ?? []).some(
          (r) => r.raw_content && exceedsCap(r.raw_content),
        );
        const structuredContent = clean({
          endpoint: "extract" as const,
          extracted_count: (resp.results ?? []).length,
          failed_count: (resp.failed_results ?? []).length,
          results: (resp.results ?? []).map((r) => ({
            url: r.url ?? "",
            raw_content: capStructuredText(r.raw_content ?? ""),
          })),
          failed_results: (resp.failed_results ?? []).map((f) => ({
            url: f.url ?? "",
            error: f.error ?? "",
          })),
          request_id: resp.request_id,
          credits: resp.usage?.credits,
          response_time: resp.response_time,
          truncated: out.truncated,
          structured_truncated: structuredCapped || undefined,
          full_output_path: out.spillPath,
          dropped_params: dropped.length ? dropped : undefined,
        });
        const details = {
          endpoint: "extract",
          extracted_count: (resp.results ?? []).length,
          failed_count: (resp.failed_results ?? []).length,
          request_id: resp.request_id,
          credits: resp.usage?.credits,
          response_time: resp.response_time,
          failed: resp.failed_results,
          truncated: out.truncated,
          full_output_path: out.spillPath,
          ...(dropped.length ? { dropped_params: dropped } : {}),
        };

        if (!params.media) cachePut(key, { content: out.text, structuredContent, details }, ttl);

        const images = params.media
          ? await fetchImageBlocks(
              (resp.results ?? []).flatMap((r) => r.images ?? []),
              { signal },
            )
          : [];

        return {
          content: [{ type: "text" as const, text: out.text }, ...images],
          structuredContent,
          details,
        };
      } catch (err) {
        if (isAbort(err, signal)) throw err;
        return failure("extract", err, { urls: params.urls });
      }
    },
  });

  // ---------- tavily_map ----------
  pi.registerTool({
    name: "tavily_map",
    label: "Tavily Map",
    annotations: TAVILY_ANNOTATIONS,
    constrainedSampling: TAVILY_CONSTRAINED_SAMPLING,
    namespace: TAVILY_NAMESPACE,
    ...prompts.tavily_map,
    parameters: mapSchema,
    outputSchema: mapOutputSchema,
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
        const { body } = buildMapBody(params);

        const resp = await tavilyMap(
          body,
          sessionIdOf(ctx),
          signal,
          (s) => onUpdate?.(waitProgress(s)),
        );
        const out = finalizeOutput(formatMap(resp), "map");
        return {
          content: [{ type: "text" as const, text: out.text }],
          structuredContent: clean({
            endpoint: "map" as const,
            base_url: resp.base_url,
            url_count: resp.results.length,
            urls: resp.results,
            request_id: resp.request_id,
            credits: resp.usage?.credits,
            response_time: resp.response_time,
            truncated: out.truncated,
            full_output_path: out.spillPath,
          }),
          details: {
            endpoint: "map",
            base_url: resp.base_url,
            url_count: resp.results.length,
            request_id: resp.request_id,
            credits: resp.usage?.credits,
            response_time: resp.response_time,
            truncated: out.truncated,
            full_output_path: out.spillPath,
          },
        };
      } catch (err) {
        if (isAbort(err, signal)) throw err;
        return failure("map", err, { url: params.url });
      }
    },
  });

  // ---------- tavily_crawl ----------
  pi.registerTool({
    name: "tavily_crawl",
    label: "Tavily Crawl",
    annotations: TAVILY_ANNOTATIONS,
    constrainedSampling: TAVILY_CONSTRAINED_SAMPLING,
    namespace: TAVILY_NAMESPACE,
    ...prompts.tavily_crawl,
    parameters: crawlSchema,
    outputSchema: crawlOutputSchema,
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
        const { body, dropped } = buildCrawlBody(params);

        const resp = await tavilyCrawl(
          body,
          sessionIdOf(ctx),
          signal,
          (s) => onUpdate?.(waitProgress(s)),
        );
        const out = finalizeOutput(formatCrawl(resp, dropped, seenUrls), "crawl");
        const pages = resp.results ?? [];
        const structuredCapped = pages.some((p) => p.raw_content && exceedsCap(p.raw_content));
        const structuredContent = clean({
          endpoint: "crawl" as const,
          base_url: resp.base_url,
          page_count: pages.length,
          pages: pages.map((p) => ({
            url: p.url ?? "",
            raw_content: capStructuredText(p.raw_content ?? ""),
          })),
          request_id: resp.request_id,
          credits: resp.usage?.credits,
          response_time: resp.response_time,
          truncated: out.truncated,
          structured_truncated: structuredCapped || undefined,
          full_output_path: out.spillPath,
          dropped_params: dropped.length ? dropped : undefined,
        });

        const images = params.media
          ? await fetchImageBlocks(
              pages.flatMap((p) => p.images ?? []),
              { signal },
            )
          : [];

        return {
          content: [{ type: "text" as const, text: out.text }, ...images],
          structuredContent,
          details: {
            endpoint: "crawl",
            base_url: resp.base_url,
            page_count: pages.length,
            request_id: resp.request_id,
            credits: resp.usage?.credits,
            response_time: resp.response_time,
            truncated: out.truncated,
            full_output_path: out.spillPath,
            ...(dropped.length ? { dropped_params: dropped } : {}),
          },
        };
      } catch (err) {
        if (isAbort(err, signal)) throw err;
        return failure("crawl", err, { url: params.url });
      }
    },
  });

  // ---------- tavily_research ----------

  /**
   * Read the report's cited pages (opt-in `extract_sources`) and return a
   * capped, clearly-labelled excerpt block. Runs through ctx.executeTool, so it
   * passes the same validation and budget gate as a model-issued call.
   */
  async function extractCitedSources(
    result: ResearchResult,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
    onUpdate?: (partial: ReturnType<typeof progress>) => void,
  ): Promise<string> {
    const urls = result.sources
      .map((s) => s.url)
      .filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url))
      .slice(0, 3);
    if (urls.length === 0) return "";
    onUpdate?.(progress(`📄 读取 ${urls.length} 个引用来源…`));
    try {
      const nested = await ctx.executeTool("tavily_extract", { urls, format: "markdown" }, { signal });
      const text =
        nested.result.content.find((block) => block.type === "text")?.text ?? "";
      // The nested tool's own result goes through the tool_result handler, which
      // records its credits; adding them here would count them twice.
      if (!text.trim()) return "";
      const capped = capStructuredText(text, 6 * 1024);
      return `\n\n## 引用原文（节选，来自 ${urls.length} 个来源）\n${capped}`;
    } catch (err) {
      if (isAbort(err, signal)) throw err;
      return `\n\n[extract_sources 失败：${formatTavilyError(err)}]`;
    }
  }

  /**
   * Background research: start the task, return immediately, and deliver the
   * report as a custom message when it finishes. Aborted on session shutdown.
   */
  function startBackgroundResearch(
    params: ResearchParams,
    maxWaitSeconds: number,
    sessionId: string,
    outerSignal: AbortSignal | undefined,
    ctx: ExtensionContext,
    extractSources: boolean,
    toolCallId: string,
  ): void {
    const controller = new AbortController();
    backgroundTasks.add(controller);
    const onOuterAbort = () => controller.abort();
    outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

    // The start call returns immediately, so its own reservation is released by
    // tool_result. Transfer that reservation to a `bg:` key that lives until the
    // task finishes, otherwise the budget gate cannot see the in-flight research
    // cost (and holding both would double-reserve the same task).
    const reservationKey = `bg:${toolCallId}`;
    reservedCredits.delete(toolCallId);
    reservedCredits.set(reservationKey, {
      estimate: estimateCredits("tavily_research", { model: params.model }),
      at: Date.now(),
    });

    void (async () => {
      try {
        const result = await runResearch(params, {
          sessionId,
          signal: controller.signal,
          maxWaitSeconds,
          // Background work has no live UI target: progress would either be
          // stale (old ctx) or fight the foreground turn, so it is dropped.
        });
        // Streaming usage is not in the SSE frames; fetch it here so the
        // delivered report and the session budget both carry the real cost.
        if (params.stream) {
          await backfillResearchUsage(result, sessionId, controller.signal);
        }
        const extra =
          extractSources && !result.partial
            ? await extractCitedSources(result, controller.signal, ctx)
            : "";
        const out = finalizeOutput(formatResearch(result) + extra, "research");
        addCredits(result.credits);
        pi.sendMessage(
          {
            customType: "tavily-research",
            content: out.text,
            display: true,
            details: {
              endpoint: "research",
              request_id: result.requestId,
              model: result.model,
              source_count: result.sources.length,
              partial: result.partial === true,
              credits: result.credits,
            },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } catch (err) {
        if (controller.signal.aborted) return;
        pi.sendMessage(
          {
            customType: "tavily-research",
            content: `后台研究失败 / background research failed: ${formatTavilyError(err)}`,
            display: true,
            details: { endpoint: "research", error: true },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } finally {
        reservedCredits.delete(reservationKey);
        backgroundTasks.delete(controller);
        outerSignal?.removeEventListener("abort", onOuterAbort);
      }
    })();
  }

  pi.registerTool({
    name: "tavily_research",
    label: "Tavily Research",
    annotations: TAVILY_RESEARCH_ANNOTATIONS,
    constrainedSampling: TAVILY_CONSTRAINED_SAMPLING,
    namespace: TAVILY_NAMESPACE,
    ...prompts.tavily_research,
    parameters: researchSchema,
    outputSchema: researchOutputSchema,
    renderCall: callHeader("tavily_research", (args) => String(args.input ?? "").slice(0, 60)),
    renderResult: compactResult(
      "🧠 研究中…",
      (result, theme) =>
        (result.details?.partial
          ? theme.fg("warning", "⚠ 部分结果（任务中断，已回收）")
          : result.details?.background
            ? theme.fg("accent", "⏳ 后台研究已启动")
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
        if (params.output_schema !== undefined) {
          // Accept a JSON string (historical, codemode-friendly) or a real object.
          let schema: unknown = params.output_schema;
          if (typeof schema === "string") {
            try {
              schema = JSON.parse(schema);
            } catch {
              throw new Error(
                "output_schema 不是合法的 JSON，请检查格式（例如 {\"properties\":{...},\"required\":[...]}）。",
              );
            }
          }
          if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
            throw new Error("output_schema 必须是 JSON Schema 对象（不是数组或标量）。");
          }
          researchParams.output_schema = schema as Record<string, unknown>;
        }
        if (params.files?.length) {
          researchParams.files = readResearchFiles(params.files, ctx.cwd);
        }

        const maxWaitSeconds = params.max_wait ?? 600;

        if (params.background) {
          startBackgroundResearch(
            researchParams,
            maxWaitSeconds,
            sessionIdOf(ctx),
            signal,
            ctx,
            params.extract_sources === true,
            toolCallId,
          );
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `🧠 后台研究已启动（model=${researchParams.model}，最长 ${maxWaitSeconds}s）。` +
                  `完成后报告会作为新消息送达，期间可以继续别的工作。`,
              },
            ],
            structuredContent: clean({
              endpoint: "research" as const,
              source_count: 0,
              partial: false,
              content: "",
              sources: [],
            }),
            details: { endpoint: "research", background: true, model: researchParams.model },
          };
        }

        const result = await runResearch(researchParams, {
          sessionId: sessionIdOf(ctx),
          signal,
          maxWaitSeconds,
          onWait: (s) => onUpdate?.(waitProgress(s)),
          onUpdate: (text) => onUpdate?.(progress(text)),
        });

        // Streaming responses never report credits (Tavily limitation). On a
        // CLEAN finish the completed task is queryable by its real id (the
        // x-request-id response header), so fetch the actual spend. Await it
        // only when a budget depends on the number; otherwise let it finish in
        // the background instead of delaying an already-complete report.
        let backgroundUsage: Promise<void> | undefined;
        if (researchParams.stream) {
          if (resolveMaxSessionCredits() > 0) {
            await backfillResearchUsage(result, sessionIdOf(ctx), signal);
          } else {
            backgroundUsage = backfillResearchUsage(result, sessionIdOf(ctx), signal);
          }
        }

        const extra =
          params.extract_sources && !result.partial
            ? await extractCitedSources(result, signal, ctx, (p) => onUpdate?.(p))
            : "";

        const base = formatResearch(result);
        // `formatResearch` returns plain text; the extra excerpt block is already
        // capped, so the combined string goes through the same head-truncate +
        // spill path as a normal report.
        const out = finalizeOutput(extra ? base + extra : base, "research");

        // Snapshot: if the background backfill resolves before this point the
        // value is included in details (and recorded by tool_result); if it
        // resolves later, the .then below records it instead. Never both.
        const includedCredits = result.credits;
        if (backgroundUsage) {
          void backgroundUsage
            .then(() => {
              if (includedCredits === undefined) addCredits(result.credits);
            })
            .catch(() => {});
        }

        return {
          content: [{ type: "text" as const, text: out.text }],
          structuredContent: clean({
            endpoint: "research" as const,
            request_id: result.requestId,
            model: result.model,
            source_count: result.sources.length,
            partial: result.partial === true,
            content: result.content ?? "",
            sources: result.sources.map((s) => ({ title: s.title ?? "", url: s.url ?? "" })),
            response_time: result.responseTime,
            credits: includedCredits,
            truncated: out.truncated,
            full_output_path: out.spillPath,
          }),
          details: {
            endpoint: "research",
            request_id: result.requestId,
            model: result.model,
            source_count: result.sources.length,
            response_time: result.responseTime,
            credits: includedCredits,
            partial: result.partial === true,
            truncated: out.truncated,
            full_output_path: out.spillPath,
          },
        };
      } catch (err) {
        if (isAbort(err, signal)) throw err;
        return failure("research", err, { input: params.input });
      }
    },
  });
}

// ============================================================
//  Research credit backfill
// ============================================================

/**
 * Streaming research does not report credits. After a clean finish, query the
 * completed task by its real id (`x-request-id`). A fresh streamed task is not
 * immediately queryable — observed live: the first GETs 404 for ~2-3s until the
 * task propagates, and usage can lag slightly behind that — so retry with growing
 * delays. Best-effort: failFast and a short deadline keep a cooldown or slow
 * status lookup from blocking the already-finished report; `wait` is injectable
 * for offline tests.
 */
const RESEARCH_USAGE_RETRY_DELAYS_MS = [2000, 4000, 6000];

async function backfillResearchUsage(
  result: ResearchResult,
  sessionId: string,
  signal?: AbortSignal,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  if (result.partial || !result.requestId || result.requestId === "stream") return;
  for (let attempt = 0; attempt <= RESEARCH_USAGE_RETRY_DELAYS_MS.length; attempt++) {
    if (signal?.aborted) return;
    if (attempt > 0) {
      try {
        await wait(RESEARCH_USAGE_RETRY_DELAYS_MS[attempt - 1]!);
      } catch {
        return;
      }
    }
    try {
      const status = await tavilyResearchGet(result.requestId, sessionId, signal, {
        failFast: true,
        timeoutMs: 15_000,
      });
      if (status.status !== "completed") continue;
      if (result.sources.length === 0 && status.sources?.length) result.sources = status.sources;
      if (status.usage?.credits !== undefined) {
        result.credits = status.usage.credits;
        return;
      }
    } catch (err) {
      if (isAbort(err, signal)) return;
      // 404 while the task propagates, key cooldown or timeout: try again
    }
  }
}
