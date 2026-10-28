/**
 * Request assembly: tool parameters -> Tavily API body, plus the list of
 * parameters that were dropped because a precondition was not met.
 *
 * Pure functions with no pi or filesystem imports so they can be unit tested
 * directly. `resolveCountry` is injected (countries.ts) to keep this module
 * dependency-free.
 */
import type { SearchParams, ExtractParams, MapParams, CrawlParams } from "./types.js";
import type {
  SearchToolParams,
  ExtractToolParams,
  MapToolParams,
  CrawlToolParams,
} from "./schemas.js";

export interface Built<T> {
  body: T;
  /** Parameters silently not applied; surfaced to the model so a call never lies about what it did. */
  dropped: string[];
}

export interface SearchDefaults {
  searchDepth: NonNullable<SearchParams["search_depth"]>;
  maxResults: number;
  resolveCountry: (value: string) => string | undefined;
}

export function buildSearchBody(
  params: SearchToolParams,
  defaults: SearchDefaults,
): Built<SearchParams> {
  const body: SearchParams = {
    query: params.query,
    search_depth: params.search_depth ?? defaults.searchDepth,
    max_results: params.max_results ?? defaults.maxResults,
  };
  // `topic` is only sent when the caller chose one: Tavily's own default is
  // "general" and re-sending it would override any future server-side change.
  if (params.topic) body.topic = params.topic;
  const dropped: string[] = [];
  const depth = body.search_depth;
  const topic = body.topic ?? "general";

  // chunks_per_source is not supported for ultra-fast.
  if (depth === "advanced" || depth === "basic" || depth === "fast") {
    body.chunks_per_source = params.chunks_per_source ?? 3;
  } else if (params.chunks_per_source) {
    dropped.push("chunks_per_source (not supported for ultra-fast)");
  }

  // Tavily rejects time_range together with start_date/end_date
  // ("When time_range is set, start_date or end_date cannot be set"). The
  // explicit dates are the more specific constraint, so they win; the model
  // sees the dropped parameter in the result instead of a 400.
  if (params.time_range) {
    if (params.start_date || params.end_date) {
      dropped.push("time_range (ignored because start_date/end_date were provided)");
    } else {
      body.time_range = params.time_range;
    }
  }
  if (params.start_date) body.start_date = params.start_date;
  if (params.end_date) body.end_date = params.end_date;
  if (params.include_published_date) body.include_published_date = true;
  if (params.filter_by_published_date) body.filter_by_published_date = true;
  if (params.include_answer !== undefined) body.include_answer = params.include_answer;
  if (params.include_raw_content !== undefined) body.include_raw_content = params.include_raw_content;

  // media is the merged form of include_images + descriptions + favicon.
  if (params.media) {
    body.include_images = true;
    body.include_image_descriptions = true;
    body.include_favicon = true;
  }

  if (params.include_domains?.length) {
    body.include_domains = params.include_domains;
    // include_domains_mode requires include_domains (400 otherwise).
    if (params.include_domains_mode) body.include_domains_mode = params.include_domains_mode;
  } else if (params.include_domains_mode) {
    dropped.push("include_domains_mode (requires include_domains)");
  }
  if (params.exclude_domains?.length) body.exclude_domains = params.exclude_domains;

  // country is only honored for topic=general AND rejected outright for
  // fast / ultra-fast depths (verified live: HTTP 400 "Country parameter is not
  // supported for fast or ultra-fast search_depth"). Both are preconditions, so
  // they are enforced here and reported via `dropped` instead of costing a
  // round trip. The API takes full English names.
  if (params.country) {
    if (topic !== "general") {
      dropped.push("country (only honored for topic=general)");
    } else if (depth === "fast" || depth === "ultra-fast") {
      dropped.push("country (not supported for fast/ultra-fast)");
    } else {
      // Aliases are resolved locally; unknown values pass through so the API's
      // own enum (which evolves) stays the source of truth.
      const country = defaults.resolveCountry(params.country);
      if (country) body.country = country;
      else dropped.push("country (empty value)");
    }
  }

  if (params.language) {
    body.language = params.language;
    // filter_by_language requires language (400 otherwise).
    if (params.filter_by_language) body.filter_by_language = true;
  } else if (params.filter_by_language) {
    dropped.push("filter_by_language (requires language)");
  }

  // safe_search is rejected for fast / ultra-fast depths.
  if (params.safe_search) {
    if (depth !== "fast" && depth !== "ultra-fast") body.safe_search = true;
    else dropped.push("safe_search (not supported for fast/ultra-fast)");
  }

  if (params.exact_match) body.exact_match = true;
  if (params.auto_parameters) body.auto_parameters = true;

  return { body, dropped };
}

export function buildExtractBody(params: ExtractToolParams): Built<ExtractParams> {
  const body: ExtractParams = { urls: params.urls };
  const dropped: string[] = [];

  // `extract_depth` and `format` defaults belong to the API; only send what the
  // caller chose so a server-side default change is not silently overridden.
  if (params.extract_depth) body.extract_depth = params.extract_depth;
  if (params.format) body.format = params.format;

  if (params.query) body.query = params.query;
  // chunks_per_source requires query (400 otherwise).
  if (params.chunks_per_source) {
    if (params.query) body.chunks_per_source = params.chunks_per_source;
    else dropped.push("chunks_per_source (requires query)");
  }

  if (params.media) {
    body.include_images = true;
    body.include_favicon = true;
  }
  if (params.timeout) body.timeout = params.timeout;

  return { body, dropped };
}

export function buildMapBody(params: MapToolParams): Built<MapParams> {
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

  return { body, dropped: [] };
}

export function buildCrawlBody(params: CrawlToolParams): Built<CrawlParams> {
  const body: CrawlParams = {
    url: params.url,
    max_depth: params.max_depth ?? 1,
    max_breadth: params.max_breadth ?? 20,
    limit: params.limit ?? 50,
    allow_external: params.allow_external ?? true,
  };
  // Bulk-read defaults (depth/breadth/limit) are product decisions documented in
  // the schema; extract_depth/format are left to the API unless requested.
  if (params.extract_depth) body.extract_depth = params.extract_depth;
  if (params.format) body.format = params.format;
  const dropped: string[] = [];

  if (params.instructions) {
    body.instructions = params.instructions;
    if (params.chunks_per_source) body.chunks_per_source = params.chunks_per_source;
  } else if (params.chunks_per_source) {
    dropped.push("chunks_per_source (requires instructions)");
  }

  if (params.select_paths?.length) body.select_paths = params.select_paths;
  if (params.exclude_paths?.length) body.exclude_paths = params.exclude_paths;
  if (params.select_domains?.length) body.select_domains = params.select_domains;
  if (params.exclude_domains?.length) body.exclude_domains = params.exclude_domains;
  if (params.media) {
    body.include_images = true;
    body.include_favicon = true;
  }
  if (params.timeout) body.timeout = params.timeout;

  return { body, dropped };
}
