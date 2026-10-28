# Changelog

## Unreleased

Documentation and packaging only; no runtime behavior changes.

- `README.md` / `README.zh-CN.md`: real install instructions — clone into
  `~/.pi/agent/extensions/tavily`, install as a pi package
  (`pi install git:github.com/lin200083/pi-tavily-extension`), or a one-off
  `pi -e` run, plus how to update and where `config.json` survives an update.
- Added `README.zh-CN.md` (Chinese translation), `LICENSE` (MIT), and
  `license` / `repository` / `homepage` / `keywords` in `package.json`.
- `config.json` is git-ignored; only `config.example.json` is tracked.

## 1.5.2

Fixes from a second full review of the installed copy.

### Budget and accounting

- Budget, response cache and fetched-URL markers reset on `session_start`, so a
  `/new`, resume or fork in the same process starts clean. `maxSessionCredits`
  is now genuinely per session.
- Credits are recorded once, from `tool_result` details, instead of in every
  execute path. `research.extract_sources` no longer counts its nested extract
  twice, and cache hits are free.
- Estimates now follow the call: extract per 5 URLs/depth, map per 10 pages,
  crawl as mapping + extraction. In-flight calls reserve their estimate, so
  parallel calls cannot all pass the same remaining budget.
- A cached search/extract bypasses an exhausted budget. The cache key includes
  `dropped` parameters, so a cached `[dropped: ...]` line cannot leak into a
  different call.
- A background research keeps its reservation until the task ends and backfills
  streamed usage before delivering the report. Foreground streaming research
  only awaits the backfill when a budget depends on it; otherwise the backfill
  finishes in the background.

### Correctness

- Search results no longer mark URLs as fetched. Only `extract`/`crawl` record a
  URL; search peeks at the set, so a snippet does not turn a later extract into
  a false `[已在本会话抓取过]` marker.
- `time_range` is dropped locally when `start_date`/`end_date` are present (the
  API returns 400 for both) and reported via `dropped`.
- Config values are validated at runtime: `defaultMaxResults` 1–20,
  `defaultSearchDepth` / `defaultResearchModel` enums, string-only keys and
  tracking ids.
- Chinese source headings (`## 参考资料`, `**参考文献**`) are recognized by the
  own-source-list detector.
- Spill files are kept on quit and swept after 7 days, matching the resume
  rationale; the quit-time deletion contradicted it.

### Safety

- `tavily_research` attachment contents are scanned for credential patterns
  before upload, not just the path arguments. Headless uploads require
  `--tavily-allow-file-upload`; interactive mode still confirms.
- Attachment sizes are checked with `stat` before reading, so a huge `.json` is
  rejected without being read and base64-encoded in memory.
- Image fetches reject loopback/private/link-local hosts, re-check redirects
  hop by hop, and cap the body while reading instead of after `arrayBuffer()`.

### Prompt

- The `safety` rule no longer offers a "unless the user asks" override; it now
  matches the unconditional credential guard and tells the model to request a
  redacted value.
- The `query` rule distinguishes 2–6 keyword lookups from full, specific
  sentences for comparisons/multi-facet questions; the `query` parameter
  description says the same thing.
- The research trigger now lives only in the `research` rule; `route` points to
  it instead of restating "survey, report or cited comparison".
- The research description says `extract_sources` appends excerpts after the
  report instead of implying it reads pages first.
- `PROMPT.md` budget updated to 11,309 chars (≈2,827 tokens) and the maintenance
  rule now allows necessary API field names in a rule.

### Docs

- README/PROMPT updated for the per-session budget, marker semantics, spill
  lifetime, file-upload behavior and image limits.

## 1.5.1

- **Removed** the footer status line (`ctx.ui.setStatus`), the `alt+t` shortcut,
  and `KeyManager.health()` — no session spend or key state is rendered in the
  UI. `sessionCredits` is still accumulated because `maxSessionCredits` (the
  budget gate) reads it.

## 1.5.0

Fixes and integration work from a full code review. IDs refer to the review
table (`A7`, `B1`, … `E9`).

### Billing and safety

- **A7** — HTTP 433 (PayGo limit) now fails over like 432 instead of aborting the
  call; both exhaust the key for the current month.
- **C2** — *(withdrawn in 1.5.1)* session credits are tracked for the budget
  gate only; the footer status line and its `alt+t` shortcut were removed.
- **C3** — new `tool_call` guard: blocks credential-shaped strings in any
  argument, enforces `maxSessionCredits` before every call (including nested
  codemode calls), and confirms `research.files` uploads in interactive mode.
- **C5** — in-session LRU cache for search/extract (`cacheTtlSeconds`,
  `details.cached`, 0-credit hits). Media requests are never cached.
- **C12** — `--tavily-depth` CLI flag (the `alt+t` shortcut was removed in 1.5.1).
- **B13** — a 401 marking now expires after 10 minutes instead of disabling a key
  for the whole process.
- **A8** — the "month exhausted" wording no longer claims a calendar-month
  reset. (A programmatic `reset()` existed briefly but had no user-facing entry
  point and was removed in 1.5.1.)
- **E1** — `idempotentHint: false` on all tools: retries are not free of cost.

### Correctness

- **B1** — `CrawlResultItem.images` added; the crawl renderer no longer touches an
  undeclared field.
- **B2** — `structuredContent` is byte-capped (`ITEM_SOFT_CAP_BYTES`,
  `structured_truncated`), so a minified page cannot wedge a codemode script.
- **B3** — spill files live 7 days (was 24h) and files created by this process are
  never swept, so a resumed session can still read them.
- **B4** — research credit backfill accepts the abort signal.
- **B5** — a 429 cooldown wait streams `⏳ 所有 Key 限流中，等待 Ns…` instead of
  looking hung; all endpoints pass `onWait`.
- **B6** — SSE reads attach listeners per frame and remove them when the read
  settles (previously `AbortSignal.any` leaked one listener per frame).
- **B7** — country aliases (`US`, `UK`, `UAE`, `Czechia`, …) and pass-through for
  unknown values; the hardcoded enum no longer swallows valid countries.
- **B8** — `max_results` minimum is 1 (was 0).
- **B9** — `output_schema` accepts any JSON Schema object, not only ones with
  `properties`.
- **B10** — attached research files with the same basename no longer collide;
  the size budget is checked against the base64-encoded payload.
- **B11** — the own-source-list detector recognizes more heading styles.
- **B12** — key round-robin cursors over the configured key list, so keys entering
  and leaving cooldown are not skipped or double-hit.
- **B14** — failures return `isError: true` with `details.status`/`request_id`
  instead of throwing away the metadata.
- **B15** — `background: true` research: returns immediately, delivers the report
  via `pi.sendMessage` when done, aborted on shutdown.
- **B16** — tracked temp files per process are capped.
- **B17** — stale spill sweep is asynchronous.
- **E5** — source URLs are matched with a boundary, not a prefix substring.
- **E9** — `details.full_output_path` on every tool.

### Features from pi capabilities

- **C9** — results tag URLs already fetched this session
  (`[已在本会话抓取过]`) instead of re-reading them.
- **C10** — `research.extract_sources` reads up to 3 cited pages through
  `ctx.executeTool` and appends capped verbatim excerpts.
- **C11** — `media: true` attaches up to 2 images as pi image blocks.
- **C13** — startup warnings reach headless modes via stderr.
- **C14** — the routing rule says "using only the tools declared above", so it
  stays correct when some tools are disabled.

### Housekeeping

- **E2** — the rules-lost check compares the full safety rule, not a 48-char prefix.
- **E3** — `searchTimeoutMs` is configurable.
- **E4** — `time_range` accepts `d/w/m/y`.
- **E6** — spill files are written mode `0o600`.
- **E7** — `max_wait` minimum is 60s (research below that was always truncated).
- **E8** — `topic`, `extract_depth` and `format` are only sent when requested.
- **D1** — `PROMPT.md` budget table now counts the JSON Schema structure that was
  missing (~45% of the real cost).
- **D3** — `README.md` and this changelog.
- **D4** — version bumped to 1.5.0.
- **D5** — the generated config template matches `config.example.json`.
- **D6** — model-facing failure text is bilingual.

Not addressed: `C1` (slash command), `C4` (`appendEntry` ledger), `C6` (env-var
config), `C7` (exposure strategy), `C8` (dynamic `setActiveTools`), `C15`
(`prepareLoadout`/`reachesTools`, not applicable), `D2` (shipped tests/eval).
