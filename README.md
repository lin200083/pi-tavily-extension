# Tavily extension for pi

English | [简体中文](README.zh-CN.md)

Five web tools for [pi](https://github.com/earendil-works/pi) — `tavily_search`,
`tavily_extract`, `tavily_map`, `tavily_crawl`, `tavily_research` — with an
optional per-session credit ceiling, multi-key failover, a response cache,
context-safe truncation, and full use of pi's tool contract (declarations,
guidelines, renderers, structured output, nested calls). Per-call credits are
shown in the TUI result line; there is no session spend footer (see
[Deliberate choices](#deliberate-choices)).

## Install

Requires pi with extension support (`@earendil-works/pi-coding-agent`) and Node
with TypeScript loading — pi uses `jiti`, so there is no build step.

### Option A — clone into the extensions directory (recommended)

```bash
mkdir -p ~/.pi/agent/extensions
git clone https://github.com/lin200083/pi-tavily-extension.git \
  ~/.pi/agent/extensions/tavily

cp ~/.pi/agent/extensions/tavily/config.example.json \
   ~/.pi/agent/extensions/tavily/config.json
# then edit config.json and fill in apiKeys
```

pi loads subdirectories that contain an `index.ts` entry point from
`~/.pi/agent/extensions/`, so no settings file has to change. `config.json` is
git-ignored, so `git pull` never overwrites your keys:

```bash
git -C ~/.pi/agent/extensions/tavily pull
```

### Option B — install as a pi package

```bash
pi install git:github.com/lin200083/pi-tavily-extension
pi list        # confirm the source is configured
```

`pi install` records the source in `~/.pi/agent/settings.json`; add `--local`
to write `.pi/settings.json` for one project instead. `pi update --extensions`
reconciles the checkout, so put `config.json` one directory above it (the
extension looks there too) or re-copy it after an update.

Try it once without installing anything:

```bash
pi -e git:github.com/lin200083/pi-tavily-extension
```

### Both options

Restart pi (or `/reload`). On first start the extension writes
`config.example.json` when no config file exists yet; copy it to `config.json`
and fill in `apiKeys`.

Runtime dependencies are provided by pi (`@earendil-works/*`, `typebox`); there
is no `npm install` step. Keys are read from `config.json` only — there is no
environment-variable override.

## Configuration

`config.json` in this directory — git-ignored, so only `config.example.json` is
tracked and real API keys never reach the repository. It is re-read on every
call for billing-related values; tool descriptions are generated at load, so `/reload` after changing
`defaultSearchDepth` / `defaultResearchModel`.

| Key | Default | Meaning |
|---|---|---|
| `apiKeys` | — | One or more Tavily keys. Round-robin; 401/429/432/433 and 5xx fail over to the next key. |
| `projectId` | — | Sent as `X-Project-ID` (dashboard attribution). |
| `humanId` | — | Sent as `X-Human-Id` (hashed by Tavily). |
| `defaultSearchDepth` | `advanced` | 2 credits/call at `advanced`, 1 at `basic`/`fast`/`ultra-fast`. |
| `defaultMaxResults` | `10` | 1–20. |
| `defaultResearchModel` | `pro` | 15–250 credits/task at `pro`, 4–110 at `mini`, `auto` lets the server pick. |
| `maxSessionCredits` | `0` | Hard **per-session** ceiling; resets on `session_start`. `0` = unlimited. Estimates are upper bounds, in-flight calls reserve their estimate, and cache hits are free. |
| `searchTimeoutMs` | `60000` | Client-side `/search` deadline. |
| `cacheTtlSeconds` | `300` | Reuse an identical search/extract within a session for N seconds instead of billing it again. `0` disables. |

A `--tavily-depth basic|advanced|fast|ultra-fast` CLI flag overrides
`defaultSearchDepth` for one run. In headless modes, `tavily_research` refuses
`files` unless `--tavily-allow-file-upload` is set (contents are still scanned
for credentials); interactive mode asks for confirmation.

## Tools

| Tool | Use it for | Notes |
|---|---|---|
| `tavily_search` | no known source | `topic='news'` only for news; set `time_range`/dates for recency |
| `tavily_extract` | 1–20 known URLs | failed URLs are reported per URL and not charged |
| `tavily_map` | unknown site structure | URLs only, no page content |
| `tavily_crawl` | many pages of one site | regex path/domain filters, `instructions` |
| `tavily_research` | surveys, reports, cited comparisons | 30–120s+, most expensive; `background=true` and `extract_sources=true` are opt-in |

## Behavior worth knowing

- **Budget gate** — before every call (including nested calls from codemode), a
  `tool_call` handler checks `maxSessionCredits`, reserving the estimate so
  parallel calls cannot all pass the same remaining budget. Credits are
  recorded once from the tool result; the budget and cache reset on
  `session_start`. A cache hit (0 credits) still works after the budget is gone.
- **Secret guard** — a query/URL containing what looks like a key, token, JWT or
  private key is refused before it leaves the machine. `research.files`
  contents are scanned too, not just the paths.
- **File upload confirmation** — `tavily_research` with `files` asks before
  sending local file contents to Tavily in interactive mode. Headless modes are
  blocked unless `--tavily-allow-file-upload` is passed.
- **Response cache** — identical search/extract calls within
  `cacheTtlSeconds` return instantly at 0 credits (`details.cached`).
- **Repeat markers** — URLs actually read with `extract`/`crawl` are tagged
  `[已在本会话抓取过]` in later results. Search snippets do not mark a URL as
  fetched.
- **Output truncation** — oversized output keeps the head for the model and
  writes the full text to a temp file (`details.full_output_path`, `read` with
  `offset`/`limit`). Files are owner-only, kept on quit so a resumed session can
  still read them, and swept after 7 days.
- **Structured output** — every tool declares `outputSchema` and returns
  `structuredContent`; large page bodies are byte-capped there too
  (`structured_truncated`).
- **Failures** — returned as `isError: true` with `details.status` /
  `request_id` instead of thrown, so the failure metadata survives.
- **Images** — `media: true` attaches up to 2 result images as pi image blocks.
  Private/loopback image hosts are refused, redirects are re-checked, and bodies
  are capped at 2 MB while reading.
- **Background research** — `background: true` returns immediately and delivers
  the report as a new message when it finishes; aborted on session shutdown.
- **Prompt loss self-check** — if a custom system prompt drops the extension's
  guidelines, one warning is emitted on the first run. Headless modes get it on
  stderr.

## Language policy

Tool declarations (what the model reads first) are English. Errors are
bilingual, because the user reads Chinese while models and codemode scripts are
usually English-first. TUI strings are Chinese.

## Deliberate choices

- **Direct tool exposure.** All five tools are declared directly. Switching to
  `exposure: "codemode"` does not save tokens (codemode inlines declarations up
  to a 3000-token budget) and adds a script-writing step between the model and a
  one-line search.
- **No environment-variable config.** Keys live in `config.json` only; a
  project-scoped copy would otherwise need keys in a repository.
- **No spend UI.** Session spend is tracked per session to feed the
  `maxSessionCredits` gate and is reset on `session_start`; per-call credits are
  shown in the TUI result line, but nothing is rendered in the footer. A durable
  ledger (`appendEntry`) is future work.
- **`reachesTools` / `prepareLoadout` are unused.** They only matter for tools
  that orchestrate others; the one nested call (research → extract) is
  hardcoded, not named by the model.

## Files

| File | Role |
|---|---|
| `index.ts` | tool registration, guards, renderers, session state |
| `client.ts` | HTTP, multi-key failover, SSE, error mapping |
| `research.ts` | streaming/polling research, file attachments |
| `config.ts` | `config.json` reading and defaults |
| `schemas.ts` | TypeBox parameters + output schemas |
| `params.ts` | tool params → API body, `dropped` reporting |
| `format.ts` | model-facing text, truncation helpers, repeat markers |
| `images.ts` | Tavily image URLs → pi image blocks |
| `countries.ts` | country aliases and normalization |
| `prompts.ts` | descriptions, snippets, 12 policy rules |
| `PROMPT.md` | prompt design notes and token budget |

## Verify changes

Load the extension with pi's jiti loader and exercise the tool paths with mocked
HTTP, then run a real `pi -p --tavily-depth basic` smoke call.

## License

[MIT](LICENSE) © lin200083
