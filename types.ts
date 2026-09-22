/**
 * Tavily API types (per official docs at https://docs.tavily.com)
 */

// ---------- Search (/search) ----------

export interface SearchParams {
  query: string;
  topic?: "general" | "news" | "finance";
  search_depth?: "advanced" | "basic" | "fast" | "ultra-fast";
  chunks_per_source?: number; // 1-3 (advanced/basic/fast)
  max_results?: number; // 0-20
  time_range?: "day" | "week" | "month" | "year" | "d" | "w" | "m" | "y";
  start_date?: string; // YYYY-MM-DD
  end_date?: string; // YYYY-MM-DD
  include_published_date?: boolean; // beta; auto-enabled for topic=news
  filter_by_published_date?: boolean; // strict date window; implies include_published_date
  include_answer?: boolean | "basic" | "advanced";
  include_raw_content?: boolean | "markdown" | "text";
  include_images?: boolean;
  include_image_descriptions?: boolean;
  include_favicon?: boolean;
  include_domains?: string[]; // max 300
  exclude_domains?: string[]; // max 150
  include_domains_mode?: "restrict" | "prefer"; // requires include_domains
  country?: string; // general topic only
  language?: string; // ISO 639-1 code or English name; requires filter_by_language to hard-filter
  filter_by_language?: boolean; // requires language
  safe_search?: boolean; // not supported for fast / ultra-fast
  exact_match?: boolean;
  auto_parameters?: boolean;
  include_usage?: boolean;
}

export interface SearchResultItem {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string | null;
  favicon?: string;
  images?: Array<{ url: string; description?: string }>;
  published_date?: string;
  id?: string;
}

export interface SearchResponse {
  query: string;
  answer?: string | null;
  images?: Array<{ url: string; description?: string }>;
  results: SearchResultItem[];
  response_time: number;
  usage?: { credits?: number };
  request_id?: string;
  auto_parameters?: Record<string, unknown>;
}

// ---------- Extract (/extract) ----------

export interface ExtractParams {
  urls: string[]; // max 20
  query?: string; // rerank chunks by intent
  chunks_per_source?: number; // 1-5, requires query
  extract_depth?: "basic" | "advanced";
  format?: "markdown" | "text";
  include_images?: boolean;
  include_favicon?: boolean;
  timeout?: number; // 1-60 s
  include_usage?: boolean;
}

export interface ExtractResultItem {
  url: string;
  raw_content: string;
  images?: string[];
  favicon?: string;
}

export interface ExtractFailedItem {
  url: string;
  error: string;
}

export interface ExtractResponse {
  results: ExtractResultItem[];
  failed_results: ExtractFailedItem[];
  response_time: number;
  usage?: { credits?: number };
  request_id?: string;
}

// ---------- Map (/map) ----------

export interface MapParams {
  url: string;
  instructions?: string;
  max_depth?: number; // 1-5
  max_breadth?: number; // 1-500
  limit?: number; // total URL cap
  select_paths?: string[]; // regex
  select_domains?: string[]; // regex
  exclude_paths?: string[]; // regex
  exclude_domains?: string[]; // regex
  allow_external?: boolean;
  timeout?: number; // 10-150 s
  include_usage?: boolean;
}

export interface MapResponse {
  base_url: string;
  results: string[];
  response_time: number;
  usage?: { credits?: number };
  request_id?: string;
}

// ---------- Crawl (/crawl) ----------

export interface CrawlParams {
  url: string;
  instructions?: string;
  chunks_per_source?: number; // 1-5, requires instructions
  max_depth?: number; // 1-5
  max_breadth?: number; // 1-500
  limit?: number;
  select_paths?: string[]; // regex
  select_domains?: string[]; // regex
  exclude_paths?: string[]; // regex
  exclude_domains?: string[]; // regex
  allow_external?: boolean;
  include_images?: boolean;
  extract_depth?: "basic" | "advanced";
  format?: "markdown" | "text";
  include_favicon?: boolean;
  timeout?: number; // 10-150 s
  include_usage?: boolean;
}

export interface CrawlResultItem {
  url: string;
  raw_content: string;
  favicon?: string;
  images?: string[];
}

export interface CrawlResponse {
  base_url: string;
  results: CrawlResultItem[];
  response_time: number;
  usage?: { credits?: number };
  request_id?: string;
}

// ---------- Research (/research + GET /research/{id}) ----------

export interface ResearchParams {
  input: string;
  model?: "auto" | "mini" | "pro";
  stream?: boolean;
  output_schema?: Record<string, unknown> | null; // JSON Schema
  citation_format?: "numbered" | "mla" | "apa" | "chicago";
  include_domains?: string[]; // max 20
  exclude_domains?: string[]; // max 20
  output_length?: "short" | "standard" | "long";
  files?: Array<{ name: string; data: string; type: "base64" }>; // max 5
}

export interface ResearchTaskResponse {
  request_id: string;
  created_at?: string;
  status: "pending";
  input: string;
  model: string;
  response_time: number;
}

export interface ResearchSource {
  title: string;
  url: string;
  favicon?: string;
}

export interface ResearchCompletedResponse {
  request_id: string;
  created_at?: string;
  status: "completed";
  content: string | Record<string, unknown>;
  sources: ResearchSource[];
  response_time: number;
}

export interface ResearchPendingResponse {
  request_id: string;
  status: "pending" | "in_progress";
  response_time: number;
}

export interface ResearchFailedResponse {
  request_id: string;
  status: "failed";
  response_time: number;
}

export type ResearchStatusResponse =
  | ResearchCompletedResponse
  | ResearchPendingResponse
  | ResearchFailedResponse;

// ---------- Errors ----------

export interface TavilyErrorOptions {
  status: number;
  message: string;
  retryAfter?: number;
  requestId?: string;
}

export class TavilyError extends Error {
  status: number;
  retryAfter?: number;
  requestId?: string;

  constructor(opts: TavilyErrorOptions) {
    super(opts.message);
    this.name = "TavilyError";
    this.status = opts.status;
    this.retryAfter = opts.retryAfter;
    this.requestId = opts.requestId;
  }
}
