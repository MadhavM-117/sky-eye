# Jev classifier backend

- OpenRouter decisions API (`POST https://openrouter.ai/api/alpha/decisions`):
  answers come back as `{ answers: { <qKey>: { type, choice, probabilities,
  confidence } } }` — the chosen criteria key is at `.choice`. `state` is a
  string list, `questions` an object keyed however you like (`q<N>` + side
  map avoids odd file names round-tripping through keys).
- Default base is `https://openrouter.ai/api` and the endpoint is appended,
  so the full path is `/api/alpha/decisions` — not `/alpha/decisions`.
- Built-in classifier shares the llm `defaults.apiKey` (resolution:
  `classifier.apiKey` → `OPENROUTER_API_KEY` env → llm defaults) — one
  OpenRouter key serves both the chapter analyser and the classifier.
