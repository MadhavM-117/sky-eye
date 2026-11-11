# 027 — Claude subscriptions via the `claude` CLI (replaces the `claude` SDK provider)

**Goal:** let narrate/classify/chunk run on a Claude subscription with no
tokens in config or env — the auth method pi-claude-bridge uses: shell out to
the `claude` CLI in print mode (`claude -p`, `--system-prompt`,
`--output-format json`, `--tools ""`, `--no-session-persistence`) and let it
own credentials, OAuth refresh and rate limits. **Breaking change:** task
024's `provider: "claude"` (`@anthropic-ai/sdk`) and its `authToken` key are
removed; unknown provider values fail loudly instead of silently routing to
OpenAI. `@anthropic-ai/sdk` leaves the dependency list — server runtime
dependencies are zero again (spec §2).

**Status:** **done** — `provider: "claude-code"` → `claudeCodeAdapter`
(`src/llm.ts`): one-shot spawn per call, parent-session env strip (copied from
pi-claude-bridge's `PARENT_SESSION_VARS`, lists must be updated together),
`is_error` results thrown so §16.1 degradation applies. Removed:
`claudeSdkAdapter`, the `"claude"` provider value, `authToken`,
`@anthropic-ai/sdk`. `resolveTask` gained an unknown-provider guard;
`check-config` reports unknown providers as failed. Tests use fake
`claude` binaries (spawn boundary, no fetch stub). Spec §2/§16.1/§22.2,
README, config.sample.jsonc updated; task 024 marked superseded.
