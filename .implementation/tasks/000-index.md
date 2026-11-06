# Task index

High-level tasks in execution order (each maps to a spec §21 milestone).
New todos that come up get the next free number as their own file.

- `001` M1 Spine — startup, refs, tree/file explorer, diff→chapters, first screen + session view + syntax highlighting
- `002` M2 Comments — composer, identity, resolve, server-side anchor capture, deep links
- `003` M3 Rebase survival — staleness (jj digest + git `headRef`), refresh, remap (with hunk visibility check), orphan triage
- `004` M4 Chunker tuning — function boundaries, keep-together, size config
- `005` M5 Attention marks — rule-based classify + line marking UI
- `006` M6 Export/import — download, merge-on-import (`updatedAt` wins), re-verification
- `007` M7 LLM narratives — llm.ts, narrate, shared classification call
- `008` Pierre adoption — swap hand-rolled diffview/highlighter/explorer-tree
  for `@pierre/*` packages (dependency policy revised in spec §2); run before
  002/005 since annotations replace their hand-built rendering paths
