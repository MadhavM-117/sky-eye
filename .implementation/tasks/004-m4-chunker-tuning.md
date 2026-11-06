# 004 — M4 Chunker tuning

**Goal:** chapters split at function boundaries, keep-together rules,
`review` size config knob.

**Deliverable/acceptance** (spec §21 M4): fixture suite green; manual review
of a real 500-line diff reads sensibly. Decide large-diff virtualization
here (spec §22.6).

Spec: §8.

Pierre notes (after 008): chunking stays a server-side pure function — pierre
does not chunk. Only touch: if large diffs crawl (spec §22.5), swap
`FileDiff` → `VirtualizedFileDiff` in the adapter (one component, same input
shape) rather than building virtualization. Also re-check that pierre's hunk
separators render our chapter boundaries (`hunkSeparators` option) cleanly
after any chunker changes.
