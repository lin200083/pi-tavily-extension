/**
 * Tavily REST client with multi-key round-robin and automatic failover.
 *
 * - Multiple keys are used round-robin to spread credit usage.
 * - 429 (rate limit): fail over to the next key; with a single key, wait
 *   for `retry-after` (capped) and retry once.
 * - 401 (invalid/revoked key): mark that key invalid for the process and fail
 *   over to the next key instead of retrying the same bad credential.
 * - 432 (key/plan limit exceeded): mark that key as exhausted for the current
 *   calendar month and fail over. Exhausted keys revive automatically next month.
 * - All requests carry X-Session-Id / X-Project-ID / X-Human-Id when available.
 */
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
  ResearchTaskResponse,
  ResearchStatusResponse,
  TavilyErrorOptions,
} from "./types.js";
import { TavilyError } from "./types.js";
import {
  resolveApiKeys,
  resolveProjectId,
  resolveHumanId,
  resolveSearchTimeoutMs,
  configReadError,
} from "./config.js";

const BASE_URL = "https://api.tavily.com";

// ---------- Multi-key manager ----------

/** How long a 401 keeps a key out of rotation before it is probed again. */
const INVALID_KEY_TTL_MS = 10 * 60 * 1000;

class KeyManager {
  private keys: string[] = [];
  /** key -> "YYYY-M" month in which the key hit a 432/433 (plan limit) */
  private exhausted = new Map<string, string>();
  /** key -> epoch ms when a 429 rate-limit cooldown ends */
  private rateLimitedUntil = new Map<string, number>();
  /**
   * key -> epoch ms when the 401 marking expires. A 401 is usually a revoked
   * key, but it can also be a transient auth hiccup at Tavily's edge; retiring
   * the key for the whole process would then require a restart, so the marking
   * is time-boxed and the key is probed again afterwards.
   */
  private invalid = new Map<string, number>();
  private cursor = 0;

  /** Clock is injectable so tests can advance time (cooldown expiry, monthly revival). */
  constructor(private now: () => number = () => Date.now()) {}

  update(keys: string[]) {
    // drop keys that no longer exist; keep per-key state for surviving keys
    const known = new Set(keys);
    for (const map of [this.exhausted, this.rateLimitedUntil, this.invalid]) {
      for (const k of [...map.keys()]) {
        if (!known.has(k)) map.delete(k);
      }
    }
    this.keys = keys;
    if (this.cursor >= Math.max(keys.length, 1)) this.cursor = 0;
  }

  private currentMonth(): string {
    const d = new Date(this.now());
    return `${d.getFullYear()}-${d.getMonth() + 1}`;
  }

  /** True when the key may be used right now; also revives expired markings. */
  private usable(key: string): boolean {
    const now = this.now();
    const invalidUntil = this.invalid.get(key);
    if (invalidUntil !== undefined) {
      if (invalidUntil > now) return false;
      this.invalid.delete(key);
    }
    const exhaustedMonth = this.exhausted.get(key);
    if (exhaustedMonth !== undefined) {
      if (exhaustedMonth === this.currentMonth()) return false;
      this.exhausted.delete(key);
    }
    const cooldownUntil = this.rateLimitedUntil.get(key);
    if (cooldownUntil !== undefined) {
      if (cooldownUntil > now) return false;
      this.rateLimitedUntil.delete(key);
    }
    return true;
  }

  /**
   * Next usable key, or undefined when none is available.
   *
   * The cursor indexes the configured key list (not the filtered "usable" list),
   * so keys entering/leaving cooldown mid-run cannot make round-robin skip or
   * double-hit one key.
   */
  next(): string | undefined {
    const n = this.keys.length;
    if (n === 0) return undefined;
    for (let i = 0; i < n; i++) {
      const index = (this.cursor + i) % n;
      const key = this.keys[index]!;
      if (this.usable(key)) {
        this.cursor = (index + 1) % n;
        return key;
      }
    }
    return undefined;
  }

  /**
   * Seconds until the earliest rate-limit cooldown ends (undefined when none is
   * active). Capped at RATE_LIMIT_MAX_WAIT_S so the caller never waits longer
   * than that ceiling: when the server asks for a longer Retry-After, the next
   * attempt after the capped wait re-marks the (still cooling) key with the
   * remaining server window instead of immediately hammering it.
   */
  cooldownWaitSeconds(): number | undefined {
    const now = this.now();
    let earliest: number | undefined;
    for (const until of this.rateLimitedUntil.values()) {
      if (until > now && (earliest === undefined || until < earliest)) earliest = until;
    }
    return earliest === undefined
      ? undefined
      : Math.min(Math.ceil((earliest - now) / 1000), RATE_LIMIT_MAX_WAIT_S);
  }

  markExhausted(key: string) {
    this.exhausted.set(key, this.currentMonth());
  }

  /** 401: exclude the key from rotation for INVALID_KEY_TTL_MS. */
  markInvalid(key: string) {
    this.invalid.set(key, this.now() + INVALID_KEY_TTL_MS);
  }

  /** True when every configured key has an unexpired 401 marking. */
  allInvalid(): boolean {
    if (this.keys.length === 0) return false;
    const now = this.now();
    return this.keys.every((k) => (this.invalid.get(k) ?? 0) > now);
  }

  /** Number of configured keys currently marked invalid (401). */
  invalidCount(): number {
    const now = this.now();
    return this.keys.filter((k) => (this.invalid.get(k) ?? 0) > now).length;
  }

  /**
   * Put a key that returned 429 into a short cooldown so round-robin skips it
   * instead of immediately hitting it again. Honors the server's Retry-After
   * (capped); falls back to a default window when the header is absent.
   */
  markRateLimited(key: string, retryAfterSeconds?: number) {
    const wait = Math.min(Math.max(retryAfterSeconds ?? RATE_LIMIT_DEFAULT_WAIT_S, 1), RATE_LIMIT_MAX_WAIT_S);
    this.rateLimitedUntil.set(key, this.now() + wait * 1000);
  }
}

/** Cooldown window for a 429 when the server sends no Retry-After. */
const RATE_LIMIT_DEFAULT_WAIT_S = 60;
/** Cap for the 429 cooldown so a huge Retry-After cannot sideline a key for hours. */
const RATE_LIMIT_MAX_WAIT_S = 300;
/** Extra attempts earned by a transient 5xx (server hiccup): one backoff'd retry. */
const SERVER_ERR_MAX_RETRIES = 1;
/** Backoff before retrying a transient 5xx. */
const SERVER_ERR_BACKOFF_MS = 750;

// KeyManager is exported for tests; production code uses the singleton below.
export { KeyManager };
export const keyManager = new KeyManager();

/**
 * Error when no key can be used. Distinguish "all keys are bad credentials"
 * from "all keys are out of credits": the fix for the former is replacing a
 * key, not waiting for a monthly reset.
 */
function noUsableKeyError(): TavilyError {
  if (keyManager.allInvalid()) {
    return new TavilyError({
      status: 401,
      message:
        "所有 Tavily API Key 都无效或已被吊销（401）。请检查 config.json 中的 apiKeys，替换失效的 Key。 / " +
        "All configured Tavily keys are invalid or revoked (401); check apiKeys in config.json.",
    });
  }
  const invalid = keyManager.invalidCount();
  if (invalid > 0) {
    return new TavilyError({
      status: 401,
      message:
        `没有可用的 Tavily API Key：${invalid} 个无效/被吊销，其余 Key 的限额已用尽。请检查 config.json 中的 apiKeys。 / ` +
        `No usable Tavily key: ${invalid} invalid, the rest hit their usage limit. Check apiKeys in config.json.`,
    });
  }
  return new TavilyError({
    status: 432,
    message:
      "所有 Tavily API Key 的用量限额都已用尽。请等限额重置后再试，或在 config.json 的 apiKeys 中添加新的 Key。 / " +
      "Every Tavily key reached its usage limit; wait for the reset or add another key in config.json.",
  });
}

// ---------- Core request ----------

export interface RequestOptions {
  method?: "POST" | "GET";
  /** Tavily endpoint path, e.g. "/search" or "/research/abc-123" */
  path: string;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Optional session id forwarded as X-Session-Id */
  sessionId?: string;
  /**
   * Client-side deadline in ms. Combined with `signal` so a hung connection
   * cannot wedge the tool until the user presses Esc. Timeouts are NOT retried
   * on another key (a deadline trip means our network, not the key).
   */
  timeoutMs?: number;
  /**
   * When no key is currently usable, fail immediately instead of waiting out a
   * 429 cooldown. For best-effort follow-up calls whose result is optional,
   * e.g. fetching research credits after the report is already delivered.
   */
  failFast?: boolean;
  /**
   * Called with the number of seconds about to be spent waiting out a 429
   * cooldown, so the tool can keep streaming progress instead of looking hung.
   */
  onWait?: (seconds: number) => void;
}

/** Raised when our own client-side deadline fires (not a user Esc). */
class TavilyTimeoutError extends TavilyError {
  readonly timeout = true;
  constructor(timeoutMs: number, path: string) {
    super({
      status: 0,
      message: `Tavily 请求超时（${timeoutMs}ms 未响应）：${path}。可稍后重试；extract/map/crawl 可调大 timeout 参数放宽服务端预算。`,
    });
    this.name = "TavilyError";
  }
}

/** Raised when a streaming research connection goes silent (no SSE frame for too long). */
class TavilyStreamIdleError extends TavilyError {
  constructor(idleMs: number) {
    super({
      status: 0,
      message: `Tavily Research 流式连接超过 ${Math.round(idleMs / 1000)}s 未收到数据，判定为断流。`,
    });
    this.name = "TavilyError";
  }
}

const isTimeoutError = (err: unknown): boolean =>
  (err as { timeout?: boolean } | undefined)?.timeout === true;

const isAbortLike = (err: unknown): boolean => {
  const name = (err as Error | undefined)?.name;
  return name === "AbortError" || name === "TimeoutError";
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function extractRetryAfter(seconds: unknown): number | undefined {
  const n = typeof seconds === "number" ? seconds : parseInt(String(seconds), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parseErrorBody(status: number, raw: string): string {
  try {
    const data = JSON.parse(raw) as {
      detail?:
        | string
        | { error?: string }
        | Array<{ msg?: string; loc?: unknown[] }>;
      error?: string;
    };
    const detail = data?.detail;
    if (typeof detail === "string") {
      return detail || `HTTP ${status}`;
    }
    // 422 validation errors carry an ARRAY of per-field issues (pydantic
    // style), e.g. [{"type":"missing","loc":["body","query"],"msg":"Field
    // required"}]. Collapse them into actionable text instead of the opaque
    // "HTTP 422" fallback.
    if (Array.isArray(detail)) {
      const parts: string[] = [];
      for (const d of detail) {
        if (typeof d?.msg !== "string" || d.msg.length === 0) continue;
        const loc = Array.isArray(d.loc) && d.loc.length > 0 ? d.loc.join(".") : "";
        parts.push(loc ? `${loc}: ${d.msg}` : d.msg);
      }
      return parts.length > 0 ? parts.join("；") : `HTTP ${status}`;
    }
    return detail?.error ?? data?.error ?? `HTTP ${status}`;
  } catch {
    return `HTTP ${status}`;
  }
}

/** Common Tavily request headers: auth plus optional session/project/human tracking. */
function tavilyHeaders(apiKey: string, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (sessionId) headers["X-Session-Id"] = sessionId;
  const projectId = resolveProjectId();
  if (projectId) headers["X-Project-ID"] = projectId;
  const humanId = resolveHumanId();
  if (humanId) headers["X-Human-Id"] = humanId;
  return headers;
}

async function rawRequest(
  path: string,
  apiKey: string,
  opts: RequestOptions,
): Promise<Response> {
  // Combine the caller's signal (Esc) with our own deadline.
  let signal = opts.signal;
  if (opts.timeoutMs !== undefined) {
    const deadline = AbortSignal.timeout(opts.timeoutMs);
    signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  }

  try {
    return await fetch(`${BASE_URL}${path}`, {
      method: opts.method ?? "POST",
      headers: tavilyHeaders(apiKey, opts.sessionId),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal,
    });
  } catch (err) {
    // User pressed Esc: propagate unchanged so pi handles cancellation natively.
    if (opts.signal?.aborted) throw err;
    if (opts.timeoutMs !== undefined && isAbortLike(err)) {
      throw new TavilyTimeoutError(opts.timeoutMs, path);
    }
    throw new TavilyError({
      status: 0,
      message: `无法连接 Tavily API（网络错误）：${(err as Error).message}`,
    });
  }
}

async function executeRequest<T>(
  opts: RequestOptions,
  sessionId?: string,
): Promise<T> {
  const keys = resolveApiKeys();
  keyManager.update(keys);

  if (keys.length === 0) {
    // Surface a malformed config.json explicitly instead of the generic
    // "no key configured" message, which sends the user down the wrong path.
    const parseError = configReadError();
    throw new TavilyError({
      status: 0,
      message: parseError
        ? `Tavily 的 config.json 解析失败：${parseError}。请检查 JSON 格式。`
        : "Tavily 未配置 API Key。请在扩展目录 ~/.pi/agent/extensions/tavily/config.json 的 apiKeys 数组中填入你的 Key（支持多个 Key 轮换）。",
    });
  }

  // Attempt budget: one try per key, plus headroom for a 429 cooldown wait and
  // the retry that follows it, plus one transient-5xx retry. With a single key
  // this is 4 (hit 429 -> wait out the cooldown -> retry; or 500 -> backoff ->
  // retry); with several keys it is keys.length + 3.
  const maxAttempts = keys.length + 2 + SERVER_ERR_MAX_RETRIES;
  let lastError: Error | undefined;
  let serverErrRetries = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = keyManager.next();
    if (!key) {
      // No key available right now. If some are merely cooling down from a 429,
      // wait for the earliest cooldown and try again rather than failing with a
      // misleading "credits exhausted" message — unless the caller opted out
      // (failFast: best-effort calls must not block on a cooldown).
      const waitS = keyManager.cooldownWaitSeconds();
      if (waitS !== undefined && !opts.failFast && attempt < maxAttempts - 1) {
        try {
          opts.onWait?.(Math.min(waitS, RATE_LIMIT_MAX_WAIT_S));
          await sleep(Math.min(waitS, RATE_LIMIT_MAX_WAIT_S) * 1000, opts.signal);
        } catch (e) {
          throw e; // aborted
        }
        continue;
      }
      if (waitS !== undefined) {
        throw new TavilyError({
          status: 429,
          message: `所有 Tavily API Key 都在限流冷却中（约 ${waitS}s 后恢复）。请稍后重试，或添加新的 Key。`,
          retryAfter: waitS,
        });
      }
      throw noUsableKeyError();
    }

    let resp: Response;
    try {
      resp = await rawRequest(opts.path, key, opts);
    } catch (err) {
      if ((err as Error).name === "AbortError" || opts.signal?.aborted) throw err;
      // Our own deadline tripped: retrying another key would only burn more time.
      if (isTimeoutError(err)) throw err;
      if (err instanceof TavilyError) {
        lastError = err; // already localized by rawRequest
        continue;
      }
      lastError = new TavilyError({
        status: 0,
        message: `无法连接 Tavily API（网络错误）：${(err as Error).message}`,
      });
      continue;
    }

    if (resp.ok) {
      try {
        return (await resp.json()) as T;
      } catch (err) {
        // The deadline can fire while the body is still being read: rawRequest
        // only wraps fetch(), so convert that case here too (otherwise the raw
        // "The operation was aborted due to timeout" DOMException leaks through
        // untranslated). User aborts still propagate unchanged.
        if (opts.signal?.aborted) throw err;
        if (opts.timeoutMs !== undefined && isAbortLike(err)) {
          throw new TavilyTimeoutError(opts.timeoutMs, opts.path);
        }
        throw err;
      }
    }

    const raw = await resp.text().catch(() => "");
    const detail = parseErrorBody(resp.status, raw);
    const retryAfter = extractRetryAfter(resp.headers.get("retry-after"));
    let requestId: string | undefined;
    try {
      requestId = (raw ? (JSON.parse(raw) as { request_id?: string }) : {})
        .request_id;
    } catch {
      // non-JSON error body (HTML page / empty body): continue with HTTP status
    }
    const err = new TavilyError({
      status: resp.status,
      message: detail,
      retryAfter,
      requestId,
    });

    if (resp.status === 401) {
      // The key itself is invalid/revoked. Drop it from rotation and try the
      // next key; 403 is deliberately not treated this way because map/crawl
      // use it for an unsupported URL (a request problem, not a key problem).
      keyManager.markInvalid(key);
      lastError = err;
      continue;
    }

    if (resp.status === 432 || resp.status === 433) {
      // 432 (key/plan limit) and 433 (PayGo limit) both mean "this key is done
      // for now": exhaust it and fail over. 433 used to fall through to the
      // generic 4xx throw, so a PayGo-capped key failed the whole call even
      // though other keys were healthy.
      keyManager.markExhausted(key);
      lastError = err;
      continue;
    }

    if (resp.status === 429) {
      // Put this key into a short cooldown so round-robin skips it instead of
      // immediately hitting it again; then fail over to the next usable key.
      // With a single key the next iteration's next() returns undefined while it
      // cools down, and the cooldown-wait branch above waits out the window.
      keyManager.markRateLimited(key, retryAfter);
      lastError = err;
      continue;
    }

    if (resp.status >= 500 && serverErrRetries < SERVER_ERR_MAX_RETRIES) {
      // 5xx is usually a transient server hiccup: back off briefly and retry
      // (round-robin moves on to the next key, spreading load). 4xx means our
      // request itself is wrong — those are never retried.
      serverErrRetries++;
      lastError = err;
      try {
        await sleep(SERVER_ERR_BACKOFF_MS, opts.signal);
      } catch (e) {
        throw e; // aborted while backing off
      }
      continue;
    }

    // 400 / 403 ...: no point retrying (401 is handled above)
    throw err;
  }

  throw lastError ?? new TavilyError({ status: 0, message: "Unknown Tavily error" });
}

// ---------- Public endpoint wrappers ----------

/** Default client-side deadlines (ms); the search one is configurable. */
const RESEARCH_TIMEOUT_MS = 60_000;
/** Max silence on a research SSE stream before we declare the connection dead. */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * Client-side deadline for endpoints where Tavily applies its own server-side
 * timeout: keep ours larger so the server's (more precise) error wins. The +15s
 * (was +5s) tolerates slow pages observed to exceed the documented default.
 */
function serverBudget(serverSeconds: number | undefined, fallback: number): number {
  return ((serverSeconds ?? fallback) + 15) * 1000;
}

export async function tavilySearch(
  params: SearchParams,
  sessionId?: string,
  signal?: AbortSignal,
  onWait?: (seconds: number) => void,
): Promise<SearchResponse> {
  return executeRequest<SearchResponse>({
    path: "/search",
    body: { ...params, include_usage: true },
    signal,
    sessionId,
    timeoutMs: resolveSearchTimeoutMs(),
    onWait,
  });
}

export async function tavilyExtract(
  params: ExtractParams,
  sessionId?: string,
  signal?: AbortSignal,
  onWait?: (seconds: number) => void,
): Promise<ExtractResponse> {
  const serverSeconds =
    params.timeout ?? (params.extract_depth === "advanced" ? 30 : 10);
  const urlCount = Math.max(1, params.urls?.length ?? 1);
  return executeRequest<ExtractResponse>({
    path: "/extract",
    body: { ...params, include_usage: true },
    signal,
    sessionId,
    // Tavily's `timeout` is a documented per-URL server budget, but a single
    // large page (Wikipedia AI article, 711KB) was observed to need ~40s at
    // basic depth while the server default is 10s: it is not a hard
    // whole-request deadline. Use a 60s request floor so slow pages are not
    // aborted client-side, plus a small allowance per additional batch URL.
    timeoutMs: (Math.max(serverSeconds + 15, 60) + (urlCount - 1) * 5) * 1000,
    onWait,
  });
}

export async function tavilyMap(
  params: MapParams,
  sessionId?: string,
  signal?: AbortSignal,
  onWait?: (seconds: number) => void,
): Promise<MapResponse> {
  return executeRequest<MapResponse>({
    path: "/map",
    body: { ...params, include_usage: true },
    signal,
    sessionId,
    timeoutMs: serverBudget(params.timeout, 150),
    onWait,
  });
}

export async function tavilyCrawl(
  params: CrawlParams,
  sessionId?: string,
  signal?: AbortSignal,
  onWait?: (seconds: number) => void,
): Promise<CrawlResponse> {
  return executeRequest<CrawlResponse>({
    path: "/crawl",
    body: { ...params, include_usage: true },
    signal,
    sessionId,
    timeoutMs: serverBudget(params.timeout, 150),
    onWait,
  });
}

/** Create a research task (non-streaming: returns request_id immediately). */
export async function tavilyResearchCreate(
  params: ResearchParams,
  sessionId?: string,
  signal?: AbortSignal,
  onWait?: (seconds: number) => void,
): Promise<ResearchTaskResponse> {
  return executeRequest<ResearchTaskResponse>({
    path: "/research",
    body: params as unknown as Record<string, unknown>,
    signal,
    sessionId,
    timeoutMs: RESEARCH_TIMEOUT_MS,
    onWait,
  });
}

/**
 * Poll a research task status. 200=completed/failed, 202=in progress.
 * `include_usage=true` makes completed/failed responses carry `usage.credits`,
 * so the tool can surface the actual cost of the (most expensive) endpoint.
 */
export async function tavilyResearchGet(
  requestId: string,
  sessionId?: string,
  signal?: AbortSignal,
  clientOpts?: { failFast?: boolean; timeoutMs?: number; onWait?: (seconds: number) => void },
): Promise<ResearchStatusResponse> {
  return executeRequest<ResearchStatusResponse>({
    path: `/research/${encodeURIComponent(requestId)}?include_usage=true`,
    method: "GET",
    signal,
    sessionId,
    timeoutMs: clientOpts?.timeoutMs ?? RESEARCH_TIMEOUT_MS,
    failFast: clientOpts?.failFast,
    onWait: clientOpts?.onWait,
  });
}

/**
 * Stream a research task. Returns an async iterator of parsed SSE events.
 *
 * `onResponseHeaders` (optional) fires once with the HTTP response headers.
 * The real task id is ONLY available there (`x-request-id`): the `id` field of
 * each SSE event is a per-chunk identifier and cannot be used to poll
 * GET /research/{id} (verified live: such ids return 404).
 *
 * Multiple keys are tried round-robin, but only while the failure is still
 * "fast" (non-2xx before any SSE frame): once the body starts flowing the
 * request cannot be replayed on another key.
 */
export async function* tavilyResearchStream(
  params: ResearchParams,
  sessionId?: string,
  signal?: AbortSignal,
  onResponseHeaders?: (headers: Headers) => void,
  /** Test/diagnostic hook: override the per-frame idle deadline (ms). */
  idleTimeoutMs?: number,
  /** Called before waiting out a 429 cooldown. */
  onWait?: (seconds: number) => void,
): AsyncGenerator<Record<string, unknown>> {
  const idleTimeout = idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  const keys = resolveApiKeys();
  keyManager.update(keys);
  if (keys.length === 0) {
    const parseError = configReadError();
    throw new TavilyError({
      status: 0,
      message: parseError
        ? `Tavily 的 config.json 解析失败：${parseError}。请检查 JSON 格式。`
        : "Tavily 未配置 API Key。请在扩展目录 ~/.pi/agent/extensions/tavily/config.json 的 apiKeys 中填入你的 Key（支持多个）。",
    });
  }

  // Streaming research is one long-lived request, so failover can only happen
  // BEFORE the response body starts flowing: retry on a fast-failing 401/432/429,
  // never once we have begun reading SSE frames. Budget matches executeRequest:
  // one try per key plus room for a cooldown wait, the retry that follows it,
  // and one transient-5xx retry.
  const maxAttempts = keys.length + 2 + SERVER_ERR_MAX_RETRIES;
  let lastError: Error | undefined;
  let serverErrRetries = 0;
  let resp: Response | undefined;

  for (let attempt = 0; attempt < maxAttempts && !resp; attempt++) {
    const key = keyManager.next();
    if (!key) {
      // No key available: if some are cooling down from a 429, wait out the
      // earliest cooldown and retry; otherwise they are genuinely exhausted.
      const waitS = keyManager.cooldownWaitSeconds();
      if (waitS !== undefined && attempt < maxAttempts - 1) {
        try {
          onWait?.(Math.min(waitS, RATE_LIMIT_MAX_WAIT_S));
          await sleep(Math.min(waitS, RATE_LIMIT_MAX_WAIT_S) * 1000, signal);
        } catch (e) {
          throw e; // aborted
        }
        continue;
      }
      if (waitS !== undefined) {
        throw new TavilyError({
          status: 429,
          message: `所有 Tavily API Key 都在限流冷却中（约 ${waitS}s 后恢复）。请稍后重试，或添加新的 Key。`,
          retryAfter: waitS,
        });
      }
      throw noUsableKeyError();
    }

    let r: Response;
    try {
      r = await fetch(`${BASE_URL}/research`, {
        method: "POST",
        headers: tavilyHeaders(key, sessionId),
        body: JSON.stringify(params),
        signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError" || signal?.aborted) throw err;
      lastError = new TavilyError({
        status: 0,
        message: `无法连接 Tavily API（网络错误）：${(err as Error).message}`,
      });
      continue;
    }

    if (r.ok) {
      resp = r;
      break;
    }

    const raw = await r.text().catch(() => "");
    const detail = parseErrorBody(r.status, raw);
    const err = new TavilyError({
      status: r.status,
      message: detail,
      retryAfter: extractRetryAfter(r.headers.get("retry-after")),
    });

    if (r.status === 401) {
      // Invalid/revoked key: drop it from rotation and try the next one. 403 is
      // not handled here because map/crawl use it for an unsupported URL.
      keyManager.markInvalid(key);
      lastError = err;
      continue;
    }

    if (r.status === 432 || r.status === 433) {
      // 432 (key/plan limit) and 433 (PayGo limit) both exhaust this key.
      keyManager.markExhausted(key);
      lastError = err;
      continue;
    }
    if (r.status === 429) {
      // Cool this key down so round-robin skips it, then fail over to the next
      // usable key (the cooldown-wait branch above handles the all-cooling case).
      keyManager.markRateLimited(key, err.retryAfter);
      lastError = err;
      continue;
    }

    if (r.status >= 500 && serverErrRetries < SERVER_ERR_MAX_RETRIES) {
      // Transient server hiccup before any SSE frame: back off and retry
      // (round-robin continues with the next key). Matches executeRequest.
      serverErrRetries++;
      lastError = err;
      try {
        await sleep(SERVER_ERR_BACKOFF_MS, signal);
      } catch (e) {
        throw e; // aborted while backing off
      }
      continue;
    }

    // 400 / 403 ...: no point retrying (401 is handled above)
    throw err;
  }

  if (!resp) {
    throw lastError ?? new TavilyError({ status: 0, message: "Unknown Tavily error" });
  }

  if (!resp.body) {
    throw new TavilyError({ status: 0, message: "Tavily 流式响应为空" });
  }
  onResponseHeaders?.(resp.headers);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Idle watchdog: a hung (half-open) SSE connection blocks reader.read()
  // forever. Without a per-frame deadline the user would wait until Esc or the
  // overall maxWait timer fires even though the stream is already dead.
  // On idle we cancel the reader (releasing the underlying connection) and
  // reject the pending read; research.ts then salvages the partial result.
  // The outer Esc signal is untouched, so cancellation still propagates natively.
  const idleController = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdleTimer = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleController.abort();
      // Release the underlying connection so the half-open socket does not leak.
      reader.cancel().catch(() => {});
    }, idleTimeout);
  };
  resetIdleTimer();

  // Per-frame read: our idle deadline combined with the caller's signal. Not
  // combined with the research overall maxWait timer — that one lives in
  // research.ts and aborts the caller's signal chain on its own.
  //
  // Listeners are attached per read and removed in the same tick the read
  // settles. The previous version built a fresh `AbortSignal.any(...)` per SSE
  // frame and never removed its listener, so a long report (thousands of
  // frames) leaked a listener on every frame.
  const readWithIdleDeadline = () =>
    new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      // The listener below never fires for an already-aborted signal, and the
      // idle timer can trip between two frames, so check first.
      if (idleController.signal.aborted) {
        reject(new TavilyStreamIdleError(idleTimeout));
        return;
      }
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      let settled = false;
      const cleanup = () => {
        idleController.signal.removeEventListener("abort", onIdle);
        signal?.removeEventListener("abort", onOuter);
      };
      const settle = (fn: typeof resolve | typeof reject, value: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value as never);
      };
      const onIdle = () => settle(reject, new TavilyStreamIdleError(idleTimeout));
      const onOuter = () => settle(reject, new DOMException("Aborted", "AbortError"));
      idleController.signal.addEventListener("abort", onIdle, { once: true });
      signal?.addEventListener("abort", onOuter, { once: true });
      reader.read().then(
        (result) => settle(resolve, result),
        (err) => settle(reject, err),
      );
    });

  try {
    while (true) {
      const { done, value } = await readWithIdleDeadline();
      if (done) break;
      resetIdleTimer();
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            yield JSON.parse(payload) as Record<string, unknown>;
          } catch {
            // skip malformed frames
          }
        }
        // "event: done" lines carry no payload; loop continues
      }
    }
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    reader.releaseLock();
  }
}

export function formatTavilyError(err: unknown): string {
  // Duck-type on name as well as instanceof: if this module ever gets loaded
  // twice (separate class identities), errors from the other copy still match.
  //
  // Messages are bilingual on purpose: the user reads Chinese, while the model
  // (and any codemode script) is usually English-first, and a script that only
  // sees Chinese has to re-derive the cause from a status number.
  if (err instanceof TavilyError || (err as Error)?.name === "TavilyError") {
    const te = err as TavilyError;
    const extra = te.requestId ? ` (request_id: ${te.requestId})` : "";
    switch (te.status) {
      case 401:
        // Keep Tavily's own English 401 generic; surface our localized
        // aggregate message when all/most keys are bad.
        return /[\u4e00-\u9fff]/.test(te.message)
          ? `${te.message}${extra}`
          : `Tavily API Key 无效或已过期，请检查配置。 / Invalid or expired Tavily API key.${extra}`;
      case 429:
        return (
          `Tavily 请求过于频繁（限流）${te.retryAfter ? `，建议 ${te.retryAfter}s 后重试` : ""}。 / ` +
          `Tavily rate limit${te.retryAfter ? `; retry in ${te.retryAfter}s` : ""}.${extra}`
        );
      case 432:
        return `Tavily 积分或套餐限额已用尽，请更换 Key 或升级套餐。 / Tavily credits or plan limit exhausted.${extra}`;
      case 433:
        return `Tavily PayGo 限额已用尽，请在 Tavily 控制台调整。 / Tavily PayGo limit exhausted.${extra}`;
      case 403:
        return `Tavily 拒绝访问（403）：该功能可能需要付费计划，或该 URL/域名不被支持。 / Forbidden (403): paid plan required, or the URL/domain is unsupported.${extra}`;
      case 0:
        return te.message;
      default:
        return `Tavily API 错误 (${te.status}): ${te.message}${extra}`;
    }
  }
  return `Tavily 调用失败 / Tavily call failed: ${(err as Error).message ?? String(err)}`;
}
