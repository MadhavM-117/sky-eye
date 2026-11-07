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
