# Plan: Claude SDK LLM provider (`provider: "claude"`)

Add `@anthropic-ai/sdk` as a fourth LLM adapter so users can run sky-eye's
LLM tasks (narrate / classify / chunk) against their Claude accounts —
including **Claude subscription auth (Pro/Max OAuth tokens)**, which the
existing raw-`fetch` `anthropic` adapter can't do. It stays one option among
the existing providers; nothing about openai/anthropic/custom changes.

## Current state (what the code does today)

- `src/llm.ts` is the adapters-only module. `resolveTask(root, task)` loads
  `.sky-watch/config.json`, merges `defaults` + `tasks.<task>`, and picks an
  adapter: `cfg.command` → custom exec adapter, `cfg.provider === "anthropic"`
  → native `/v1/messages` via fetch, else OpenAI-compatible chat completions.
- `LlmTaskConfig` (src/types.ts:68): `provider?: "openai" | "anthropic"`,
  `apiKey`, `model`, `baseUrl`, `command`, `timeoutMs`.
- Adapters return `LlmAdapter { id, call(req) → Promise<string> }`; the `id`
  string doubles as the shared-call (spec §16.3) equality key. Callers
  (`narrate.ts`) catch adapter throws and degrade to rules-only — adapters
  may throw freely on failure.
- Existing adapters accept an injected `fetchImpl` (default `fetch`) for
  tests; `tests/llm.test.ts` stubs fetch and asserts on request shape and
  adapter ids.
- Spec §2 pins "server runtime dependencies stay zero" — this task breaks
  that rule deliberately, so the spec must be updated (AGENTS.md: specs are
  the source of truth).

## Approach

New provider value `"claude"` → `claudeSdkAdapter`, a thin wrapper around
`@anthropic-ai/sdk`'s `Anthropic` client. The SDK earns its dependency by
supplying what the raw-fetch `anthropic` adapter cannot: subscription
OAuth (`authToken`) support, automatic retry on 429/529 (overloaded), and
maintained request/error handling.

### Credential chain (the reason this adapter exists)

1. Config `apiKey` → `ANTHROPIC_API_KEY` env → SDK's own env fallback.
2. Config `authToken` (new optional key) → `ANTHROPIC_AUTH_TOKEN` env →
   `CLAUDE_CODE_OAUTH_TOKEN` env. This is the subscription path (Claude
   Pro/Max OAuth token, same token Claude Code uses).
3. If neither chain resolves anything → log one line and return `undefined`
   (task skipped, spec §16.1 rule: never blocks the session).

`apiKey` and `authToken` are mutually exclusive at the API level; if both
are set, `apiKey` wins (SDK behavior: explicit `apiKey` uses `x-api-key`).

### Provider naming

`"claude"` (not `"claude-sdk"` or `"anthropic-sdk"`): it names the account
being used, reads well in `config.json`, and the existing `"anthropic"`
value stays untouched (raw Messages API, gateway-friendly). Documented in
README as: `"anthropic"` = raw API key + Messages API; `"claude"` = the
official SDK, supports subscription/OAuth tokens and retries.

## Changes

### 0. Task bookkeeping (`.implementation/`, process.md lifecycle)

The process.md pause trigger "a new dependency … is needed" is satisfied by
this conversation: the user explicitly requested `@anthropic-ai/sdk`.

- This plan moves to `.implementation/plans/024-claude-sdk.md` (repo
  convention supersedes the tmp/plans location) once task 024 is started.
- New task file `.implementation/tasks/024-claude-sdk.md`:

```markdown
# 024 — Claude SDK LLM provider (subscriptions supported)

**Goal:** add `provider: "claude"` backed by `@anthropic-ai/sdk` so users
can run narrate/classify/chunk on their Claude accounts — including
subscription (Pro/Max) OAuth tokens via `authToken` → `ANTHROPIC_AUTH_TOKEN`
→ `CLAUDE_CODE_OAUTH_TOKEN`, alongside API keys. Fourth adapter; the
existing openai/anthropic/custom providers are untouched.

**Status:** pending
```

- `.implementation/tasks/000-index.md`: append to the list —

```markdown
- `024` Claude SDK LLM provider — `provider: "claude"` via
  `@anthropic-ai/sdk`; apiKey + subscription OAuth authToken chains
  (spec §2 dependency-policy amendment, §16.1, §22.2) — **pending**
```

- At task end: flip the task file's **Status** to done with the usual
  one-liner, mirror it in the index, and record learnings in
  `.implementation/learnings/config.md` (new provider value + authToken key)
  and `openrouter-decisions.md` only if the shared-call id rule changed
  (it doesn't — `claude:` prefix just participates).

### 1. `package.json` — dependency

```
npm install @anthropic-ai/sdk
```

Lands in `dependencies` (server runtime). This is the only runtime dep
besides the (already present, frontend-only) `@pierre/*` set.

### 2. `src/types.ts` — widen the provider union

```ts
// `command` switches to the custom exec adapter; otherwise `provider`
// picks openai (default), anthropic (raw Messages API), or claude
// (@anthropic-ai/sdk — subscription/OAuth auth supported).
export interface LlmTaskConfig {
  provider?: "openai" | "anthropic" | "claude";
  apiKey?: string;
  authToken?: string; // claude adapter: OAuth token (subscriptions); falls back to ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN
  model?: string;
  baseUrl?: string;
  command?: string;
  timeoutMs?: number;
}
```

### 3. `src/llm.ts` — new adapter + `resolveTask` branch

```ts
import Anthropic from "@anthropic-ai/sdk";

// @anthropic-ai/sdk adapter: API key or OAuth/subscription authToken.
// SDK supplies retries (2× on 429/529) and request formation; a missing
// credential chain skips the task rather than throwing (§16.1).
export function claudeSdkAdapter(cfg: LlmTaskConfig, fetchImpl = fetch): LlmAdapter {
  const apiKey = cfg.apiKey?.trim() || process.env.ANTHROPIC_API_KEY;
  const authToken =
    cfg.authToken?.trim() || process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!apiKey && !authToken) {
    console.error("sky-eye: claude provider configured but no apiKey/authToken found — task skipped");
    // handled by resolveTask via buildClaudeSdkAdapter below
  }
  const client = new Anthropic({
    ...(apiKey ? { apiKey } : {}),
    ...(authToken ? { authToken } : {}),
    ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
    timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: 2,
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
  });
  return {
    id: `claude:${cfg.baseUrl ?? "https://api.anthropic.com"}:${cfg.model}`,
    call: async (req: LlmRequest) => {
      const msg = await client.messages.create({
        model: req.model ?? cfg.model!,
        max_tokens: 1024, // parity with the anthropic fetch adapter
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
      });
      return msg.content.find((b) => b.type === "text")?.text ?? "";
    },
  };
}
```

Credential-missing must return `undefined` from `resolveTask` (not throw),
so the factory is split or the check hoisted — smallest shape:

```ts
export function claudeSdkAdapter(cfg: LlmTaskConfig, fetchImpl = fetch): LlmAdapter { /* as above, creds guaranteed */ }

// inside resolveTask:
if (cfg.provider === "claude") {
  const apiKey = cfg.apiKey?.trim() || process.env.ANTHROPIC_API_KEY;
  const authToken = cfg.authToken?.trim() || process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!apiKey && !authToken) {
    console.error("sky-eye: claude provider configured but no apiKey/authToken — task skipped");
    return undefined;
  }
  return claudeSdkAdapter(cfg, fetchImpl);
}
```

This means `resolveTask` needs an optional `fetchImpl` pass-through to keep
the adapter testable through `resolveTask` too. Keep the parameter last and
optional; existing call sites (`narrate.ts` ×2, `analyze.ts`) are untouched.

Notes:

- Adapter `id` is `claude:<baseUrl>:<model>` — participates in the §16.3
  shared-call check for free. A `claude` and an `anthropic` config with the
  same model will never merge into one shared call (ids differ by prefix) —
  correct, since they're different code paths.
- SDK errors (`APIError`) propagate out of `call`; `narrate.ts`'s `call()`
  wrapper already catches and degrades to rules-only. No caller changes.
- `max_tokens: 1024` is required by the Messages API and matches the
  existing `anthropic` adapter. `shortcut: not configurable, add a
  `maxTokens` config key if narratives ever truncate on long shared-call
  responses`.
- Retries: SDK default is 2. Anthropic 529 "overloaded" is common enough
  that one silent retry is worth the latency; narrate degrades on final
  failure either way.

### 4. `tests/llm.test.ts` — new tests

Follow the existing stub-fetch pattern:

1. `resolveTask` selects the claude adapter:
   `tasks.narrate = { provider: "claude", apiKey: "k", model: "claude-x" }`
   → `assert.match(id, /^claude:/)`.
2. No credentials → `undefined`: `provider: "claude"` with no `apiKey`,
   no `authToken`, and (unset in the test process) no `ANTHROPIC_API_KEY`
   env — use `node:test` `mock` or save/restore `process.env` around the
   assertion.
3. Request shape via stubbed fetch (inject through `resolveTask`'s new
   param or the adapter factory directly): assert
   - URL is `https://api.anthropic.com/v1/messages` (SDK default), or the
     SDK's stub-injection surface if it mints the URL internally — assert
     on the captured body instead: `model`, `max_tokens: 1024`,
     `system`, `messages[0].content === prompt`;
   - header `x-api-key: k` when `apiKey` given; `authorization: Bearer t`
     when `authToken` given (subscription path);
   - response `content: [{ type: "text", text: "hello" }]` → adapter
     resolves `"hello"`; a content block without text resolves `""`.
4. authToken env fallback: set `CLAUDE_CODE_OAUTH_TOKEN`, omit config keys →
   adapter builds (resolveTask returns non-undefined).
5. Error propagation: stub fetch returns 401 → `call` rejects (assert the
   rejection; narrate-level degrade is already covered by existing tests).

Reset any mutated `process.env` in each test (save/restore) — the SDK also
reads env at call time.

### 5. Docs — spec (binding) and README

- `docs/spec.md` §2 table: LLM access row — add "the `@anthropic-ai/sdk`
  client (`provider: "claude"`) for API-key and subscription/OAuth auth".
  Amend the dependency-policy paragraph: server runtime deps stay zero
  **except** `@anthropic-ai/sdk`, added deliberately for subscription auth
  (task: claude-sdk).
- `docs/spec.md` §16.1: config key list gains `authToken` (claude provider)
  and the provider value `"claude"`, with the credential chain.
- `docs/spec.md` §22.2 (resolved open question 2): amend the decision —
  four adapters ship, adding the SDK-backed `claude` provider.
- `README.md` config table (rows at ~line 86) + a second example block
  (next to the `provider: "anthropic"` example at ~line 124):

```jsonc
"defaults": { "provider": "claude", "model": "claude-sonnet-4-5" }
// credentials: "apiKey" (sk-ant-...) or "authToken" for Claude
// subscriptions (Pro/Max) — or env ANTHROPIC_API_KEY /
// ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN
```

No other docs (`docs/design.md`, `docs/ux.md` don't enumerate providers).

## Files touched

| File | Change |
|---|---|
| `.implementation/tasks/024-claude-sdk.md` | new task file (content above) |
| `.implementation/tasks/000-index.md` | append task 024 entry |
| `package.json` | add `@anthropic-ai/sdk` dependency |
| `src/types.ts` | `provider` union + `authToken` key + comment |
| `src/llm.ts` | `claudeSdkAdapter`, `resolveTask` branch + optional `fetchImpl` param |
| `tests/llm.test.ts` | 5 new tests (selection, skip, request shape, auth header, env fallback, error) |
| `docs/spec.md` | §2, §16.1, §22.2 amendments |
| `README.md` | config table row + example |

## Considerations / trade-offs

- **Why an SDK at all** when a 30-line fetch adapter already speaks
  Anthropic: subscriptions (OAuth tokens) and retry-on-overload are non-
  trivial to hand-roll correctly (token headers, backoff, error classes).
  The SDK is the official, maintained path; the wrapper stays ~30 lines.
- **Why a new provider value instead of extending `"anthropic"`**: the
  existing value is documented, tested, and gateway-friendly (works with
  any `baseUrl` mimicking `/v1/messages`). Switching its implementation
  would change its auth/retry behavior under existing users. Additive value
  = zero breakage, and the test suite pins both.
- **Why not the CLAUDE_CODE_* hack as the only path**: config keys keep the
  credential story explicit and testable; env vars remain the fallback for
  CI/users who prefer them.
- **Alternative rejected**: make the existing `anthropic` adapter accept
  `authToken` via plain fetch — saves the dependency but loses SDK retries,
  error typing, and future SDK features (prompt caching helpers, streaming);
  the user explicitly asked for the SDK.
- **Zero-dep spec rule**: knowingly broken; spec is updated in the same
  change rather than left contradicting reality (AGENTS.md rule 1).

## Dependencies / setup

- Per process.md, the dependency pause trigger is pre-cleared by the user's
  request; the task file (step 0) documents it.
- `npm install @anthropic-ai/sdk` (regular runtime dependency, pinned by
  lockfile; the server runs via node type-stripping — no build-step impact).
- No migration: existing config files without `provider: "claude"` behave
  exactly as before.
- Manual acceptance: a repo with `.sky-watch/config.json`
  `{"defaults": {"provider": "claude", "model": "claude-sonnet-4-5"}}` +
  `ANTHROPIC_API_KEY` (or a `CLAUDE_CODE_OAUTH_TOKEN` from a Pro/Max
  subscription) → session creation shows narratives + LLM marks; unset
  creds → chapters stay "unanalyzed", rules marks only.

## Todo

### Phase 0 — bookkeeping
- [x] Create `.implementation/tasks/024-claude-sdk.md` (Status: pending)
- [x] Append task 024 entry to `.implementation/tasks/000-index.md`

### Phase 1 — dependency
- [x] `npm install @anthropic-ai/sdk`

### Phase 2 — code
- [x] `src/types.ts`: widen `provider` union with `"claude"`, add `authToken` key + comment
- [x] `src/llm.ts`: add `claudeSdkAdapter`, `resolveTask` branch (cred chain, skip on none), optional `fetchImpl` param

### Phase 3 — tests
- [x] `tests/llm.test.ts`: adapter selection via resolveTask
- [x] `tests/llm.test.ts`: no credentials → undefined
- [x] `tests/llm.test.ts`: request shape + auth headers via stubbed fetch
- [x] `tests/llm.test.ts`: authToken env fallback
- [x] `tests/llm.test.ts`: 401 error propagates
- [x] `npm test` green + `npm run check` clean

### Phase 4 — docs
- [x] `docs/spec.md` §2 LLM-access row + dependency-policy amendment
- [x] `docs/spec.md` §16.1 provider value + authToken + credential chain
- [x] `docs/spec.md` §22.2 four-adapters amendment
- [x] `README.md` config table row + claude example

### Phase 5 — close-out
- [x] Flip task 024 status → done + index entry
- [x] Move plan to `.implementation/plans/024-claude-sdk.md`
- [x] Learning in `.implementation/learnings/config.md`
- [x] jj commit (conventional)

## Notes (implementation)

- `@anthropic-ai/sdk` 1.6.0 sends API keys as `authorization: Bearer <key>`
  and no longer uses `x-api-key` (also `anthropic-version: 2026-10-21`).
  Tests pin the actual headers instead of the plan's assumption; README and
  task-file notes updated accordingly. The apiKey-vs-authToken distinction
  is unchanged (key → Bearer <key>, token → Bearer <token>).
- SDK accepts an injected `fetch` — same test surface as the fetch adapters.
- esbuild's postinstall script was blocked by npm's install-scripts policy
  (warning only; esbuild binary already present, `npm run build` unaffected).
