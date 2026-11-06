# 007 — M7 LLM narratives + refined classification

**Goal:** `llm.ts` (OpenAI-compatible fetch client) + `narrate.ts` with lazy
firing on first chapter expansion, caching, editable narratives with
`narrativeEdited` guard, shared narrate/classify call when configs match.

**Deliverable/acceptance** (spec §21 M7): no config → everything still works
rules-only; with config → narratives generated on first expansion, cached,
editable, re-run asks before overwriting edits.

Spec: §16. Open questions to settle at task start: LLM protocol/provider
confirmation (§22.2), blocking vs streaming.
