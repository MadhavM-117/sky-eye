# 020 — Chapter navigation & eager analysis

**Goal:** the session body shows **one chapter at a time** with a chapter
rail on the left for navigation (per chapter: title, one-line narrative
description, `N files · +x −y`; the active row nests the chapter's file
list with status glyph + per-file `+x −y`, clicking scrolls to the file
block; prev/next controls). The all-chapters accordion is removed. Sessions
are **fully analysed before they are shown**: every chapter-building
pipeline (create, refresh/supersede, rechunk) ends with a narrate pass over
chapters lacking a narrative (spec §16.2), and chapters are **ordered for
reading** (spec §16.7): semantic chunker order, else one cheap ordering LLM
call when an LLM task is configured, else path order.

**Acceptance criteria:**
- Session body renders one chapter; rail lists all chapters in review
  order with title / description / change summary; active row highlighted
  with nested file list; file click scrolls to the file's diff block;
  explorer links intact; prev/next move between chapters; session opens on
  chapter 1.
- Deep links (chapter, file/line, comment) open the owning chapter and
  scroll+flash the target (§17).
- Creation, jj refresh, git supersede and rechunk all return fully
  analysed sessions: every chapter has a narrative unless the LLM layer
  degraded (no config / failed call → "unanalyzed", session never blocks,
  §16.1).
- Chapters physically ordered for reading; ordering call validated as a
  permutation (unknown/dup ids dropped, missed chapters appended in path
  order, malformed → path order); skipped when the chunk task is
  configured (§8a order wins) or < 2 chapters.
- `rerun` / `rerun-all` semantics unchanged (manual regeneration, 409
  gates intact); ordering is not re-run by rerun-all.
- Pure fixtures for order validation and the eager pass (fake adapters);
  integration covers analysed-vs-rules-only creation.
- Docs already updated (spec §16.2/§16.7, ux §1.5/§3.2–3.3, design §6a) —
  keep them honest if the indeterminate progress spinner ships as the v1
  shortcut for per-chapter progress.

Plan: `.implementation/plans/020-chapter-nav.md` (working copy:
`tmp/plans/chapter-nav/plan.md`)
