# 019 — Semantic chunking (LLM-assisted chapter grouping)

**Goal:** chapter splitting becomes semantic when configured: a `chunk` LLM
task (`tasks.chunk` in `.sky-eye/config.json`) groups the diff's hunks into
titled chapters in one call — grouping + titles + analysis in the same step.
The classifier pass receives each chapter with its title as context. Any
failure or missing config falls back to the pure chunker (§16.1 degradation
rule). Slower is acceptable — creation shows an "analyzing diff into
chapters…" loader; a `re-group` control re-runs the grouping via
`POST /api/sessions/:id/rechunk`.

**Acceptance criteria:**
- `tasks.chunk` configured → semantic grouping at every chapter rebuild
  (create, jj refresh, git supersede) via the shared `chaptersFromDiff`.
- Fallback everywhere: no config, failed/malformed call, oversized inventory
  → pure chunker output; session never blocks on the LLM layer.
- Guardrails hold: every hunk exactly once, oversized groups re-split by the
  pure chunker (never split a hunk, ≤ maxLines per chapter), chapter ids keep
  the §8.5 formula.
- Classifier exec payload carries optional `title` per chapter (protocol 1,
  additive); decisions backend carries titles in `state` + instructions.
- `Chapter.title` feeds the accordion header and narrate's `otherTitles`.
- `POST /api/sessions/:id/rechunk` rebuilds grouping in place, 409
  `needsConfirm` gate on edited narratives, comments remapped via §13.3.
- Docs updated (spec §8a/§9.3/§10/§16/§20/§22, design, ux).

Plan: `.implementation/plans/019-semantic-chunking.md`
