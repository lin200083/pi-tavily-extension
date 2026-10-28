/**
 * Tool schemas (parameters + structured output).
 *
 * Parameter descriptions are deliberately terse: they are rendered into the
 * system prompt with every declaration, so a sentence of prose here costs
 * tokens on every request. Constraints live in the schema (min/max/enum) and
 * in code (preconditions are enforced and reported via `dropped`), not in prose.
 *
 * The `media` flag merges include_images / include_image_descriptions /
 * include_favicon: they are only ever wanted together, and one boolean is
 * cheaper than three.
 */
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

// ---------- tavily_search ----------

export const searchSchema = Type.Object({
  query: Type.String({
    description: "Search query: 2–6 keywords for a lookup, a full specific sentence for multi-facet questions.",
  }),
  topic: Type.Optional(StringEnum(["general", "news", "finance"] as const)),
  search_depth: Type.Optional(
    StringEnum(["advanced", "basic", "fast", "ultra-fast"] as const, {
      description: "advanced = best coverage (2 credits); basic/fast/ultra-fast = 1 credit.",
    }),
  ),
  chunks_per_source: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 3, description: "1–3 chunks per result (advanced/basic/fast; default 3)." }),
  ),
  max_results: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 20, description: "1–20 results; 10 covers most questions, 5 for a narrow lookup." }),
  ),
  time_range: Type.Optional(
    StringEnum(["day", "week", "month", "year", "d", "w", "m", "y"] as const, {
      description: "Relative window; day/week/month/year (d/w/m/y accepted).",
    }),
  ),
  start_date: Type.Optional(Type.String({ description: "YYYY-MM-DD; not with time_range." })),
  end_date: Type.Optional(Type.String({ description: "YYYY-MM-DD." })),
  include_published_date: Type.Optional(
    Type.Boolean({ description: "Add published_date per result (automatic for news)." }),
  ),
  filter_by_published_date: Type.Optional(
    Type.Boolean({ description: "Drop results outside the date window or without a date." }),
  ),
  include_answer: Type.Optional(
    Type.Union([Type.Boolean(), StringEnum(["basic", "advanced"] as const)], {
      description: "AI summary of the results; a lead to verify, not a source.",
    }),
  ),
  include_raw_content: Type.Optional(
    Type.Union([Type.Boolean(), StringEnum(["markdown", "text"] as const)], {
      description: "Full page text inline (heavy); prefer tavily_extract.",
    }),
  ),
  media: Type.Optional(Type.Boolean({ description: "Include images and favicons." })),
  include_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 300, description: "Only these domains." })),
  exclude_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 150, description: "Never these domains." })),
  include_domains_mode: Type.Optional(
    StringEnum(["restrict", "prefer"] as const, {
      description: "'prefer' = boost these domains and still search the web; 'restrict' = only them.",
    }),
  ),
  country: Type.Optional(
    Type.String({
      description: "Boost one country (general topic; dropped for fast/ultra-fast); full English name.",
    }),
  ),
  language: Type.Optional(
    Type.String({ description: "Boost results in this language (ISO code or English name)." }),
  ),
  filter_by_language: Type.Optional(
    Type.Boolean({ description: "Strictly drop other languages; needs language." }),
  ),
  safe_search: Type.Optional(Type.Boolean({ description: "Filter adult content (not with fast/ultra-fast)." })),
  exact_match: Type.Optional(
    Type.Boolean({ description: "Only results containing the quoted phrase; quote it in query." }),
  ),
  auto_parameters: Type.Optional(
    Type.Boolean({ description: "Let Tavily tune the search (may cost 2 credits)." }),
  ),
});
export type SearchToolParams = Static<typeof searchSchema>;

// ---------- tavily_extract ----------

export const extractSchema = Type.Object({
  urls: Type.Array(Type.String(), { minItems: 1, maxItems: 20, description: "URLs to read (max 20)." }),
  query: Type.Optional(Type.String({ description: "Rerank extracted chunks against this question." })),
  chunks_per_source: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 5, description: "Chunks per URL (1–5, requires query)." }),
  ),
  extract_depth: Type.Optional(
    StringEnum(["basic", "advanced"] as const, {
      description: "advanced for tables, PDFs or pages basic cannot read.",
    }),
  ),
  format: Type.Optional(StringEnum(["markdown", "text"] as const)),
  media: Type.Optional(Type.Boolean({ description: "Include images and favicons." })),
  timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 60, description: "Seconds (10 basic / 30 advanced)." })),
});
export type ExtractToolParams = Static<typeof extractSchema>;

// ---------- tavily_map ----------

export const mapSchema = Type.Object({
  url: Type.String({ description: "Root URL to map, e.g. docs.example.com." }),
  instructions: Type.Optional(
    Type.String({ description: "Natural-language focus, e.g. 'pages about the Python SDK'." }),
  ),
  max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Link depth (default 1)." })),
  max_breadth: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Links per level (default 20)." })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 500, description: "Total URL cap (default 50; up to 500)." }),
  ),
  select_paths: Type.Optional(
    Type.Array(Type.String(), { description: "Regex paths to keep, e.g. ['/docs/.*']." }),
  ),
  exclude_paths: Type.Optional(Type.Array(Type.String(), { description: "Regex paths to skip." })),
  select_domains: Type.Optional(Type.Array(Type.String(), { description: "Regex domains to keep." })),
  exclude_domains: Type.Optional(Type.Array(Type.String(), { description: "Regex domains to skip." })),
  allow_external: Type.Optional(Type.Boolean({ description: "Include external-domain links (default true)." })),
  timeout: Type.Optional(Type.Number({ minimum: 10, maximum: 150, description: "Seconds (default 150)." })),
});
export type MapToolParams = Static<typeof mapSchema>;

// ---------- tavily_crawl ----------

export const crawlSchema = Type.Object({
  url: Type.String({ description: "Root URL to crawl, e.g. docs.example.com." }),
  instructions: Type.Optional(
    Type.String({ description: "Natural-language focus, e.g. 'all authentication docs'." }),
  ),
  chunks_per_source: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 5, description: "Chunks per page (requires instructions)." }),
  ),
  max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Link depth (default 1)." })),
  max_breadth: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Links per level (default 20)." })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 500, description: "Total page cap (default 50; up to 500)." }),
  ),
  select_paths: Type.Optional(
    Type.Array(Type.String(), { description: "Regex paths to keep, e.g. ['/docs/.*']." }),
  ),
  exclude_paths: Type.Optional(Type.Array(Type.String(), { description: "Regex paths to skip." })),
  select_domains: Type.Optional(Type.Array(Type.String(), { description: "Regex domains to keep." })),
  exclude_domains: Type.Optional(Type.Array(Type.String(), { description: "Regex domains to skip." })),
  allow_external: Type.Optional(Type.Boolean({ description: "Follow external-domain links (default true)." })),
  extract_depth: Type.Optional(
    StringEnum(["basic", "advanced"] as const, {
      description: "advanced for tables, PDFs or pages basic cannot read.",
    }),
  ),
  format: Type.Optional(StringEnum(["markdown", "text"] as const)),
  media: Type.Optional(Type.Boolean({ description: "Include images and favicons." })),
  timeout: Type.Optional(Type.Number({ minimum: 10, maximum: 150, description: "Seconds (default 150)." })),
});
export type CrawlToolParams = Static<typeof crawlSchema>;

// ---------- tavily_research ----------

export const researchSchema = Type.Object({
  input: Type.String({
    description: "Task or question; include context, constraints and the output you want.",
  }),
  model: Type.Optional(
    StringEnum(["auto", "mini", "pro"] as const, {
      description: "pro = deepest (15–250 credits); mini for narrow lookups (4–110).",
    }),
  ),
  stream: Type.Optional(Type.Boolean({ description: "Show progress live (default true)." })),
  output_length: Type.Optional(
    StringEnum(["short", "standard", "long"] as const, {
      description: "short brief / standard answer / long report.",
    }),
  ),
  citation_format: Type.Optional(StringEnum(["numbered", "mla", "apa", "chicago"] as const)),
  include_domains: Type.Optional(
    Type.Array(Type.String(), { maxItems: 20, description: "Prefer these domains (soft)." }),
  ),
  exclude_domains: Type.Optional(
    Type.Array(Type.String(), { maxItems: 20, description: "Never use these domains (hard)." }),
  ),
  output_schema: Type.Optional(
    Type.Union([Type.String(), Type.Object({}, { additionalProperties: true })], {
      description: "JSON Schema object (not a string) for structured output.",
    }),
  ),
  files: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: 5,
      description: "Local .txt/.md/.json paths to research alongside the web (max 5).",
    }),
  ),
  max_wait: Type.Optional(
    Type.Integer({ minimum: 60, maximum: 3600, default: 600, description: "Seconds to wait (60–3600)." }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Return immediately and deliver the report as a new message when done; the turn is not blocked.",
    }),
  ),
  extract_sources: Type.Optional(
    Type.Boolean({
      description:
        "After the report, read up to 3 cited pages with tavily_extract (extra credits) and append verbatim excerpts.",
    }),
  ),
});
export type ResearchToolParams = Static<typeof researchSchema>;

// ============================================================
//  Structured output (codemode / ctx.executeTool callers)
// ============================================================
//
// pi hands codemode scripts `structuredContent` instead of the text when a tool
// declares `outputSchema`, so every tool declares one and always returns it.
// Cosmetic fields (favicon, image URLs) stay text-only to keep the shape small.
const envelopeFields = {
  request_id: Type.Optional(Type.String()),
  credits: Type.Optional(Type.Number({ description: "Tavily credits consumed by this call" })),
  response_time: Type.Optional(Type.Number()),
  truncated: Type.Boolean({ description: "Model-facing text was truncated; the full output is at full_output_path" }),
  full_output_path: Type.Optional(Type.String()),
  dropped_params: Type.Optional(Type.Array(Type.String())),
  /** True when machine-readable content was byte-capped (raw_content/pages) as well as the text. */
  structured_truncated: Type.Optional(Type.Boolean()),
  /** True when the result was served from the in-session response cache (0 credits). */
  cached: Type.Optional(Type.Boolean()),
};

export const searchOutputSchema = Type.Object({
  endpoint: Type.Literal("search"),
  query: Type.String(),
  results_count: Type.Integer(),
  has_answer: Type.Boolean(),
  answer: Type.Optional(Type.String()),
  results: Type.Array(
    Type.Object({
      title: Type.String(),
      url: Type.String(),
      score: Type.Optional(Type.Number()),
      published_date: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      raw_content: Type.Optional(Type.String()),
    }),
  ),
  ...envelopeFields,
});

export const extractOutputSchema = Type.Object({
  endpoint: Type.Literal("extract"),
  extracted_count: Type.Integer(),
  failed_count: Type.Integer(),
  results: Type.Array(Type.Object({ url: Type.String(), raw_content: Type.String() })),
  failed_results: Type.Array(Type.Object({ url: Type.String(), error: Type.String() })),
  ...envelopeFields,
});

export const mapOutputSchema = Type.Object({
  endpoint: Type.Literal("map"),
  base_url: Type.String(),
  url_count: Type.Integer(),
  urls: Type.Array(Type.String()),
  ...envelopeFields,
});

export const crawlOutputSchema = Type.Object({
  endpoint: Type.Literal("crawl"),
  base_url: Type.String(),
  page_count: Type.Integer(),
  pages: Type.Array(Type.Object({ url: Type.String(), raw_content: Type.String() })),
  ...envelopeFields,
});

export const researchOutputSchema = Type.Object({
  endpoint: Type.Literal("research"),
  model: Type.Optional(Type.String()),
  source_count: Type.Integer(),
  partial: Type.Boolean({ description: "true when the run was interrupted and only the partial report was recovered" }),
  content: Type.Unknown(),
  sources: Type.Array(Type.Object({ title: Type.String(), url: Type.String() })),
  ...envelopeFields,
});
