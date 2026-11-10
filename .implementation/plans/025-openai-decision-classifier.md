# Plan 025 — Built-in classifier backend: OpenAI Decisions API

Adds `classifier.builtin: "openai"` alongside `"openrouter"` — same
classifier pass, same merge/fallback/log/debug semantics, different
decision-API vendor. Mirrors task 014; the OpenRouter path is untouched.

## OpenAI Decisions API (probed from docs, 2025)

- Endpoint: `POST {baseUrl}/decisions`, default base
  `https://api.openai.com/v1`; auth `Authorization: Bearer <OPENAI_API_KEY>`.
- Only model today: `gpt-6-luna` → `model` is **optional** for this backend,
  defaults to `gpt-6-luna` (unlike openrouter, which requires a model).
- Request: `{ model, input, questions }` — `input` is shared evidence (text
  string or message array); `questions` is an **array** of
  `{ type: "choice", name, instructions, choices: [{ value, description }] }`.
- Response: `{ answers: [ { type: "choice", name, choice, probabilities,
  confidence } | { type: "refusal", name } ] }` — an **array** keyed by
  `name`, vs OpenRouter's object keyed by qKey.
- Cap: 400 questions per request → larger diffs than that fail per the
  normal degrade path (upgrade trigger for the per-chapter chunking noted in
  `decisions.ts`'s shortcut comment).

## Mapping (reuses 014's protocol walk)

- Shared evidence `input` = the same rendered chapter blocks OpenRouter
  gets as `state` (one text block per chapter, semantic title included).
- One `choice` question per changed line: `name: "q<N>"`, same `q<N>` →
  `(file, side, line)` side map; `instructions` = context + configured
  `instructions` + line reference; `choices` = the `criteria` map as
  `{ value: markName, description }`.
- `refusal` answers = skipped line (keeps rules mark), same as any answer
  outside the vocabulary / expected coordinates.

## Changes

- **`src/types.ts`** — `ClassifierConfig.builtin?: "openrouter" | "openai"`.
- **`src/decisions.ts`** — the bulk:
  - `decisionsRequestBody` branches on `cfg.builtin`: openai builds
    `{ model, input, questions: [...] }` (array), sharing the existing
    chapter/line walk and keyMap; criteria → `choices` parts.
  - `parseDecisionsResponse` normalizes the envelope: array answers are
    indexed by `answer.name` before the existing qKey lookup — one code
    path after that.
  - `decisionsClassify` dispatches on `cfg.builtin` (endpoint path, default
    base, model default) so call sites don't branch.
  - apiKey resolution: `classifier.apiKey` → `OPENAI_API_KEY` env → llm
    `defaults.apiKey` (openrouter keeps `OPENROUTER_API_KEY`).
- **`src/custom-classifier.ts`** — `loadClassifierConfig` accepts
  `builtin: "openai"` (model optional → default filled in `decisionsClassify`
  or at load; decide at implementation, one place); `applyClassifier`
  unchanged (already delegates to `decisionsClassify`).
- **`src/main.ts`** — `debug-classify` backend label `openai:<model>`;
  no new branch if dispatch stays inside `decisionsClassify`.
- **Tests** (`tests/decisions.test.ts`): openai config acceptance (no model
  → default), request-body shape (array questions, choices parts), array
  answer parsing (incl. refusal skip + vocabulary/coordinate validation),
  key resolution with `OPENAI_API_KEY`, HTTP degrade path. Mind the 014
  learning: `delete process.env.OPENAI_API_KEY` at file top.

## Could break

- `loadClassifierConfig` currently rejects unknown `builtin` values → tests
  asserting `builtin: "other"` still rejected must keep passing.
- Shared `parseDecisionsResponse` — openrouter fixture behavior must not
  change (run the existing suite).
- One OpenAI key in llm `defaults` also serving narrate: unchanged behavior,
  but the openai classifier now reads it — document in the key-resolution
  comment.

## Docs (update with the task, not after)

- spec §16.1 (config keys: `builtin: "openai"`, optional model default,
  `OPENAI_API_KEY` chain) and §16.5 (built-in backends: openai endpoint,
  envelope differences, refusal semantics).
- design D§6a config list mentions backends generically — only touch if it
  names vendors.
- task index entry (025) + this plan.

## Verification

- Fixture test suite green (`node --test "tests/**/*.test.ts"` — glob, not
  dir; 014 learning).
- Live smoke vs a real key in `tmp/demo` if available: `debug-classify`
  transcript shows `openai:gpt-6-luna` and marks land per line.
- Existing openrouter tests untouched and green (no regression on 014).
