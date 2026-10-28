/**
 * Turn Tavily image URLs into pi image blocks.
 *
 * pi hands the model `{ type: "image", data, mimeType }` blocks (the same shape
 * the built-in `read` tool uses), so a vision model can actually see a search
 * result's image instead of reading a URL. Kept deliberately small: two images,
 * 2 MB each, 8s per fetch, http(s) only, and every failure is silent — an image
 * that cannot be fetched must never fail the tool call that found it.
 *
 * The URLs come from third-party pages, so this is also an SSRF boundary:
 * loopback/private/link-local hosts are refused, redirects are re-checked hop
 * by hop, and the body is capped while reading instead of after `arrayBuffer()`.
 * DNS rebinding is out of scope for this best-effort image path.
 */
import type { ImageContent } from "@earendil-works/pi-ai";

/** Hard limits: images are a bonus, never the payload. */
export const MAX_IMAGES = 2;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** True for loopback, private, link-local, CGNAT and mDNS hostnames/literals. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) return true;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }

  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateHost(mapped[1]!);

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;
    if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  }
  return false;
}

/** http(s) only; private/loopback hosts are refused. */
function isSafeImageUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return !isPrivateHost(url.hostname);
}

/** Read at most `maxBytes`, cancelling the stream as soon as the cap is crossed. */
async function readCappedBody(
  resp: Response,
  maxBytes: number,
): Promise<Buffer | undefined> {
  if (!resp.body) return undefined;
  const reader = resp.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return undefined;
  return Buffer.concat(chunks, total);
}

/** Fetch one image, following up to MAX_REDIRECTS safe hops. */
async function fetchOneImage(
  url: string,
  signal?: AbortSignal,
): Promise<ImageContent | undefined> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return undefined;
  }
  if (!isSafeImageUrl(current)) return undefined;

  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const resp = await fetch(current.toString(), {
      signal: combined,
      redirect: "manual",
    });

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) return undefined;
      try {
        current = new URL(location, current);
      } catch {
        return undefined;
      }
      if (!isSafeImageUrl(current)) return undefined;
      continue;
    }

    if (!resp.ok) return undefined;
    const mimeType = (resp.headers.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (!ALLOWED_MIME.has(mimeType)) return undefined;
    const length = Number(resp.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) return undefined;

    const bytes = await readCappedBody(resp, MAX_IMAGE_BYTES);
    if (!bytes) return undefined;
    return { type: "image", data: bytes.toString("base64"), mimeType };
  }
  return undefined;
}

/** Best-effort base64 of remote images, in input order, capped and de-duplicated. */
export async function fetchImageBlocks(
  urls: readonly string[] | undefined,
  opts: { max?: number; signal?: AbortSignal } = {},
): Promise<ImageContent[]> {
  const max = Math.min(opts.max ?? MAX_IMAGES, MAX_IMAGES);
  const blocks: ImageContent[] = [];
  const seen = new Set<string>();
  for (const url of urls ?? []) {
    if (blocks.length >= max) break;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    try {
      const block = await fetchOneImage(url, opts.signal);
      if (block) blocks.push(block);
    } catch {
      // network error, abort, oversized body: skip this image
    }
  }
  return blocks;
}
