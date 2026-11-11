# 024 — Claude SDK LLM provider (subscriptions supported)

**Goal:** add `provider: "claude"` backed by `@anthropic-ai/sdk` so users
can run narrate/classify/chunk on their Claude accounts — including
subscription (Pro/Max) OAuth tokens via `authToken` → `ANTHROPIC_AUTH_TOKEN`
→ `CLAUDE_CODE_OAUTH_TOKEN`, alongside API keys. Fourth adapter; the
existing openai/anthropic/custom providers are untouched.

**Status:** **done** — `provider: "claude"` → `claudeSdkAdapter`
(`@anthropic-ai/sdk` 1.6.0): credentials `apiKey` → `ANTHROPIC_API_KEY`,
then `authToken` → `ANTHROPIC_AUTH_TOKEN` → `CLAUDE_CODE_OAUTH_TOKEN`
(subscription path); no credential → task skipped (§16.1). SDK sends API
keys as `authorization: Bearer` (no `x-api-key` since 1.6) — tests pin
actual header behavior. Spec §2 (dependency policy exception), §16.1,
§22.2 and README updated.

**Superseded by 027** — provider removed; use `claude-code`.
