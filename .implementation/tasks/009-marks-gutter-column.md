# 009 — Marks gutter column

**Goal:** attention marks render in a dedicated gutter column (one colored
glyph beside the line numbers per marked line), not as chips in annotation
rows below the line. Mark-dense/large MRs stay readable: a mark adds no
vertical space. Annotation rows are reserved for comments + composer.

**Deliverable/acceptance:** marked lines show a gutter glyph that survives
scrolling (virtualized repaints) and hunk expansion; a line with both a mark
and a comment shows glyph + comment row; custom-classifier mark names render
as a neutral glyph with `markSource` on hover; no API/data changes.

Spec: §18 (marks paragraph, rewritten), U§3.2 (marks column bullet).
Full implementation plan: `tmp/plans/marks-column/plan.md`.

Notes (pierre, verified against vendored 1.6.4): pierre has no native
persistent gutter column — annotations are always rows below the line and
`renderGutterUtility` is hover-only. Use `FileDiff`'s `onPostRender` hook
(fires on every render, incl. `VirtualizedFileDiff` scroll repaints) to
sweep + re-stamp glyphs into row gutters in the shadow root; `[data-line]`
rows are `position: relative` and CSS custom properties cascade in, so
glyphs are inline-styled (no stylesheet injection). Marks leave the
`commentAnnotations` projection — update `tests/adapter.test.ts`.

Server side untouched: `LineMark`, session JSON, export/import, classify /
custom-classifier protocols all unchanged.

**Status: done** — glyphs stamped into the gutter `[data-column-number]`
cell via `onPostRender` (verified against the vendored pierre via
`@pierre/diffs/ssr` preloadFileDiff); spec §18 + ux §3.2 rewritten.
Follow-up found while verifying: task 013 (custom-name glyph visibility).
