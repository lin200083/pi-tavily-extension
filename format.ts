/**
 * Model-facing text formatting for Tavily responses.
 *
 * Pure functions (no pi, no filesystem) so they can be unit tested. The two
 * views side by side: `full` keeps every item body intact and becomes the spill
 * file; `head` carries byte-capped bodies and becomes the model-facing text.
 *
 * Formatting is policy: a self-describing label ("relevance", "cite as [n]") or
 * a dropped-parameter line replaces a system-prompt rule, which is cheaper and
 * cannot be ignored.
 */
import type {
  SearchResponse,
  ExtractResponse,
  MapResponse,
  CrawlResponse,
  ResearchSource,
} from "./types.js";
import type { ResearchResult } from "./research.js";

/** Soft cap per item body: a minified page must not eat the whole 50KB head budget. */
export const ITEM_SOFT_CAP_BYTES = 8 * 1024;

/**
 * URLs already fetched in this session, used to mark repeats instead of
 * re-reading the same page (the cheapest way to save credits: the model sees
 * the marker in the result itself, no system-prompt rule needed).
 */
export type SeenUrls = Set<string>;

/** Suffix added to a URL the session already fetched. */
const SEEN_MARK = " [已在本会话抓取过]";

/**
 * Peek at the fetched-URL set without recording `url`. Search results use this:
 * seeing a page in a snippet is not the same as having read it, so a search
 * must never turn a later extract into a false "already fetched" marker.
 */
export function seenMarker(seen: SeenUrls | undefined, url: string | undefined): string {
  if (!seen || !url) return "";
  return seen.has(url) ? SEEN_MARK : "";
}

/** Record `url` in `seen` and return the marker for a repeat ("" when new). */
export function trackUrl(seen: SeenUrls | undefined, url: string | undefined): string {
  if (!seen || !url) return "";
  const repeat = seen.has(url);
  seen.add(url);
  return repeat ? SEEN_MARK : "";
}

/**
 * Cap a machine-readable string for `structuredContent`. The model-facing text
 * already has its own cap and a spill file; codemode callers get the same
 * protection so a page minified into one 700KB line cannot wedge a script.
 */
export function capStructuredText(text: string, capBytes = ITEM_SOFT_CAP_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= capBytes) return text;
  return sliceByBytes(text, capBytes) + "\n[truncated]";
}

/** True when capStructuredText actually shortened something. */
export function exceedsCap(text: string, capBytes = ITEM_SOFT_CAP_BYTES): boolean {
  return Buffer.byteLength(text, "utf8") > capBytes;
}

/**
 * Slice text to at most `maxBytes` UTF-8 bytes. A char-count slice is not
 * byte-safe: CJK encodes to up to 3 bytes per char, so slicing N chars can be
 * ~3N bytes and overshoot pi's budget. Also avoids splitting surrogate pairs.
 */
export function sliceByBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0 && lo < text.length) {
    const code = text.charCodeAt(lo - 1);
    if (code >= 0xd800 && code <= 0xdbff) lo--; // don't cut a surrogate pair
  }
  return text.slice(0, lo);
}

export function capItemText(text: string, capBytes = ITEM_SOFT_CAP_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= capBytes) return text;
  // Neutral marker: finalizeOutput appends the spill path (and reports a write
  // failure) in the footer, so this line must not promise where the rest is.
  return sliceByBytes(text, capBytes) + `\n[本条内容过长已压缩]`;
}

/** Formatted result in two views: `full` goes to the spill file, `head` to the model. */
export interface FormattedOutput {
  full: string;
  head: string;
}

/**
 * Builds the two views side by side: `full` keeps every item body intact (it
 * becomes the spill file), `head` carries the byte-capped bodies (it becomes
 * the model-facing text). Regular lines go to both verbatim.
 */
export class OutputBuilder {
  private fullLines: string[] = [];
  private headLines: string[] = [];

  line(text = ""): this {
    this.fullLines.push(text);
    this.headLines.push(text);
    return this;
  }

  /** Push an item body: uncapped into `full`, byte-capped into `head`. */
  item(text: string): this {
    this.fullLines.push(text);
    this.headLines.push(capItemText(text));
    return this;
  }

  result(): FormattedOutput {
    return {
      full: this.fullLines.join("\n").trim(),
      head: this.headLines.join("\n").trim(),
    };
  }
}

/**
 * Drop undefined/null-valued keys so a structured payload stays JSON-serializable
 * (pi's `structuredContent` is `JsonValue`).
 */
export function clean(obj: Record<string, unknown>): any {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
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

/** Leading line when request parameters were not applied; keeps the call honest. */
function droppedLine(dropped: string[]): string[] {
  return dropped.length > 0 ? [`[dropped: ${dropped.join("; ")}]`, ""] : [];
}

export function formatSearch(resp: SearchResponse, dropped: string[] = [], seen?: SeenUrls): FormattedOutput {
  const b = new OutputBuilder();
  for (const line of droppedLine(dropped)) b.line(line);

  if (resp.answer) {
    b.line(`**Answer:** ${resp.answer}`).line("");
  }
  const results = resp.results ?? [];
  if (results.length === 0) {
    b.line("No results found. Try fewer keywords, the source's language, or include_domains_mode='prefer' — don't re-run the same query.");
  }
  results.forEach((r, i) => {
    // "relevance" not "score": the number is query similarity, not reliability.
    const relevance = typeof r.score === "number" ? r.score.toFixed(2) : "?";
    const date = r.published_date ? ` [${r.published_date}]` : "";
    const repeat = seenMarker(seen, r.url);
    b.line(`${i + 1}. [relevance ${relevance}]${date} ${r.title}${repeat}`);
    b.line(`   ${r.url}`);
    if (r.favicon) b.line(`   (favicon: ${r.favicon})`);
    if (r.content) b.line(`   ${r.content}`);
    if (r.raw_content) {
      b.line(`   (raw content:)`);
      b.item(r.raw_content);
    }
    for (const img of formatImages(r.images)) b.line(img);
    b.line("");
  });
  // Top-level images are query-related and separate from the per-result ones.
  if (resp.images?.length) {
    b.line("## Images");
    for (const img of formatImages(resp.images)) b.line(img);
    b.line("");
  }
  return b.result();
}

export function formatExtract(resp: ExtractResponse, dropped: string[] = [], seen?: SeenUrls): FormattedOutput {
  const b = new OutputBuilder();
  for (const line of droppedLine(dropped)) b.line(line);

  for (const r of resp.results ?? []) {
    b.line(`## ${r.url}${trackUrl(seen, r.url)}`);
    if (r.favicon) b.line(`(favicon: ${r.favicon})`);
    b.item(r.raw_content ?? "");
    b.line("");
    for (const img of formatImages(r.images)) b.line(img);
  }
  const failed = resp.failed_results ?? [];
  if (failed.length > 0) {
    b.line("Failed URLs:");
    for (const f of failed) b.line(`- ${f.url}: ${f.error}`);
    b.line(
      "[retry once with extract_depth='advanced'; otherwise use an alternate source — don't repeat the same basic request]",
    );
  }
  if ((resp.results ?? []).length === 0 && failed.length === 0) {
    b.line("No results.");
  }
  return b.result();
}

export function formatMap(resp: MapResponse): string {
  const urls = resp.results ?? [];
  const lines = [`Discovered ${urls.length} URLs under ${resp.base_url}:`, ""];
  for (const u of urls) lines.push(`- ${u}`);
  if (urls.length === 0) {
    lines.push(
      "[0 URLs: the root may be JS-rendered, behind a login, or blocking crawlers. " +
        "Try a deeper path (docs.example.com/docs), allow_external=true, or extract 1–3 known URLs directly]",
    );
  }
  return lines.join("\n");
}

export function formatCrawl(resp: CrawlResponse, dropped: string[] = [], seen?: SeenUrls): FormattedOutput {
  const pages = resp.results ?? [];
  const b = new OutputBuilder();
  for (const line of droppedLine(dropped)) b.line(line);

  b.line(`Crawled ${pages.length} pages from ${resp.base_url}:`).line("");
  for (const p of pages) {
    b.line(`### ${p.url}${trackUrl(seen, p.url)}`);
    if (p.favicon) b.line(`(favicon: ${p.favicon})`);
    b.item(p.raw_content ?? "");
    b.line("");
    for (const img of formatImages(p.images)) b.line(img);
  }
  if (pages.length === 0) {
    b.line(
      "No pages crawled. Try a deeper root path, relax select_paths/exclude_paths, raise limit, " +
        "or extract the 1–3 known URLs directly — don't re-run the same crawl.",
    );
  }
  return b.result();
}

/** Source-list headings Tavily may emit; when present its own [n] numbering wins. */
const OWN_SOURCE_LIST =
  /^\s*(?:#{1,6}\s*|\*\*)?(sources|references|bibliography|参考资料|参考文献)(?=\s|$|[:：*])/im;

/**
 * True when `content` mentions `url` as a complete URL. A plain substring test
 * matches prefixes (example.com/a in example.com/abc), which silently drops a
 * source that the report never cited.
 */
function mentionsUrl(content: string, url: string): boolean {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?![\\w\\-./?#%&=])`).test(content);
}

/**
 * A partial report must announce itself: `partial` otherwise lives only in
 * `details`, which the model never sees (pi hands it `content` only).
 *
 * Citation numbering: Tavily's report usually ends with its own `### Sources`
 * block, whose [n] markers the body already references. Appending a second,
 * independently numbered list made body citations point at a different source
 * than list entry [n] (observed live), so when the report carries its own list
 * only the sources absent from the body are appended, unnumbered and explicitly
 * not citable.
 */
export function formatResearch(res: ResearchResult): string {
  const content =
    typeof res.content === "string" ? res.content : JSON.stringify(res.content, null, 2);
  const warning = res.partial
    ? "> ⚠ Research was interrupted; this is a partial report. Say so when you use it.\n\n"
    : "";
  const sources: ResearchSource[] = res.sources ?? [];
  if (sources.length === 0) return warning + content;

  if (OWN_SOURCE_LIST.test(content)) {
    const unmentioned = sources.filter((s) => s.url && !mentionsUrl(content, s.url));
    if (unmentioned.length === 0) return warning + content;
    const alsoBlock =
      "\n\n## Also consulted (unnumbered — not cited above, read before using)\n" +
      unmentioned.map((s) => `- ${s.title} — ${s.url}`).join("\n");
    return warning + content + alsoBlock;
  }

  const sourceBlock =
    "\n\n## Sources (cite as [1], [2], …)\n" +
    sources.map((s, i) => `${i + 1}. ${s.title} — ${s.url}`).join("\n");
  return warning + content + sourceBlock;
}
