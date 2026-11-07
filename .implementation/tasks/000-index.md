# Task index

Tasks in **execution order**. Numbers reflect execution order for pending
tasks; completed tasks keep their original numbers (process.md). The order
below is the current plan.

- `001` M1 Spine — startup, refs, tree/file explorer, diff→chapters, first screen + session view + syntax highlighting — **done** (hand-rolled renderer; slice 4 superseded by 008)
- `008` Pierre adoption — swap hand-rolled diffview/highlighter/explorer-tree for `@pierre/*` packages — **done** (esbuild + splitting; adapter feeds `parsePatchFiles`; `initPierre()` highlighter preload; `containerWrapper` rule; learned facts folded into `.implementation/docs/pierre-packages.md`).
- `002` M2 Comments — composer, identity, resolve, server-side anchor capture, deep links (comments render via pierre annotations) — **done** (design A: inline annotation rows; composer opens via `onLineNumberClick`; annotation rows styled via shadow-root `adoptedStyleSheets`; deep-link scroll+flash).
- `003` M3 Rebase survival — staleness (jj digest + git `headRef`), refresh, remap (with hunk visibility check), orphan triage (re-pin via pierre selection API) — **done** (`src/remap.ts`; jj refresh in place, git supersede flow, orphan triage banner; spec §22.1 resolved: jj 0.46 emits funcname context)
- `004` M4 Chunker tuning — function boundaries, keep-together, size config; decide large-diff virtualization (pierre ships the component) — **done** (funcname from hunk header, keep-together up to maxLines, distance fallback; §22.5 resolved: chaptering is the virtualization)
- `009` Multi-file chapters — chunker drops the file-boundary rule; `Chapter.files[]` slices, `LineMark.file`, no legacy migration (decided); foundational — lands before the pending milestones (spec §8/§9.3/§13, design D§3/D§4, ux §3.2 already updated)
- `010` M5 Attention marks — rule-based classify + line marking UI (marks render via pierre annotations); `LineMark.file` from 009
- `011` M6 Export/import — download, merge-on-import (`updatedAt` wins), re-verification (no pierre surface)
- `012` M7 LLM narratives — llm.ts, narrate, shared classification call (no pierre surface); prompt sees all of a chapter's file slices
- `013` Parser guard — pass --no-mnemonic-prefix in buildDiff git args (user config breaks parseUnifiedDiff)
