# Plan — 026 check-config

## What changes

- **`src/check-config.ts`** (new): `checkConfig(root, kind, fetchImpl?)` →
  `CheckResult[]` (`{ name, status: ok|fail|skip, detail }`).
  - LLM tasks via the runtime's own `resolveTask` — what resolves here is
    what a session build would use. Ping = `adapter.call` with a
    "reply OK" one-shot. Shared adapters (equal id, §16.3) ping once;
    later tasks report "shared with <task>" and inherit the ping result.
  - `resolveTaskConfig` exported from `llm.ts` so a configured task whose
    adapter can't resolve (only the claude-no-credentials path) is
    reported as **fail** with the env-var pointers, instead of a
    misleading "not configured".
  - Classifier via `loadClassifierConfig` → exec hook (`spawnClassifier`)
    or built-in (`decisionsClassify`) against a synthetic one-added-line
    request (protocol shape matches `classifierRequest` output). Neither
    writes logs — `writeLog` only runs inside `applyClassifier`.
  - Static keys: `classifyRules` (globs counts / "defaults"), `review`
    (chunker `loadConfig` values).
- **`src/llm.ts`**: `resolveTaskConfig` gets `export` (only change).
- **`src/main.ts`**: `check-config` argv branch next to `debug-classify`
  (before ignore-file upkeep — read-only), prints aligned lines, exit 1
  when any configured part failed.

## Could break

- Nothing existing: additive module + one export keyword + one argv
  branch. `resolveTask`/`resolveTaskConfig` semantics untouched.
- Env-var test mutating `ANTHROPIC_API_KEY` etc. → save/restore around
  the assertion.

## Testing (§20)

`tests/check-config.test.ts` — temp-dir config fixtures (same
`withConfig` pattern as custom-classifier.test.ts):
1. no config file → all tasks/classifier skip, static defaults reported;
2. openai provider with injected fetch → narrate ok, classify shares the
   adapter, fetch hit exactly once (pinged once), review/classifyRules
   overrides reported;
3. claude provider, credentials scrubbed from env → fail with credential
   hint;
4. classifier exec hook `echo '{"marks":[]}'` → ok (real spawn — the
   integration boundary).

## Docs

spec §16.1 gets one paragraph; README a short "Checking your config"
subsection.
