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

export function configDir(): string {
  return findConfigDir();
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
  /** Default `max_results` for tavily_search (0-20). Tavily suggests 5 for focused answers, 10 for broader research. */
  defaultMaxResults?: number;
  /**
   * Default `model` for tavily_research. Credit boundaries per task:
   * "pro" (default) 15-250, "mini" 4-110, "auto" lets the server pick.
   */
  defaultResearchModel?: "mini" | "pro" | "auto";
}

/**
 * Cached config read. The cache key is mtime+size, so editing config.json
 * still takes effect immediately without a reload, while repeated resolves
 * within a single request (keys + projectId + humanId) hit the cache instead
 * of re-reading the file from disk three times.
 */
let configCache: { signature: string; data: TavilyConfigFile } | null = null;

function readConfigFile(): TavilyConfigFile {
  try {
    if (existsSync(CONFIG_PATH)) {
      const stat = statSync(CONFIG_PATH);
      const signature = `${stat.mtimeMs}:${stat.size}`;
      if (configCache && configCache.signature === signature) {
        return configCache.data;
      }
      const raw = readFileSync(CONFIG_PATH, "utf8");
      const parsed = JSON.parse(raw) as TavilyConfigFile;
      const data = parsed && typeof parsed === "object" ? parsed : {};
      configCache = { signature, data };
      return data;
    }
  } catch (err) {
    console.error(
      `[tavily-extension] Failed to read ${CONFIG_PATH}: ${(err as Error).message}`,
    );
  }
  return {};
}

/** Resolve all configured API keys from config.json. */
export function resolveApiKeys(): string[] {
  const fromFile = readConfigFile().apiKeys ?? [];
  return fromFile.map((k) => k.trim()).filter((k) => k.length > 0);
}

export function resolveProjectId(): string | undefined {
  return readConfigFile().projectId ?? undefined;
}

export function resolveHumanId(): string | undefined {
  return readConfigFile().humanId ?? undefined;
}

/**
 * Default search depth. "advanced" (2 credits) matches Tavily's own recommendation
 * for agent workflows — richest snippets per source. Drop to "basic" (1 credit)
 * in config.json to halve the cost of every search.
 */
export function resolveDefaultSearchDepth(): TavilyConfigFile["defaultSearchDepth"] {
  return readConfigFile().defaultSearchDepth ?? "advanced";
}

export function resolveDefaultMaxResults(): number {
  const n = readConfigFile().defaultMaxResults;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 20 ? n : 5;
}

/**
 * Default research model. "pro" (15-250 credits/task, multi-agent depth) unless the
 * user opts into "mini" (4-110) or "auto" in config.json.
 */
export function resolveDefaultResearchModel(): TavilyConfigFile["defaultResearchModel"] {
  return readConfigFile().defaultResearchModel ?? "pro";
}

/** Generate a config template on first run so the user knows where to put keys. */
export function ensureConfigTemplate(): void {
  if (existsSync(CONFIG_PATH) || existsSync(TEMPLATE_PATH)) return;
  try {
    const template: TavilyConfigFile = {
      apiKeys: ["tvly-YOUR_API_KEY_1", "tvly-YOUR_API_KEY_2"],
      projectId: "pi-agent",
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
