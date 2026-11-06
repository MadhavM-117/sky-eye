# Task index

Tasks in **execution order** (numbers are stable, never renumbered —
`process.md`; the order below is the current plan).

- `001` M1 Spine — startup, refs, tree/file explorer, diff→chapters, first screen + session view + syntax highlighting — **done** (hand-rolled renderer; slice 4 superseded by 008)
- `008` Pierre adoption — swap hand-rolled diffview/highlighter/explorer-tree for `@pierre/*` packages — **done** (esbuild + splitting; adapter feeds `parsePatchFiles`; `initPierre()` highlighter preload; `containerWrapper` rule; learned facts folded into `.implementation/docs/pierre-packages.md`).
- `002` M2 Comments — composer, identity, resolve, server-side anchor capture, deep links (comments render via pierre annotations). **Runs next**; selection API + annotation hooks verified live at 008.
- `003` M3 Rebase survival — staleness (jj digest + git `headRef`), refresh, remap (with hunk visibility check), orphan triage (re-pin via pierre selection API)
- `004` M4 Chunker tuning — function boundaries, keep-together, size config; decide large-diff virtualization (pierre ships the component)
- `005` M5 Attention marks — rule-based classify + line marking UI (marks render via pierre annotations)
- `006` M6 Export/import — download, merge-on-import (`updatedAt` wins), re-verification (no pierre surface)
- `007` M7 LLM narratives — llm.ts, narrate, shared classification call (no pierre surface)
