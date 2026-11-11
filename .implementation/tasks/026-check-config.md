# 026 — `sky-eye check-config`

**Goal:** a quick CLI probe so users can verify every configured part of
`.sky-eye/config.json` actually works: each configured LLM task
(narrate/classify/chunk) resolves through the runtime path and answers a
tiny ping (shared adapters pinged once, §16.3), the classifier backend
(exec hook or built-in decision API) runs against a synthetic one-line
request, and the static keys (`classifyRules`, `review`) are reported as
parsed. Missing parts report as *skipped* (matching runtime behavior);
configured-but-failing parts exit non-zero. Read-only — no sessions, no
classifier logs.

**Status:** **done** — `sky-eye check-config` (`src/check-config.ts`,
argv branch in `main.ts` next to `debug-classify`): LLM task pings via
`resolveTask` (shared adapters pinged once, §16.3; `resolveTaskConfig`
now exported for the configured-but-no-credentials diagnostic), classifier
backend against a synthetic one-added-line request, `classifyRules` /
`review` reported as parsed. Read-only; exit 1 on any configured failure.
Root-cause fix en route: `resolveTask` now threads `fetchImpl` into the
openai and anthropic adapters too. Spec §16.1 + README updated; 5 new
tests in `tests/check-config.test.ts`, full suite 183 pass.
