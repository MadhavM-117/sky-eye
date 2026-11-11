# Plan: sky-eye → Claude subscriptions via the `claude` CLI — replaces the `claude` SDK provider

Integrate the auth method pi-claude-bridge uses so sky-eye's LLM tasks
(narrate / classify / chunk) can run on a Claude **subscription** without the
user ever copying an OAuth token. Research source:
`tmp/plans/pi-claude-bridge/research.md`.

This is a **replacement, not an addition**: the `provider: "claude"`
(`@anthropic-ai/sdk`) adapter from task 024 is removed along with its
supporting logic, the `authToken` config key, and the `@anthropic-ai/sdk`
dependency. Its subscription path (static `authToken` → expiring token, no
refresh) is exactly what this task fixes.

## What the bridge does, and what sky-eye actually needs

The bridge's core mechanism: **never touch auth** — spawn the real Claude Code
CLI and let it read the user's `claude auth login` credentials, refresh OAuth
tokens, and absorb rate limits. Everything else in the bridge (session-file
sync, history digests, rate-limit-header re-encoding) exists because pi keeps a
live multi-turn conversation synced to a Claude Code session. Sky-eye's LLM
calls are **one-shot**: one system prompt + one user prompt → one text reply
(`LlmAdapter.call`), no conversation state. That deletes ~80% of the bridge's
complexity: no session sync, no resume, no fork logic.

What survives, and is worth copying:

1. Auth delegation — the `claude` CLI owns credentials + refresh + 429s.
2. Environment shaping — strip Claude Code parent-session markers (`ccChildEnv`,
   `src/cc-child.ts`) so a sky-eye process launched from inside a Claude Code
   session doesn't leak that session's identity into the child.
3. Failure surfaced as thrown `Error` → sky-eye's existing §16.1 degradation
   (task skipped / rules-only marks) handles the rest.

## Approach

Replace the `claude` provider with **`provider: "claude-code"`** → new
`claudeCodeAdapter` in `src/llm.ts` that shells out to `claude -p` (print
mode) per call:

```
claude -p "<prompt>" \
  --system-prompt "<system>" \
  --model "<model id>" \
  --output-format json \
  --tools ""
```

- `-p` = one-shot print mode: fresh process, no interactive session, exit when done.
- `--system-prompt` **replaces** Claude Code's default system prompt — correct
  here (sky-eye owns the persona) and unlike the bridge, which must preserve
  CC's prompt for cache/session reasons.
- `--output-format json` emits one JSON object: `{ result, is_error, subtype,
  ... }`. `is_error: true` → `throw new Error(result)`; non-zero exit / bad
  JSON → throw with a stderr tail.
- **Zero npm dependencies.** Removes the spec §2 dependency-policy exception
  (`@anthropic-ai/sdk`) rather than adding to it: `claude-code` shells out
  with the same `spawn` machinery the custom adapter already uses.

The user contract becomes: "have `claude` installed and run `claude auth login`
once" — no tokens in env or config, no expiry, refresh handled by the CLI.

### Alternatives considered (and why rejected)

- **Agent SDK (`@anthropic-ai/claude-agent-sdk`)** — the bridge's exact
  mechanism. Rejected: it adds a heavy runtime dep and spawns the same CLI
  anyway; its benefits (typed message stream, mid-turn steering, session
  resume) are all multi-turn features sky-eye doesn't have. Would also break
  the spec §2 zero-runtime-dep policy again.
- **Parse `~/.claude/.credentials.json` and refresh OAuth ourselves** — the
  bridge deliberately avoids this; it re-implements Claude Code's refresh
  logic and breaks whenever CC changes token storage. Rejected.
- **Status quo (`provider: "claude"` with `authToken`/env)** — this is what
  gets **removed**, not kept: the OAuth token expires (CC rotates it), so the
  user must re-copy it — broken UX for exactly the subscription case. Its
  other use, API-key auth against the Messages API, is already covered by
  `provider: "anthropic"` (raw fetch, gateway-friendly).
- **Keep both providers** — rejected: two overlapping Claude paths confuse
  config (`claude` = token you must copy, `claude-code` = your logged-in CLI)
  and the SDK dep exists solely for the one being removed.

## Changes

### 1. `src/types.ts` — provider union, drop `authToken`, add CLI path

```ts
export interface LlmTaskConfig {
  provider?: "openai" | "anthropic" | "claude-code"; // "claude" removed
  apiKey?: string;
  claudePath?: string; // claude-code adapter: absolute path to the claude binary (default: "claude" on PATH)
  model?: string;
  baseUrl?: string;
  command?: string;
  timeoutMs?: number; // default 120_000 (narration can be slow on local models)
}
```

- `"claude"` is deleted from the union and the `authToken` key with it (its
  only consumer was the SDK adapter). No deprecation shim: unknown values hit
  the new unknown-provider guard (§2 below) so stale configs fail loudly.
- `claudePath` earns its keep for the same reason the bridge has
  `pathToClaudeCodeExecutable` (Nix/PATH quirks) — one optional key, one line
  of use.

### 2. `src/llm.ts` — remove the SDK adapter, add the CLI adapter

**Removals** (task 024's surface, all of it):

- `import Anthropic from "@anthropic-ai/sdk";` (top of file).
- The whole `claudeSdkAdapter` function (llm.ts ~90–118).
- The `cfg.provider === "claude"` branch in `resolveTask`, including the
  "claude provider configured but no apiKey/authToken — task skipped"
  console.error and its credential-chain logic.
- `@anthropic-ai/sdk` from `package.json` dependencies
  (`npm uninstall @anthropic-ai/sdk`) — after this removal the adapter tests
  that import the SDK behavior are gone too, so nothing references it.

**New adapter** (in the file's existing style — `shRun`-shaped spawn,
promise-shaped result):

Parent-session env strip (copied verbatim from the bridge's
`PARENT_SESSION_VARS` list in `tmp/pi-claude-bridge/src/cc-child.ts`; keeps the
comment pointing there so both lists get updated together):

```ts
// Claude Code stamps these on its own children (or exports them from a parent
// CC session). When sky-eye runs inside Claude Code, a spawned `claude` would
// otherwise inherit that session's identity — the same fix as pi-claude-bridge's
// ccChildEnv; update both lists together.
const CLAUDE_PARENT_SESSION_VARS = [
  "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID", "CLAUDE_EFFORT", "TRACEPARENT", "CLAUDE_CODE_INVOKED_SKILLS", "CLAUDE_ENV_FILE",
  "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
];
```

The adapter, in the file's existing style (spawn + promise-shaped result, like
`customAdapter`'s `shRun`):

```ts
// `claude -p` adapter: auth fully delegated to the Claude Code CLI
// (`claude auth login` credentials — subscriptions included). The CLI owns
// OAuth refresh and API retries/rate limits; sky-eye sees only the final
// result. One-shot by design: no session files read or written by sky-eye.
export function claudeCodeAdapter(cfg: LlmTaskConfig, cwd: string): LlmAdapter {
  const bin = cfg.claudePath?.trim() || "claude";
  return {
    id: `claude-code:${cfg.model}`, // shared-call key (§16.3): same model → one shared call
    call: async (req: LlmRequest) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (env.CLAUDECODE) for (const name of CLAUDE_PARENT_SESSION_VARS) delete env[name];
      const args = [
        "-p", req.prompt,
        "--system-prompt", req.system, // replaces CC's default prompt — sky-eye owns the persona
        "--model", req.model ?? cfg.model!,
        "--output-format", "json",
        // shortcut: verify against the installed CLI (`claude -p --help`); if the
        // --tools flag is unavailable, drop this arg — print mode denies tools by
        // default (no --permission-mode), the model just wastes a turn trying
        "--tools", "",
      ];
      const res = await shRun(bin, args, cwd, cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS, env);
      const detail = res.stderr.split("\n").filter(Boolean).slice(-3).join("; ");
      let parsed: { result?: unknown; is_error?: boolean } | undefined;
      try { parsed = JSON.parse(res.stdout); } catch { /* fall through to exit-code error */ }
      if (parsed?.is_error || (parsed === undefined && res.code !== 0)) {
        throw new Error(`claude-code: ${typeof parsed?.result === "string" ? parsed.result : `exit ${res.code} ${detail}`}`);
      }
      if (typeof parsed?.result !== "string") throw new Error(`claude-code: unusable output${detail ? ` — ${detail}` : ""}`);
      return parsed.result;
    },
  };
}
```

`shRun` needs a small generalization — it currently hardcodes `["-c", command]`
and `process.env`. Pass the argv array and env through (or add a sibling
`spawnRun(bin, args, …)`; prefer generalizing `shRun`'s body into one helper —
same timeout/stderr-capture semantics, callers unchanged).

Selection in `resolveTask` — the `claude` branch is deleted, the `claude-code`
branch added, and the openai fallthrough tightened into an explicit guard so
a stale `"claude"` config fails loudly instead of silently becoming an
OpenAI request with an OAuth-shaped token as its API key:

```ts
if (cfg.command) return customAdapter(cfg, root);
if (cfg.provider === "anthropic") return anthropicAdapter(cfg, fetchImpl);
if (cfg.provider === "claude-code") return claudeCodeAdapter(cfg, root);
if (!cfg.provider || cfg.provider === "openai") return openaiAdapter(cfg, fetchImpl);
// Unknown (or removed — e.g. task 024's "claude") provider: skip the task,
// never silently route it to another adapter (§16.1).
console.error(`sky-eye: unknown provider "${cfg.provider}" — task skipped`);
return undefined;
```

Note: no credential guard is needed for `claude-code` (there is no credential
to check — the CLI must merely be installed and logged in), and
`resolveTaskConfig` already returns `undefined` without a `model`.

### 3. `src/check-config.ts` — delete the now-unreachable fail branch

With the `claude` provider gone, `resolveTask` returns `undefined` only when
the provider is unknown — and `resolveTaskConfig` still resolves those configs
fine. The `if (!adapter)` block (llm fail path with its "only reachable path:
claude provider without any credential" comment) becomes dead code: **delete
it**. An unknown provider then surfaces through the live ping instead — the
adapter is `undefined`… actually the ping uses `resolveTask` too, so guard
`if (!adapter)` with a simpler replacement:

```ts
if (!adapter) {
  // only reachable path: an unknown provider value (e.g. configs left on
  // task 024's removed "claude") — resolveTask already console.error'd the reason
  results.push({ name: task, status: "fail", detail: `unresolved adapter — ${cfg.provider ? `unknown provider "${cfg.provider}"` : "no model"}` });
  continue;
}
```

A missing `claude` binary surfaces naturally in the ping as `status: "fail"`
with the spawn error (exit 127 / not-found). Update
`tests/check-config.test.ts` for the changed detail text.

### 4. Tests — `tests/llm.test.ts`

**Removals:** the SDK adapter tests (the `claudeSdkAdapter` import, the
header/credential-chain assertions around tests/llm.test.ts:164, and any
`authToken` fixtures).

**Additions** — the spawn boundary makes this a fake-binary test rather than
a `fetchImpl` stub:

```ts
test("claude-code adapter: parses json result, throws on is_error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sky-eye-claude-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!/bin/sh\nwhile [ $# -gt 1 ]; do shift; done\nshift # drop flag\n cat > /dev/null\necho '{"result":"hello from claude","is_error":false}'\n`);
  fs.chmodSync(bin, 0o755);
  const cfg: LlmTaskConfig = { provider: "claude-code", model: "claude-haiku-4-5", claudePath: bin };
  const adapter = claudeCodeAdapter(cfg, dir);
  assert.equal(await adapter.call({ task: "narrate", system: "s", prompt: "p" }), "hello from claude");
});
```

Plus a second fake emitting `{"is_error":true,"result":"You've hit your usage limit…"}` and asserting the throw text. And `resolveTask` tests:

```ts
test("resolveTask: claude-code provider selects the cli adapter", () => {
  const cfg = { defaults: {}, tasks: { narrate: { provider: "claude-code", model: "claude-haiku-4-5" } } };
  const adapter = withResolveTask(cfg, "narrate");
  assert.equal(adapter!.id, "claude-code:claude-haiku-4-5");
});

test("resolveTask: removed 'claude' provider is unknown — task skipped, not silently openai", () => {
  const cfg = { defaults: {}, tasks: { narrate: { provider: "claude", model: "claude-haiku-4-5", apiKey: "x" } } };
  assert.equal(withResolveTask(cfg, "narrate"), undefined);
});
```

(match whatever helpers the file already uses — the old claude-selection test
at tests/llm.test.ts:164 is the template, retargeted.)

### 5. Docs + spec + task bookkeeping

- `README.md`:
  - Provider table: **replace** the `claude` row and delete the `authToken`
    row; add a `claude-code` row — "runs each task through the `claude` CLI in
    print mode; uses your Claude subscription via `claude auth login` (no
    tokens in config); requires the `claude` binary on PATH (or `claudePath`)".
  - Replace the §`claude` provider section (~README.md:139–146) with the
    `claude-code` section, including a migration note: `provider: "claude"`
    configs are no longer valid — use `claude-code` (subscription) or
    `anthropic` (API key / gateway).
  - Remove `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` mentions tied to
    the removed chain (`ANTHROPIC_API_KEY` stays relevant for `anthropic`).
- `docs/config.sample.jsonc`: change `"provider": "claude"` →
  `"provider": "claude-code"` and rewrite the credentials comment (no
  `authToken`, no token env vars — "run `claude auth login` once").
- `docs/spec.md`:
  - §2 LLM-access row: replace the `@anthropic-ai/sdk` clause with "… plus a
    `claude-code` provider that shells out to the `claude` CLI (subscription
    auth delegated to Claude Code — task 027, supersedes task 024)".
  - §2 dependency policy: **remove the `@anthropic-ai/sdk` exception** —
    server runtime dependencies are zero again; note the amendment history
    (024 added it, 027 removed it along with the provider it served).
  - §16.1: replace the `authToken`/credential-chain sentence with the
    `claude-code` rule (no credentials — requires a logged-in CLI; unknown
    provider values skip the task with an error).
  - §22.2 protocol confirmation: replace the task-024 amendment with the
    task-027 line (fifth mechanism: `claude -p` exec; fourth removed).
- Task bookkeeping per process.md:
  - New `.implementation/tasks/027-claude-code-provider.md` — goal covers
    both halves: add `claude-code`, **remove `claude` + `@anthropic-ai/sdk`**
    (breaking change, superseding task 024). Index entry in `000-index.md`.
  - Add one line to `.implementation/tasks/024-claude-sdk.md`'s Status:
    "**superseded by 027** — provider removed; use `claude-code`" (do not
    rewrite the task body — it records what was done).
  - **This plan moves to `.implementation/plans/027-claude-code-provider.md`**
    when the task starts (repo convention, like task 024 did).
  - After implementation: learnings → `.implementation/learnings/config.md`
    (provider replacement, removal of a deliberate dependency exception; the
    parent-session env list duplication risk).

## Considerations and trade-offs

- **Per-call process startup (~0.5–2s).** Narrate makes one call per chapter;
  a 10-chapter review pays ~10–20s of CLI startup across the build. Accepted:
  the alternative (SDK) has identical startup cost (it spawns the same CLI),
  and long-running server-side sessions would need the full bridge session
  sync — the complexity this task deliberately avoids.
- **Transcript litter.** `claude -p` saves transcripts under
  `~/.claude/projects/` by default. Verify at implementation whether the
  installed CLI has a no-save flag (`claude -p --help`); if it does, pass it;
  if not, accept the litter (cosmetic) with a shortcut comment rather than
  adding flag-detection logic.
- **Flag drift.** `--tools`, `--system-prompt`, `--output-format json` are
  current-CLI behavior; the bridge shows CC updates can change them. The
  adapter degrades safely: an unknown flag makes the CLI exit non-zero → the
  call throws → §16.1 degradation. Error text includes stderr so the failure
  is diagnosable in `check-config` output.
- **Rate limits need no code.** The CLI handles 429/overloaded retries
  internally; an exhausted subscription surfaces as `is_error: true` with
  "You've hit your usage limit…" → thrown → narrate degrades to rules-only,
  `check-config` reports the exact text. No bridge-style header re-encoding —
  nothing in sky-eye consumes rate-limit headers.
- **Why replace instead of extend:** the two providers have different
  requirements (static token vs. logged-in CLI) and failure surfaces; keeping
  both keeps `@anthropic-ai/sdk` alive solely to serve a worse version of the
  same thing. A separate value also makes config self-documenting.
- **Breaking change.** `provider: "claude"` configs and `authToken` keys stop
  working. The unknown-provider guard turns that into a loud, named failure
  (console.error + `check-config` fail), never a silent mis-route. README and
  config.sample carry the migration note. Task 024's file is marked
  superseded, not rewritten — history stays readable.

## Dependencies

**`npm uninstall @anthropic-ai/sdk`** — with `claudeSdkAdapter` gone, nothing
imports it; server runtime dependencies return to zero (spec §2 policy
restored). Requires on the user's machine: `claude` CLI installed and logged
in (`claude auth login`) for subscription use — documented, not installed.

## Verification steps (implementation-time, one-off)

1. `claude -p --help` — confirm `--tools`, `--system-prompt`,
   `--output-format json` spellings and look for a no-save flag.
2. Manual smoke: config `{"defaults": {"provider": "claude-code",
   "model": "claude-haiku-4-5"}}`, run `sky-eye check-config` — expect
   narrate/classify/chunk `ok` via one shared ping.
3. Config left on the removed `"claude"` provider → `check-config` reports
   `fail` with "unknown provider", not a silent OpenAI route.
4. Kill network / use an exhausted account once to see the `is_error` path
   degrade instead of crash.

## Todo

**Verification (pre-implementation)**

- [x] Confirm CLI flags: `--tools`, `--system-prompt`, `--output-format json` all present; `--no-session-persistence` exists → add it (no transcript litter)

**Code**

- [x] `src/types.ts`: provider union `"openai" | "anthropic" | "claude-code"`, remove `authToken`, add `claudePath`
- [x] `src/llm.ts`: remove `Anthropic` import, `claudeSdkAdapter`, `"claude"` branch
- [x] `src/llm.ts`: generalize `shRun` (argv array + env), add `claudeCodeAdapter` + `CLAUDE_PARENT_SESSION_VARS`
- [x] `src/llm.ts`: `resolveTask` — claude-code branch + unknown-provider guard
- [x] `npm uninstall @anthropic-ai/sdk`
- [x] `src/check-config.ts`: replace the dead fail branch with the unknown-provider message

**Tests**

- [x] `tests/llm.test.ts`: remove SDK adapter tests (`claudeSdkAdapter` import, credential-chain tests, `sdkStub`)
- [x] `tests/llm.test.ts`: add fake-binary claude-code tests (happy path, `is_error`, resolveTask selection, removed-`claude` guard)
- [x] `tests/check-config.test.ts`: replace "claude without credentials" test with unknown-provider fail test

**Docs + spec + bookkeeping**

- [x] `README.md`: provider table rows, replace `claude` section with `claude-code` + migration note, drop token env mentions
- [x] `docs/config.sample.jsonc`: `"provider": "claude-code"`, credentials comment rewrite
- [x] `docs/spec.md`: §2 LLM row, §2 dependency policy, §16.1, check-config sentence (~614), §22.2 (~1009)
- [x] `.implementation/tasks/027-claude-code-provider.md` + index entry in `000-index.md`
- [x] `.implementation/tasks/024-claude-sdk.md`: append "superseded by 027" status line
- [x] Move this plan → `.implementation/plans/027-claude-code-provider.md`
- [x] Learnings → `.implementation/learnings/config.md`

**Final**

- [x] `npm run check` + `npm test` green
- [x] jj: describe working copy (conventional commit), start new change
