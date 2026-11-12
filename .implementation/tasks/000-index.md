# Task index

Tasks in **execution order**. Numbers reflect execution order for pending
tasks; completed tasks keep their original numbers (process.md). The order
below is the current plan.

- `001` M1 Spine — startup, refs, tree/file explorer, diff→chapters, first screen + session view + syntax highlighting — **done** (hand-rolled renderer; slice 4 superseded by 002)
- `002` Pierre adoption — swap hand-rolled diffview/highlighter/explorer-tree for `@pierre/*` packages — **done** (esbuild + splitting; adapter feeds `parsePatchFiles`; `initPierre()` highlighter preload; `containerWrapper` rule; learned facts folded into `.implementation/docs/pierre-packages.md`).
- `003` M2 Comments — composer, identity, resolve, server-side anchor capture, deep links (comments render via pierre annotations) — **done** (design A: inline annotation rows; composer opens via `onLineNumberClick`; annotation rows styled via shadow-root `adoptedStyleSheets`; deep-link scroll+flash).
- `004` M3 Rebase survival — staleness (jj digest + git `headRef`), refresh, remap (with hunk visibility check), orphan triage (re-pin via pierre selection API) — **done** (`src/remap.ts`; jj refresh in place, git supersede flow, orphan triage banner; spec §22.1 resolved: jj 0.46 emits funcname context)
- `005` M4 Chunker tuning — function boundaries, keep-together, size config; decide large-diff virtualization (pierre ships the component) — **done** (funcname from hunk header, keep-together up to maxLines, distance fallback; §22.5 resolved: chaptering is the virtualization)
- `006` Multi-file chapters — chunker drops the file-boundary rule; `Chapter.files[]` slices, `LineMark.file`, no legacy migration (decided); foundational — lands before the pending milestones — **done** (chunker/store/remap/types + per-file diff blocks; verified live in tmp/demo)
- `007` M5 Attention marks — rule-based classify + line marking UI (marks render via pierre annotations); `LineMark.file` from 006 — **done** (`src/classify.ts` rules pass at every chapter rebuild; marks projected through `commentAnnotations` alongside comments) — rendering reworked by `009`
- `008` Custom classifier hook — exec protocol (stdin/stdout JSON), custom marks override rules per line, `markSource: "custom"`, fallback knob, classifier.log + debug-classify CLI; extensible mark names + classifyRules globs — **done** (`src/custom-classifier.ts`; one rebuild pipeline `chaptersFromDiff` shared by create/refresh/supersede; demo classifier in `tmp/demo`)
- `009` Marks gutter column — **done** — attention marks render as glyphs in a dedicated gutter column beside the line numbers (FileDiff `onPostRender` decoration pass), not as chips in annotation rows below the line; annotation rows keep comments only — no vertical cost per mark, scales to large MRs (no API/data changes)
- `010` M6 Export/import — download, merge-on-import (`updatedAt` wins), re-verification (no pierre surface) — **done** (`{ raw, headers }` download result in server.ts; `mergeSessions` pure + `importSession` in store.ts; export link + import button in UI; verified live against tmp/demo)
- `011` M7 LLM narratives — llm.ts, narrate, shared classification call (no pierre surface); prompt sees all of a chapter's file slices — **done** (openai/anthropic/custom-exec adapters, blocking v1, shared-call, 409 guard; §22.2 resolved)
- `012` Parser guard — **done** (`-c diff.mnemonicPrefix=false` in buildDiff — no `--no-mnemonic-prefix` option exists; DIFF_GIT/stripPathPrefix also tolerate mnemonic prefixes for foreign diffs)
- `013` Custom-mark glyph visibility — neutral `·` invisible in dark mode → custom names render their uppercase initial in the muted color (readable, distinguishes names); spec §9.3/§18 + ux §3.2 updated — **done**
- `014` Built-in classifier (OpenRouter decision API) — `classifier.builtin: "openrouter"` backend (`src/decisions.ts`), one `choice` question per changed line, criteria map = configurable mark names+descriptions, apiKey classifier→env→llm defaults; jev (`typesafe/jev-1.14`) is just a model on the API; exec hook unchanged and wins when both set — **done**
- `015` Full-file renderer fix — explorer `File` view renders nothing: preload the file's language into the shared highlighter before `File.render` (pierre 1.6.4 swallows the deferred highlight re-render) — **done** (`pierre-adapter.js` `createFileView`: `getSharedHighlighter([lang])` before render; comment records the pierre 1.6.4 short-circuit)
- `016` Logs folder — all logs in `.sky-eye/logs/`, overwritten per run, only the most recent kept — **done** (`custom-classifier.ts` `writeLog` → `classifier.log`; `sky-eye debug-classify` replay in `main.ts`)
- `017` Archive/delete review — archive → `.sky-eye/archive/` (+ restore, `?archived=1` listing), delete permanent; header + first-screen UI — **done** (`store.ts` `archiveSession`/`unarchiveSession`, routes, first-screen archived list + restore/delete)
- `018` Regenerate all — one click re-runs rules + classifier + narrate for every chapter in place (`rerun-all`, spec §16.6) — **done** (`narrate.ts` `rerunAll`, route + progress banner/disabled button in `app.js`)
- `019` Semantic chunking — `tasks.chunk` LLM task groups hunks into titled chapters (one call, §8a); pure chunker fallback; classifier sees chapter titles; `rechunk` endpoint + creation loader — **done** (`src/semantic-chunk.ts` + `rechunkSession` in `remap.ts`; fixtures in `semantic-chunk.test.ts`)
- `020` Chapter navigation & eager analysis — one chapter at a time + chapter rail (title/description/change summary, nested file list), accordion removed; eager narrate pass ends every chapter-building pipeline (spec §16.2); reading-order chapter ordering pass (spec §16.7) — **done** (`src/analyze.ts` `ensureAnalyzed` behind create/refresh/rechunk; `parseOrderResponse` permutation validation; lazy on-open narrate loop removed; verified live headless in tmp repos; indeterminate analyze banner as the v1 shortcut, spec/ux updated)
- `021` Viewed state + per-file accordion — `Chapter.viewedFiles` (per
  `(chapter, file)` slice), derived chapter-viewed, viewed toggles in body
  headers + rail ✓ glyphs, ephemeral collapse (viewed → collapsed by
  default, collapses on mark), carry by chapter id, not merged on import
  (spec §9.3/§10/§18, ux §3.2–3.3) — **done** (`carryNarratives` →
  `carryChapterState`; ephemeral collapse via module-level open-overrides
  map; `forceOpen` before every scroll+flash path)
- `022` Session header redesign — three-line layout (title / context: repo path + head/base branch / actions), mark-reviewed as a button, primary actions + "more" overflow menu, hover help text on every action (ux §3.1, spec §18, design §9.8) — **done** (class-scoped `header.session-header` so the first screen's single-row header is untouched; native `<details>` overflow menu, existing handler ids preserved)
- `024` Claude SDK LLM provider — `provider: "claude"` via
  `@anthropic-ai/sdk`; apiKey + subscription OAuth authToken chains
  (spec §2 dependency-policy amendment, §16.1, §22.2) — **done**
  (`provider: "claude"` via `@anthropic-ai/sdk` 1.6.0; credential chain
  apiKey → env, authToken → envs for Pro/Max subscriptions; no-credential
  → task skipped; SDK sends Bearer auth, not x-api-key)
- `025` Built-in classifier backend: OpenAI Decisions API —
  `classifier.builtin: "openai"` (`POST {baseUrl}/decisions`, model
  default `gpt-6-luna`), apiKey chain `classifier.apiKey` →
  `OPENAI_API_KEY` env → llm defaults; same merge/fallback/log/debug
  semantics as 014; openrouter backend untouched — **done**
  (`decisionsUrl` vendor dispatch; array answers normalized by `name`;
  refusals skip the line)
- `023` File-bar accordion + full-file mode — **done** (`fullFileHunks` padding in the adapter from `/api/file`; whole-bar toggle, de-linked path; unchanged-line comments pinned by remap §13.3.5, visible only in full-file mode; deep links force full-file before scroll+flash)
- `027` Claude subscriptions via the `claude` CLI — `provider: "claude-code"`
  shells out to `claude -p` (auth delegated to Claude Code's login: no tokens
  in config, CLI owns OAuth refresh + rate limits); **removes** task 024's
  `claude` provider, the `authToken` key and `@anthropic-ai/sdk` — runtime
  deps zero again; unknown provider values fail loudly (spec §2/§16.1/§22.2)
  — **done**
- `028` Global config (XDG) — optional `$XDG_CONFIG_HOME/sky-eye/config.json`
  layered under the repo's `.sky-eye/config.json` (repo wins per field, deep
  merge, arrays replaced); `src/config.ts` + loader delegation; check-config
  reports layered paths — **done**
