# Decision-model APIs (built-in classifier backends)

- The decisions endpoint is OpenRouter's, not the model's: `POST
  https://openrouter.ai/api/alpha/decisions`. jev (`typesafe/jev-1.14`) is
  just a model served by it — name the backend after the API
  (`builtin: "openrouter"`, `src/decisions.ts`), pick models via `model`.
- Response envelope: `{ answers: { <qKey>: { type, choice, probabilities,
  confidence } } }` — the chosen criteria key is at `.choice`. `state` is a
  string list, `questions` an object keyed however you like (`q<N>` + side
  map avoids odd file names round-tripping through keys).
- Default base is `https://openrouter.ai/api` and the endpoint is appended,
  so the full path is `/api/alpha/decisions` — not `/alpha/decisions`.
- Built-in classifier shares the llm `defaults.apiKey` (resolution:
  `classifier.apiKey` → `OPENROUTER_API_KEY` env → llm defaults) — one
  OpenRouter key serves both the chapter analyser and the classifier.
- Tests must `delete process.env.OPENROUTER_API_KEY` at file top: a real shell
  key silently flips key-resolution precedence and makes "no key" test paths
  fire real network calls.
- `node --test <dir>` (Node 24) fails with MODULE_NOT_FOUND even for plain
  `.test.js` dirs — pass a glob instead: `node --test "tests/**/*.test.ts"`.
- OpenAI Decisions API (task 025): `POST https://api.openai.com/v1/decisions`
  (Bearer auth), model `gpt-6-luna` only. Envelope differs from OpenRouter's:
  `input` = shared evidence text, `questions` = an ARRAY of
  `{type, name, instructions, choices: [{value, description}]}`; answers come
  back as an array keyed by `name` (with a `refusal` type) —
  `parseDecisionsResponse` normalizes array→object by name, one lookup path.
- Vendor dispatch lives in `decisionsUrl`/`decisionsRequestBody`/`resolveApiKey`
  on `cfg.builtin` — call sites (applyClassifier, debug-classify) stay vendor-blind.
- jj describe: a message body line starting with `- ` is parsed as a flag —
  pass the whole message via `-m "$(cat file)"`.
