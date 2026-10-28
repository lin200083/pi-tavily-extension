/**
 * Tavily Research helper: file attachment, SSE progress parsing, and polling.
 *
 * The /research endpoint is async: POST returns a request_id, then either
 * poll GET /research/{id} or consume the SSE stream (stream: true).
 */
import { readFileSync, statSync, type Stats } from "node:fs";
import { resolve, extname } from "node:path";
import type {
  ResearchParams,
  ResearchSource,
  ResearchStatusResponse,
} from "./types.js";
import {
  tavilyResearchCreate,
  tavilyResearchGet,
  tavilyResearchStream,
} from "./client.js";

export interface ResearchOptions {
  sessionId?: string;
  signal?: AbortSignal;
  /** Progress callback for the tool UI (called with text updates). */
  onUpdate?: (text: string) => void;
  /** Called before waiting out a 429 cooldown, so the UI is not silent. */
  onWait?: (seconds: number) => void;
  /** Maximum seconds to wait for completion (polling mode). */
  maxWaitSeconds?: number;
  /** Test/diagnostic hook: per-frame idle deadline for streaming (ms). */
  streamIdleTimeoutMs?: number;
}

export interface ResearchResult {
  content: string | Record<string, unknown>;
  sources: ResearchSource[];
  requestId: string;
  model?: string;
  responseTime?: number;
  /**
   * Credits consumed by the task, when known: polling mode gets it from
   * include_usage; streaming mode fetches it from the completed task
   * afterwards (index.ts), since SSE frames never carry usage.
   */
  credits?: number;
  /** True when the stream was interrupted (timeout / broken connection) and only partial output was recovered. */
  partial?: boolean;
}

// ---------- Local file attachment ----------

export const ALLOWED_FILE_EXT = new Set([".txt", ".md", ".json"]);
export const MAX_FILES = 5;
const MAX_TOTAL_BYTES = 500_000; // ~80k words as documented

/**
 * Tavily receives files base64-encoded, which is ~33% larger than on disk. The
 * documented 500KB limit applies to what is uploaded, so the budget is checked
 * against the encoded size instead of the raw bytes.
 */
export const MAX_TOTAL_ENCODED_BYTES = Math.floor(MAX_TOTAL_BYTES * 1.34);

export function readResearchFiles(
  paths: string[],
  baseDir?: string,
): Array<{
  name: string;
  data: string;
  type: "base64";
}> {
  if (paths.length === 0) return [];
  if (paths.length > MAX_FILES) {
    throw new Error(
      `Research 附加文件最多 ${MAX_FILES} 个，当前传了 ${paths.length} 个。`,
    );
  }
  const files: Array<{ name: string; data: string; type: "base64" }> = [];
  const usedNames = new Set<string>();
  let total = 0;
  let totalRaw = 0;
  for (const p of paths) {
    const abs = resolve(baseDir ?? process.cwd(), p);
    const ext = extname(abs).toLowerCase();
    if (!ALLOWED_FILE_EXT.has(ext)) {
      throw new Error(
        `Research 仅支持附加 .txt / .md / .json 文件，不支持: ${abs}（仅文件路径，不要传 URL）`,
      );
    }
    // Check the on-disk size before reading: a huge .json would otherwise be
    // fully read and base64-encoded before the upload limit is applied.
    const info: Stats = (() => {
      try {
        return statSync(abs);
      } catch (err) {
        throw new Error(
          `无法读取研究附加文件: ${abs}（${(err as Error).message}）`,
        );
      }
    })();
    if (!info.isFile()) {
      throw new Error(`研究附加路径不是文件: ${abs}`);
    }
    if (info.size > MAX_TOTAL_ENCODED_BYTES || totalRaw + info.size > MAX_TOTAL_ENCODED_BYTES) {
      throw new Error(
        "Research 附加文件总大小超过限制（约 80,000 词 / 500KB，按上传后的大小计算），请精简文件内容。",
      );
    }
    totalRaw += info.size;
    let content: Buffer;
    try {
      content = readFileSync(abs);
    } catch (err) {
      throw new Error(
        `无法读取研究附加文件: ${abs}（${(err as Error).message}）`,
      );
    }
    const encoded = content.toString("base64");
    total += encoded.length;
    if (total > MAX_TOTAL_ENCODED_BYTES) {
      throw new Error(
        "Research 附加文件总大小超过限制（约 80,000 词 / 500KB，按上传后的大小计算），请精简文件内容。",
      );
    }
    // Two files with the same basename would collide in Tavily's request body;
    // disambiguate with a counter instead of silently dropping one.
    const base = abs.split(/[\\/]/).pop()!;
    let name = base;
    for (let n = 2; usedNames.has(name); n++) {
      const dot = base.lastIndexOf(".");
      name = dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`;
    }
    usedNames.add(name);
    files.push({
      name,
      data: encoded,
      type: "base64",
    });
  }
  return files;
}

// ---------- SSE event parsing ----------

export interface ParsedSseEvent {
  kind: "tool_call" | "tool_response" | "content" | "sources" | "error" | "other";
  text?: string;
  contentChunk?: string | Record<string, unknown>;
  sources?: ResearchSource[];
  error?: string;
}

export function parseSseEvent(data: Record<string, unknown>): ParsedSseEvent {
  if (data.object === "error" || data.error) {
    return {
      kind: "error",
      error: String(data.error ?? "Unknown streaming error"),
    };
  }
  const delta = (data.choices as Array<{ delta?: Record<string, unknown> }>)?.[0]
    ?.delta;
  if (!delta) return { kind: "other" };

  const tc = delta.tool_calls as
    | { type?: string; tool_call?: Array<Record<string, unknown>>; tool_response?: Array<Record<string, unknown>> }
    | undefined;
  if (tc?.type === "tool_call") {
    const parts: string[] = [];
    for (const t of tc.tool_call ?? []) {
      const name = String(t.name ?? "?");
      const args = String(t.arguments ?? "");
      const queries = t.queries as string[] | undefined;
      if (queries?.length) {
        parts.push(`${name}: ${queries.join(" | ")}`);
      } else {
        parts.push(`${name}: ${args}`);
      }
    }
    return { kind: "tool_call", text: parts.join("\n") };
  }
  if (tc?.type === "tool_response") {
    const parts: string[] = [];
    const allSources: ResearchSource[] = [];
    for (const t of tc.tool_response ?? []) {
      const name = String(t.name ?? "?");
      const args = String(t.arguments ?? "");
      parts.push(`${name}: ${args}`);
      const sources = t.sources as ResearchSource[] | undefined;
      if (sources?.length) allSources.push(...sources);
    }
    return {
      kind: "tool_response",
      text: parts.join("\n"),
      sources: allSources.length ? allSources : undefined,
    };
  }
  if (delta.content !== undefined) {
    return { kind: "content", contentChunk: delta.content as string | Record<string, unknown> };
  }
  if (delta.sources !== undefined) {
    return {
      kind: "sources",
      sources: (delta.sources as ResearchSource[]) ?? [],
    };
  }
  return { kind: "other" };
}

// ---------- Streaming research ----------

/**
 * Behavior after an interruption — verified against the live API (2026-08):
 *
 * 1. Each SSE event's `id` is a per-chunk identifier; polling
 *    GET /research/{event-id} returns 404. The real task id is the
 *    `x-request-id` HTTP response header of the POST.
 * 2. Disconnecting the stream (timer abort or network drop) makes Tavily mark
 *    the task "failed" server-side. Polling afterwards can NOT recover the
 *    full report — the only salvageable output is the partial content/sources
 *    already received before the disconnect.
 *
 * Therefore on timeout/stream-error we return the partial result (flagged
 * `partial`, with a banner) instead of discarding everything. A user Esc
 * still propagates as a native AbortError.
 */
async function runStreaming(
  params: ResearchParams,
  opts: ResearchOptions,
): Promise<ResearchResult> {
  const maxWaitSeconds = opts.maxWaitSeconds ?? 600;

  // Our timer and the user's Esc (outer signal) share one controller; the
  // timedOut flag distinguishes the two abort causes for error reporting.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, maxWaitSeconds * 1000);
  const onOuterAbort = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

  const contentParts: string[] = [];
  // Running total of report characters, so the progress callback is O(1) per
  // chunk instead of re-joining the whole array (O(n^2) over a long report).
  let contentLength = 0;
  const sourceMap = new Map<string, ResearchSource>();
  let model: string | undefined;
  let requestId = "";
  let streamError: unknown;

  try {
    try {
      for await (
        const raw of tavilyResearchStream(
          params,
          opts.sessionId,
          controller.signal,
          (headers) => {
            requestId = headers.get("x-request-id") ?? "";
          },
          opts.streamIdleTimeoutMs,
          opts.onWait,
        )
      ) {
        const ev = parseSseEvent(raw as Record<string, unknown>);
        switch (ev.kind) {
          case "tool_call":
            opts.onUpdate?.(`🔍 ${ev.text ?? ""}`);
            break;
          case "tool_response":
            // Tool responses carry their own discovered sources (docs:
            // "Tool Response Events ... you'll receive response events with
            // discovered sources") — collect them so timeouts before the
            // final report still yield a useful source list.
            for (const s of ev.sources ?? []) {
              if (s?.url && !sourceMap.has(s.url)) sourceMap.set(s.url, s);
            }
            opts.onUpdate?.(
              `✅ ${ev.text ?? "完成"}${sourceMap.size ? ` · 已收集 ${sourceMap.size} 个来源` : ""}`,
            );
            break;
          case "content": {
            const chunk = ev.contentChunk;
            if (typeof chunk === "string") {
              contentParts.push(chunk);
              contentLength += chunk.length;
            } else {
              // structured output streamed as object
              const serialized = JSON.stringify(chunk);
              contentParts.push(serialized);
              contentLength += serialized.length;
            }
            opts.onUpdate?.(`📝 正在生成报告…（${contentLength} 字符）`);
            break;
          }
          case "sources":
            for (const s of ev.sources ?? []) {
              if (s?.url && !sourceMap.has(s.url)) sourceMap.set(s.url, s);
            }
            opts.onUpdate?.(`📚 已收集 ${sourceMap.size} 个来源`);
            break;
          case "error":
            throw new Error(`Tavily Research 流式错误: ${ev.error}`);
          default:
            break;
        }
        const m = (raw as { model?: string }).model;
        if (m) model = m;
      }
    } catch (err) {
      // User pressed Esc: propagate cancellation natively, discard partials.
      if (opts.signal?.aborted) throw err;
      // Timer fired or the stream broke mid-task: keep what we have and fall
      // through to partial recovery below (the server cancels the task on
      // disconnect, so polling cannot recover more than we already received).
      streamError = err;
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }

  const content = contentParts.join("");
  const sources = [...sourceMap.values()];
  const interrupted = timedOut || streamError !== undefined;

  if (!interrupted) {
    if (!content.trim()) {
      throw new Error("Tavily Research 流式响应未返回任何报告内容。");
    }
    return { content, sources, requestId: requestId || "stream", model };
  }

  // Interrupted (timeout / broken stream): salvage the partial result. If we
  // never received anything at all, surface the underlying cause as a failure.
  if (!content.trim() && sources.length === 0) {
    if (timedOut) {
      throw new Error(
        `Research 流式任务超时（超过 ${maxWaitSeconds}s），且没有可恢复的部分内容。建议增大 max_wait 参数后重试。`,
      );
    }
    throw streamError instanceof Error ? streamError : new Error(String(streamError));
  }

  const reason = timedOut
    ? `研究任务未在 ${maxWaitSeconds}s 内完成，已被中断`
    : "研究任务的流式连接异常中断";
  const advice = timedOut
    ? "如需完整报告，请增大 max_wait 参数后重试。"
    : "如需完整报告，请重试；若反复中断，请检查网络或更换 API Key。";
  const banner =
    `> ⚠️ ${reason}；以下为中断前已获取的部分结果（${sources.length} 个来源` +
    `${content.trim() ? "，报告未写完" : "，正文尚未开始生成"}）。\n` +
    `> ${advice}\n\n`;
  opts.onUpdate?.(`⚠️ 任务中断，回收部分结果（${sources.length} 个来源）`);

  return {
    content: banner + content,
    sources,
    requestId: requestId || "stream",
    model,
    partial: true,
  };
}

// ---------- Polling research ----------

async function runPolling(
  params: ResearchParams,
  opts: ResearchOptions,
): Promise<ResearchResult> {
  const task = await tavilyResearchCreate(params, opts.sessionId, opts.signal, opts.onWait);
  const requestId = task.request_id;
  const deadline = Date.now() + (opts.maxWaitSeconds ?? 600) * 1000;
  const startedAt = Date.now();
  const baseIntervalMs = 5000;
  let attempts = 0;

  // How long after creation we still treat a GET 404 as propagation lag rather
  // than a genuinely missing task.
  const NOT_FOUND_GRACE_MS = 30_000;

  opts.onUpdate?.(`⏳ Research 任务已提交 (request_id: ${requestId})，等待完成…`);

  while (true) {
    if (opts.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Research 任务超时（超过 ${opts.maxWaitSeconds ?? 600}s）。可用 request_id ${requestId} 在 Tavily 控制台查询。`,
      );
    }

    // wait before polling (5s base, capped backoff)
    const waitMs = Math.min(baseIntervalMs * Math.pow(1.5, attempts), 15000);
    await new Promise<void>((resolveWait, rejectWait) => {
      if (opts.signal?.aborted) {
        return rejectWait(new DOMException("Aborted", "AbortError"));
      }
      const t = setTimeout(() => {
        opts.signal?.removeEventListener("abort", onAbort);
        resolveWait();
      }, waitMs);
      const onAbort = () => {
        clearTimeout(t);
        rejectWait(new DOMException("Aborted", "AbortError"));
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });

    // A freshly created task can 404 for a short propagation window before it
    // becomes visible to GET. Treat early 404s as "still pending" instead of
    // failing the whole task; a persistent 404 will surface once the grace
    // window has passed.
    let status: ResearchStatusResponse;
    try {
      status = await tavilyResearchGet(requestId, opts.sessionId, opts.signal, {
        onWait: opts.onWait,
      });
    } catch (err) {
      const statusCode = (err as { status?: number })?.status;
      const withinGrace = Date.now() - startedAt < NOT_FOUND_GRACE_MS;
      if (statusCode === 404 && withinGrace) {
        attempts++;
        opts.onUpdate?.("⏳ Research 任务已提交，等待任务注册…");
        continue;
      }
      throw err;
    }
    attempts++;

    if (status.status === "completed") {
      opts.onUpdate?.(
        `✅ Research 完成（${status.sources?.length ?? 0} 个来源` +
          `${status.usage?.credits !== undefined ? `，${status.usage.credits} credits` : ""}）`,
      );
      return {
        content: status.content,
        sources: status.sources ?? [],
        requestId,
        responseTime: status.response_time,
        credits: status.usage?.credits,
      };
    }
    if (status.status === "failed") {
      throw new Error(`Tavily Research 任务失败 (request_id: ${requestId})`);
    }
    opts.onUpdate?.(
      `⏳ Research 进行中…（已等待约 ${Math.round((Date.now() - startedAt) / 1000)}s）`,
    );
  }
}

// ---------- Public entry ----------

export async function runResearch(
  params: ResearchParams,
  opts: ResearchOptions,
): Promise<ResearchResult> {
  if (params.stream) {
    return runStreaming(params, opts);
  }
  return runPolling(params, opts);
}
