/**
 * Tavily configuration: reads API keys from config.json located in this
 * extension's directory. Environment variables are intentionally not used.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Directory of this extension (works under jiti/ESM/CJS, and when compiled to a subdir)
const moduleDir: string =
  typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

/**
 * Find the extension root directory that holds config.json.
 * When loaded via jiti, moduleDir IS the extension dir. When compiled
 * (tsc outDir), moduleDir is a build subdir, so we walk one level up.
 */
function findConfigDir(): string {
  if (existsSync(join(moduleDir, "config.json"))) return moduleDir;
  const parent = dirname(moduleDir);
  if (existsSync(join(parent, "config.json"))) return parent;
  return moduleDir;
}

export const CONFIG_PATH = join(findConfigDir(), "config.json");
export const TEMPLATE_PATH = join(findConfigDir(), "config.example.json");

export interface TavilyConfigFile {
  /** One or more Tavily API keys. Multiple keys are used round-robin with automatic failover. */
  apiKeys?: string[];
  /** Optional project id attached via X-Project-ID for usage tracking in the Tavily dashboard. */
  projectId?: string;
  /** Optional end-user id attached via X-Human-Id (hashed by Tavily). */
  humanId?: string;
  /**
   * Default `search_depth` for tavily_search.
   * "advanced" (default) costs 2 credits per call and returns the richest
   * snippets; "basic"/"fast"/"ultra-fast" cost 1 credit.
   */
  defaultSearchDepth?: "basic" | "advanced" | "fast" | "ultra-fast";
  /** Default `max_results` for tavily_search (1-20). Tavily suggests 5 for focused answers, 10 for broader research. */
  defaultMaxResults?: number;
  /**
   * Default `model` for tavily_research. Credit boundaries per task:
   * "pro" (default) 15-250, "mini" 4-110, "auto" lets the server pick.
   */
  defaultResearchModel?: "mini" | "pro" | "auto";
  /**
   * Hard cap on credits one pi session may spend across all Tavily calls.
   * 0 (default) means unlimited. Reset on session_start; checked before every
   * call with in-flight reservations, so parallel calls cannot all pass the
   * same remaining budget.
   */
  maxSessionCredits?: number;
  /** Client-side deadline for /search in milliseconds (default 60000). */
  searchTimeoutMs?: number;
  /**
   * Seconds a successful identical search/extract response is reused within a
   * session instead of being billed again. 0 disables the cache. Default 300.
   */
  cacheTtlSeconds?: number;
}

/**
 * Cached config read. The file is re-read whenever mtime/size changes AND the
 * new content is compared against the cache before being adopted, so a save
 * that lands within the filesystem's mtime granularity (1s on some Windows
 * setups) with the same byte size is still picked up: mtime only decides
 * whether we stat+read again, never whether the content counts as changed.
 */
let configCache: { signature: string; raw: string; data: TavilyConfigFile } | null = null;

/**
 * The last error encountered while reading/parsing config.json, so startup can
 * distinguish "no keys configured" from "config.json is malformed". Cleared on
 * every successful read so a fixed file stops reporting the stale error.
 */
let lastConfigError: string | null = null;

/** Human-readable config read/parse error from the most recent read, if any. */
export function configReadError(): string | null {
  return lastConfigError;
}

function readConfigFile(): TavilyConfigFile {
  try {
    if (existsSync(CONFIG_PATH)) {
      const stat = statSync(CONFIG_PATH);
      const signature = `${stat.mtimeMs}:${stat.size}`;
      if (configCache && configCache.signature === signature) {
        return configCache.data;
      }
      const raw = readFileSync(CONFIG_PATH, "utf8");
      if (configCache && configCache.raw === raw) {
        // Content unchanged (mtime-only touch): refresh the signature, keep cache.
        configCache.signature = signature;
        return configCache.data;
      }
      const parsed = JSON.parse(raw) as TavilyConfigFile;
      const data = parsed && typeof parsed === "object" ? parsed : {};
      configCache = { signature, raw, data };
      lastConfigError = null;
      return data;
    }
    // config.json does not exist: not an error, just unconfigured.
    configCache = null;
    lastConfigError = null;
  } catch (err) {
    lastConfigError = (err as Error).message;
    console.error(
      `[tavily-extension] Failed to read ${CONFIG_PATH}: ${(err as Error).message}`,
    );
  }
  return {};
}

/** Resolve all configured API keys from config.json. */
export function resolveApiKeys(): string[] {
  const configured = readConfigFile().apiKeys;
  const fromFile = Array.isArray(configured) ? configured : [];
  return fromFile
    .filter((k): k is string => typeof k === "string")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

export function resolveProjectId(): string | undefined {
  const value = readConfigFile().projectId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveHumanId(): string | undefined {
  const value = readConfigFile().humanId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const SEARCH_DEPTHS = ["basic", "advanced", "fast", "ultra-fast"] as const;
const RESEARCH_MODELS = ["mini", "pro", "auto"] as const;

/**
 * Default search depth. "advanced" (2 credits) matches Tavily's own recommendation
 * for agent workflows — richest snippets per source. Drop to "basic" (1 credit)
 * in config.json to halve the cost of every search.
 *
 * Config is user-edited JSON, so the value is validated at runtime: an unknown
 * string would otherwise be sent to the API and turn every search into a 400.
 */
export function resolveDefaultSearchDepth(): TavilyConfigFile["defaultSearchDepth"] {
  const value: unknown = readConfigFile().defaultSearchDepth;
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (SEARCH_DEPTHS as readonly string[]).includes(normalized)
    ? (normalized as TavilyConfigFile["defaultSearchDepth"])
    : "advanced";
}

export function resolveDefaultMaxResults(): number {
  const n = readConfigFile().defaultMaxResults;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 20 ? n : 10;
}

/**
 * Default research model. "pro" (15-250 credits/task, multi-agent depth),
 * "mini" (4-110), or "auto" when the user opts in via config.json. Validated at
 * runtime for the same reason as defaultSearchDepth.
 */
export function resolveDefaultResearchModel(): TavilyConfigFile["defaultResearchModel"] {
  const value: unknown = readConfigFile().defaultResearchModel;
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (RESEARCH_MODELS as readonly string[]).includes(normalized)
    ? (normalized as TavilyConfigFile["defaultResearchModel"])
    : "pro";
}

/** Session credit ceiling; 0 (or a non-positive value) means unlimited. */
export function resolveMaxSessionCredits(): number {
  const n = readConfigFile().maxSessionCredits;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Client-side /search deadline in ms (default 60s, clamped to 5s-10min). */
export function resolveSearchTimeoutMs(): number {
  const n = readConfigFile().searchTimeoutMs;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 60_000;
  return Math.min(Math.max(Math.floor(n), 5_000), 600_000);
}

/** Response cache TTL in seconds (default 300; 0 disables caching). */
export function resolveCacheTtlSeconds(): number {
  const n = readConfigFile().cacheTtlSeconds;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 300;
  return Math.min(Math.floor(n), 86_400);
}

/** Generate a config template on first run so the user knows where to put keys. */
export function ensureConfigTemplate(): void {
  if (existsSync(CONFIG_PATH) || existsSync(TEMPLATE_PATH)) return;
  try {
    const template: TavilyConfigFile = {
      apiKeys: ["tvly-YOUR_API_KEY_1", "tvly-YOUR_API_KEY_2"],
      projectId: "pi-agent",
      defaultSearchDepth: "advanced",
      defaultMaxResults: 10,
      defaultResearchModel: "pro",
      maxSessionCredits: 0,
      searchTimeoutMs: 60_000,
      cacheTtlSeconds: 300,
    };
    writeFileSync(
      TEMPLATE_PATH,
      JSON.stringify(template, null, 2) + "\n",
      "utf8",
    );
  } catch {
    // non-fatal
  }
}
