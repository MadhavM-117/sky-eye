# 010 — M5 Attention marks

**Goal:** rule-based `classify.ts` (safe/glance/focus) runs at session
creation; line marking UI in the diff view.

**Deliverable/acceptance** (spec §21 M5): test files/lockfiles show safe; a
touched auth line shows focus.

Spec: §16.4 rules, §9.3 `LineMark`/`markSource`.

Multi-file chapters (009): `LineMark` carries `file` — classification runs
per line within its file slice, and marks render on the right file block of
a chapter.

Pierre notes (after 008): marks are annotations too — project `LineMark`s
(focus/glance/safe) onto the same FileDiff annotation framework as comments
(002), styled with a small mark glyph/background. Colors come from sky-eye's
CSS custom properties (process.md foundations) layered over the pierre theme,
not from editing pierre internals. LLM marks (007) reuse this unchanged —
only the server's `markSource` differs.
