# 018 — Regenerate everything for a review (one click)

**Goal:** one button that regenerates everything for a review: rules marks,
custom-classifier pass, and narrative + LLM marks for every chapter — in
place, on the stored diff.

**Status:** **done** — `POST /api/sessions/:id/rerun-all { confirm? }`
(spec §16.6): the per-chapter narration logic extracted from
`rerunChapter` and reused; one 409 `needsConfirm` gate when any narrative
is edited (UI asks once). Header button "regenerate" wired. Refresh (§13)
stays the tool for changed diffs — rerun-all never re-generates the diff.
