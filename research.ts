/**
 * Tavily Research helper: file attachment, SSE progress parsing, and polling.
 *
 * The /research endpoint is async: POST returns a request_id, then either
 * poll GET /research/{id} or consume the SSE stream (stream: true).
 */
import { readFileSync } from "node:fs";
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
  /** Maximum seconds to wait for completion (polling mode). */
  maxWaitSeconds?: number;
}

export interface ResearchResult {
  content: string | Record<string, unknown>;
  sources: ResearchSource[];
  requestId: string;
  model?: string;
  responseTime?: number;
  /** True when the stream was interrupted (timeout / broken connection) and only partial output was recovered. */
  partial?: boolean;
}

// ---------- Local file attachment ----------

const ALLOWED_FILE_EXT = new Set([".txt", ".md", ".json"]);
const MAX_FILES = 5;
const MAX_TOTAL_BYTES = 500_000; // ~80k words as documented

export function readResearchFiles(paths: string[]): Array<{
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
  let total = 0;
  for (const p of paths) {
    const abs = resolve(p);
    const ext = extname(abs).toLowerCase();
    if (!ALLOWED_FILE_EXT.has(ext)) {
      throw new Error(
        `Research 仅支持附加 .txt / .md / .json 文件，不支持: ${abs}（仅文件路径，不要传 URL）`,
      );
    }
    let content: Buffer;
    try {
      content = readFileSync(abs);
    } catch (err) {
      throw new Error(
        `无法读取研究附加文件: ${abs}（${(err as Error).message}）`,
      );
    }
    total += content.length;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(
        "Research 附加文件总大小超过限制（约 80,000 词 / 500KB），请精简文件内容。",
      );
    }
    files.push({
      name: abs.split(/[\\/]/).pop()!,
      data: content.toString("base64"),
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
              opts.onUpdate?.(`📝 正在生成报告…（${contentParts.join("").length} 字符）`);
            } else {
              // structured output streamed as object
              contentParts.push(JSON.stringify(chunk));
            }
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
  const banner =
    `> ⚠️ ${reason}；以下为中断前已获取的部分结果（${sources.length} 个来源` +
    `${content.trim() ? "，报告未写完" : "，正文尚未开始生成"}）。\n` +
    `> 如需完整报告，请增大 max_wait 参数后重试。\n\n`;
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
  const task = await tavilyResearchCreate(params, opts.sessionId, opts.signal);
  const requestId = task.request_id;
  const deadline = Date.now() + (opts.maxWaitSeconds ?? 600) * 1000;
  const startedAt = Date.now();
  const baseIntervalMs = 5000;
  let attempts = 0;

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

    const status = await tavilyResearchGet(requestId, opts.sessionId, opts.signal);
    attempts++;

    if (status.status === "completed") {
      opts.onUpdate?.(`✅ Research 完成（${status.sources?.length ?? 0} 个来源）`);
      return {
        content: status.content,
        sources: status.sources ?? [],
        requestId,
        responseTime: status.response_time,
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
