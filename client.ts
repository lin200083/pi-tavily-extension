/**
 * Tavily REST client with multi-key round-robin and automatic failover.
 *
 * - Multiple keys are used round-robin to spread credit usage.
 * - 429 (rate limit): fail over to the next key; with a single key, wait
 *   for `retry-after` (capped) and retry once.
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
import { resolveApiKeys, resolveProjectId, resolveHumanId } from "./config.js";

const BASE_URL = "https://api.tavily.com";

// ---------- Multi-key manager ----------

class KeyManager {
  private keys: string[] = [];
  /** key -> "YYYY-M" month in which the key hit a 432 (plan limit) */
  private exhausted = new Map<string, string>();
  private cursor = 0;

  update(keys: string[]) {
    // drop keys that no longer exist; keep exhaustion state for surviving keys
    const known = new Set(keys);
    for (const k of [...this.exhausted.keys()]) {
      if (!known.has(k)) this.exhausted.delete(k);
    }
    this.keys = keys;
    if (this.cursor >= Math.max(keys.length, 1)) this.cursor = 0;
  }

  private currentMonth(): string {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}`;
  }

  /** Next usable key, or undefined when none configured. */
  next(): string | undefined {
    if (this.keys.length === 0) return undefined;
    const month = this.currentMonth();
    // revive keys from previous months
    for (const [k, m] of [...this.exhausted.entries()]) {
      if (m !== month) this.exhausted.delete(k);
    }
    const active = this.keys.filter((k) => !this.exhausted.has(k));
    if (active.length === 0) return undefined;
    const key = active[this.cursor % active.length];
    this.cursor = (this.cursor + 1) % active.length;
    return key;
  }

  markExhausted(key: string) {
    this.exhausted.set(key, this.currentMonth());
  }

  get healthyCount(): number {
    const month = this.currentMonth();
    return this.keys.filter((k) => !this.exhausted.has(k)).length;
  }

  get totalCount(): number {
    return this.keys.length;
  }
}

export const keyManager = new KeyManager();

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
}

/** Raised when our own client-side deadline fires (not a user Esc). */
class TavilyTimeoutError extends TavilyError {
  readonly timeout = true;
  constructor(timeoutMs: number, path: string) {
    super({
      status: 0,
      message: `Tavily 请求超时（${timeoutMs}ms 未响应）：${path}。可稍后重试，或调大 timeout 参数。`,
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
      detail?: string | { error?: string };
      error?: string;
    };
    const detail = data?.detail;
    if (typeof detail === "string") {
      return detail || `HTTP ${status}`;
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
    throw new TavilyError({
      status: 0,
      message:
        "Tavily 未配置 API Key。请在扩展目录 ~/.pi/agent/extensions/tavily/config.json 的 apiKeys 中填入你的 Key（支持多个，逗号分隔）。",
    });
  }

  const maxAttempts = Math.max(keys.length, 2); // at least one failover retry
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = keyManager.next();
    if (!key) {
      throw new TavilyError({
        status: 432,
        message:
          "所有 Tavily API Key 本月的积分都已用尽（或全部被限流）。请下月再试，或在 config.json 的 apiKeys 中添加新的 Key。",
      });
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
      return (await resp.json()) as T;
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

    if (resp.status === 432) {
      // key/plan limit exceeded -> exhaust this key for the month, fail over
      keyManager.markExhausted(key);
      lastError = err;
      continue;
    }

    if (resp.status === 429) {
      if (keys.length > 1) {
        // rate limited: try the next key immediately
        lastError = err;
        continue;
      }
      // single key: respect retry-after (capped at 15s), retry once
      const wait = Math.min(retryAfter ?? 5, 15);
      try {
        await sleep(wait * 1000, opts.signal);
      } catch (e) {
        throw e; // aborted
      }
      lastError = err;
      continue;
    }

    // 400 / 401 / 403 / 500 ...: no point retrying
    throw err;
  }

  throw lastError ?? new TavilyError({ status: 0, message: "Unknown Tavily error" });
}

// ---------- Public endpoint wrappers ----------

/** Default client-side deadlines (ms). */
const SEARCH_TIMEOUT_MS = 60_000;
const RESEARCH_TIMEOUT_MS = 60_000;

/**
 * Client-side deadline for endpoints where Tavily applies its own server-side
 * timeout: keep ours slightly larger so the server's (more precise) error wins.
 */
function serverBudget(serverSeconds: number | undefined, fallback: number): number {
  return ((serverSeconds ?? fallback) + 5) * 1000;
}

export async function tavilySearch(
  params: SearchParams,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  return executeRequest<SearchResponse>({
    path: "/search",
    body: { ...params, include_usage: true },
    signal,
    sessionId,
    timeoutMs: SEARCH_TIMEOUT_MS,
  });
}

export async function tavilyExtract(
  params: ExtractParams,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<ExtractResponse> {
  const serverSeconds =
    params.timeout ?? (params.extract_depth === "advanced" ? 30 : 10);
  return executeRequest<ExtractResponse>({
    path: "/extract",
    body: { ...params, include_usage: true },
    signal,
    sessionId,
    timeoutMs: serverBudget(serverSeconds, 10),
  });
}

export async function tavilyMap(
  params: MapParams,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<MapResponse> {
  return executeRequest<MapResponse>({
    path: "/map",
    body: { ...params, include_usage: true },
    signal,
    sessionId,
    timeoutMs: serverBudget(params.timeout, 150),
  });
}

export async function tavilyCrawl(
  params: CrawlParams,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<CrawlResponse> {
  return executeRequest<CrawlResponse>({
    path: "/crawl",
    body: { ...params, include_usage: true },
    signal,
    sessionId,
    timeoutMs: serverBudget(params.timeout, 150),
  });
}

/** Create a research task (non-streaming: returns request_id immediately). */
export async function tavilyResearchCreate(
  params: ResearchParams,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<ResearchTaskResponse> {
  return executeRequest<ResearchTaskResponse>({
    path: "/research",
    body: params as unknown as Record<string, unknown>,
    signal,
    sessionId,
    timeoutMs: RESEARCH_TIMEOUT_MS,
  });
}

/** Poll a research task status. 200=completed/failed, 202=in progress. */
export async function tavilyResearchGet(
  requestId: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<ResearchStatusResponse> {
  return executeRequest<ResearchStatusResponse>({
    path: `/research/${encodeURIComponent(requestId)}`,
    method: "GET",
    signal,
    sessionId,
    timeoutMs: RESEARCH_TIMEOUT_MS,
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
): AsyncGenerator<Record<string, unknown>> {
  const keys = resolveApiKeys();
  keyManager.update(keys);
  if (keys.length === 0) {
    throw new TavilyError({
      status: 0,
      message:
        "Tavily 未配置 API Key。请在扩展目录 ~/.pi/agent/extensions/tavily/config.json 的 apiKeys 中填入你的 Key（支持多个）。",
    });
  }

  // Streaming research is one long-lived request, so failover can only happen
  // BEFORE the response body starts flowing: retry on a fast-failing 432/429,
  // never once we have begun reading SSE frames.
  const maxAttempts = Math.max(keys.length, 2);
  let lastError: Error | undefined;
  let resp: Response | undefined;

  for (let attempt = 0; attempt < maxAttempts && !resp; attempt++) {
    const key = keyManager.next();
    if (!key) {
      throw new TavilyError({
        status: 432,
        message:
          "所有 Tavily API Key 本月的积分都已用尽（或全部被限流）。请下月再试，或在 config.json 的 apiKeys 中添加新的 Key。",
      });
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

    if (r.status === 432) {
      // key/plan limit exceeded -> exhaust this key for the month, fail over
      keyManager.markExhausted(key);
      lastError = err;
      continue;
    }
    if (r.status === 429) {
      lastError = err;
      if (keys.length > 1) continue; // rate limited: try the next key immediately
      const wait = Math.min(err.retryAfter ?? 5, 15);
      try {
        await sleep(wait * 1000, signal);
      } catch (e) {
        throw e; // aborted
      }
      continue;
    }

    // 400 / 401 / 403 / 500 ...: no point retrying
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

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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
    reader.releaseLock();
  }
}

export function formatTavilyError(err: unknown): string {
  // Duck-type on name as well as instanceof: if this module ever gets loaded
  // twice (separate class identities), errors from the other copy still match.
  if (err instanceof TavilyError || (err as Error)?.name === "TavilyError") {
    const te = err as TavilyError;
    const extra = te.requestId ? ` (request_id: ${te.requestId})` : "";
    switch (te.status) {
      case 401:
        return `Tavily API Key 无效或已过期，请检查配置。${extra}`;
      case 429:
        return `Tavily 请求过于频繁（限流）${te.retryAfter ? `，建议 ${te.retryAfter}s 后重试` : ""}。${extra}`;
      case 432:
        return `Tavily 积分或套餐限额已用尽，请更换 Key 或升级套餐。${extra}`;
      case 433:
        return `Tavily PayGo 限额已用尽，请在 Tavily 控制台调整。${extra}`;
      case 403:
        return `Tavily 拒绝访问（该功能可能需要付费计划）。${extra}`;
      case 0:
        return te.message;
      default:
        return `Tavily API 错误 (${te.status}): ${te.message}${extra}`;
    }
  }
  return `Tavily 调用失败: ${(err as Error).message ?? String(err)}`;
}
