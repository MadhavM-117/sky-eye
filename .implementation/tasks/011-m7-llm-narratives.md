# 011 — M7 LLM narratives + refined classification

**Goal:** `llm.ts` (OpenAI-compatible fetch client) + `narrate.ts` with lazy
firing on first chapter expansion, caching, editable narratives with
`narrativeEdited` guard, shared narrate/classify call when configs match.

**Deliverable/acceptance** (spec §21 M7): no config → everything still works
rules-only; with config → narratives generated on first expansion, cached,
editable, re-run asks before overwriting edits.

Spec: §16. Open questions to settle at task start: LLM protocol/provider
confirmation (§22.2), blocking vs streaming. Multi-file chapters (006): the
narrative prompt input is the chapter's diff across **all** its file slices
(spec §8 model), so a multi-file chapter narrates as one unit.

Pierre notes (after 002): none — narratives render in sky-eye's own editable
text field above the `FileDiff` block; the LLM layer never touches pierre
objects. Marks from the shared classify call render via the marks gutter
column (task 009) — no LLM-side surface.
