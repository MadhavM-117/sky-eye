# 029 — UI density, session summary, wrap/scroll toggle

User-requested changes:

1. **Full-screen UI** — drop the `.frame` 1200px cap so the UI uses the
   whole window (all views).
2. **Top-level change summary** — session header shows the whole change's
   size: `N files · +x −y` (sum over chapters, distinct file paths).
   A session-level *narrative* is deferred to a later task (needs a
   `Session` field, LLM prompt + pipeline step, PATCH/edit, export/import
   merge) — user decision: stats only for now.
3. **Wrap/scroll toggle for long diff lines** — default stays `scroll`
   (user decision); a header button switches diffs to pierre's native
   `overflow: 'wrap'` mode and back.

Accept:

- UI spans the full window width; first screen, session view and explorer
  all widen.
- Header context row shows `N files · +x −y` matching the sum of the rail's
  per-chapter numbers.
- Default: long lines scroll horizontally; **wrap** button wraps them, no
  horizontal scrollbar; **scroll** switches back. Known pierre trade-off:
  comment annotations/composer are hidden while wrapped (button title says
  so); attention-mark gutter glyphs are expected to keep working — verify.

Plan: `.implementation/plans/029-ui-density-summary-wrap.md`
