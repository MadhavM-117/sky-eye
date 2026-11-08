# 021 — Viewed state (files & chapters) + per-file accordion

**Goal:** review progress at file and chapter granularity (spec §9.3,
§10, §18; ux §3.2–3.3). Each per-file diff block in the chapter body is an
**accordion** (heading click collapses/expands) and carries a **viewed
checkbox**; the chapter header carries a chapter-level **viewed toggle**
that marks all its files viewed. Viewed state is persisted per
`(chapter, file)` slice as `Chapter.viewedFiles: string[]`; "chapter
viewed" is **derived** (every slice path listed) — the two directions of
the rule (all files viewed → chapter viewed; chapter viewed → all files
viewed) hold by construction. Marking a file/chapter viewed collapses its
block(s) immediately; a viewed file renders collapsed by default. Collapse
alone is ephemeral UI state (module-level open-overrides map), unmarking
does not auto-expand.

**Acceptance criteria:**
- `PATCH /api/sessions/:id { viewedFiles: { chapterId, files } , lastWriteAt }`
  replaces that chapter's list: unknown chapterId → 404, paths intersected
  with the chapter's slice paths, duplicates removed (spec §10).
- Chapter/file viewed toggles in the body work in both directions; rail
  shows read-only ✓ glyphs on chapter and file rows (chapter ✓ derived).
- Viewed files render collapsed on load; marking viewed collapses
  immediately; unmarking keeps the block closed; collapse of an unviewed
  file does not survive reload.
- Deep links to a line/comment, triage re-pin, and rail file clicks force
  the target block open before scroll+flash (hidden holders can't flash).
- Carry-over by chapter id (§13.2/§8a): jj refresh, git supersede and
  re-chunk keep viewedFiles for chapters whose id is unchanged; rebuilt
  chapters start unviewed. `carryNarratives` → `carryChapterState`.
- Import never merges viewedFiles (§14, like `reviewed`); session-level
  `reviewed` stays a manual toggle (no auto-derivation, spec §9.3).
- No migration: sessions without the field read as "nothing viewed".
- Fixtures for the carry (remap.test.ts) and an integration round-trip for
  the PATCH (validation, 404, conflict); existing suite stays green.

Plan: `.implementation/plans/021-viewed-state.md` (working copy:
`tmp/plans/viewed-state/plan.md`)
