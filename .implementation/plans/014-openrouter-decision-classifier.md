# Plan 014 — Built-in classifier (OpenRouter decision API)

Condensed from `tmp/plans/builtin-classifier/plan.md` (full detail there).
jev (`typesafe/jev-1.14`) is a model on OpenRouter's decision-model API —
the backend is named after the API, not the model.

- **Config** (§16.1): `classifier` gains `builtin: "openrouter"`, `model`
  (e.g. `typesafe/jev-1.14`), `apiKey` (→ `OPENROUTER_API_KEY` env → llm
  `defaults`), `baseUrl` (default `https://openrouter.ai/api`),
  `instructions`, `criteria` (mark name → description; default = rules
  buckets). `command` (exec hook) wins when both set; neither → no pass.
- **`src/decisions.ts`** (new): `decisionsRequestBody` — classifier
  protocol request → decisions body (`state` = rendered chapters; one
  `choice` question per changed line keyed `q<N>`, side map back to
  coordinates, criteria = configured map); `parseDecisionsResponse` —
  answers at `answers[<qKey>].choice`, vocabulary + expected-coordinate
  validated; `decisionsClassify` — injectable fetch, run-shaped result,
  never throws.
- **Orchestration**: `applyCustomClassifier` → `applyClassifier` branches
  exec vs OpenRouter decision backend; merge/fallback/log
  (`classifier.log`, `command` label `openrouter:<model>`) unchanged;
  `markSource: "custom"` for both backends.
- **`debug-classify`** (main.ts): backend branch, `backend:` header with
  model@URL for the decision backend.
- **Tests**: `tests/decisions.test.ts` (config, body, parsing, HTTP
  degrade, custom names); merge semantics via shared path (exec-hook
  tests) + no-key fallback through `applyClassifier`.
- **Docs**: spec §16.1/§16.5/§9.3/§21 (M5.2), design D§6a.
- **Verification**: live vs `tmp/demo` (key in llm `defaults`), fixture-only
  test suite, `debug-classify` transcript.
