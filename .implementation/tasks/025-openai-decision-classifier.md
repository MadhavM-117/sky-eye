# 025 — Built-in classifier backend: OpenAI Decisions API

**Goal:** a second built-in classifier backend so per-line attention marks
can come from **OpenAI's Decisions API** (`POST /v1/decisions`,
`gpt-6-luna`) instead of OpenRouter. Same UX contract as task 014:
`classifier.builtin: "openai"` in `.sky-eye/config.json`, model selectable
via `classifier.model` (default `gpt-6-luna` — the only model OpenAI
supports today), same mark names/criteria config, same
degrade-don't-fail semantics, same `classifier.log` / `debug-classify`
surfaces. The OpenRouter backend and exec hook are untouched.

**Deliverable/acceptance** (spec §16.5): `builtin: "openai"` + key config
→ per-line AI marks at session creation; apiKey resolves
`classifier.apiKey` → `OPENAI_API_KEY` env → llm `defaults`; missing key or
HTTP failure → rules fallback (or cleared with `fallback:false`); refusal
answers skip the line (rules mark kept); run logged; `debug-classify`
prints the transcript with an `openai:<model>` label; existing openrouter
and exec-hook configs behave exactly as before.

Spec: §16.1 (config keys), §16.5 (built-in backends). Full plan:
`.implementation/plans/025-openai-decision-classifier.md`.

**Done** (`decisionsUrl` + vendor branch in `decisionsRequestBody` /
`parseDecisionsResponse` / `resolveApiKey` — array answers normalized by
`name`, refusals skipped; `loadClassifierConfig` fills the `gpt-6-luna`
default; debug-classify label `openai:gpt-6-luna @ …/v1/decisions`;
openrouter path + tests unchanged and green).
