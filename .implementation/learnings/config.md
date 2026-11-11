# Config

- `.sky-eye/config.json` loaders are per-concern, not one shared loader:
  `chunker.loadConfig` (review sizes), `custom-classifier.loadClassifierConfig`
  (`classifier` key) and `loadClassifyRules` (`classifyRules` key). The
  classifier module owns its keys so the chunker stays about chunking — add
  new config keys next to the module that consumes them.
- `llm.loadLlmConfig`/`resolveTask` (task 011) follow the same per-concern
  pattern: `defaults` merged with `tasks.<name>`, model-or-command presence
  decides "configured". Adapter identity strings (`provider:url:model`,
  `custom:command`) double as the shared-call (§16.3) equality check.

- Adding an LLM task (task 019, `chunk`): the task union lives in **four**
  places — `LlmConfig.tasks`, `LlmRequest.task`, `llm.resolveTask` and
  `llm.resolveTaskConfig`. Widen all four. Task behavior itself belongs in a
  task module (`narrate.ts`, `semantic-chunk.ts`); `llm.ts` stays adapters-only.
- Adding an LLM provider (task 024, `claude`): widen `LlmTaskConfig.provider`
  + add an adapter factory taking an optional injected `fetch` (the SDK
  accepts one too) + a branch in `resolveTask`. Adapter `id` prefix must
  match the provider name so the shared-call check (§16.3) reads clearly.
  Gotcha: `@anthropic-ai/sdk` ≥1.6 sends API keys as `authorization: Bearer`,
  not `x-api-key`; auth headers only appear in the injected fetch's `init`.
- `resolveTask` must thread `fetchImpl` into *every* fetch adapter — it was
  silently dropped for openai/anthropic (first hit by task 026's
  `check-config`, which is the only caller that injects through
  `resolveTask`). Existing tests inject at the adapter factories directly.
- Provider replacement (task 027): `claude-code` shells out to `claude -p` —
  `--system-prompt` replaces CC's default prompt (right for one-shot, no
  session sync), `--output-format json` gives `{ result, is_error }`,
  `--no-session-persistence` stops transcript litter in `~/.claude/projects`.
  Failure = thrown `Error` with the CLI's own text → §16.1 degradation.
- Removing a provider (024's `claude`): delete it from the union, delete the
  key only it used (`authToken`), and add an explicit unknown-provider guard
  in `resolveTask` — the old code fell through to `openaiAdapter`, which would
  silently route stale configs to OpenAI. Same guard is what `check-config`
  reports as `fail`.
- Parent-session env strip for spawned `claude` children copied verbatim from
  pi-claude-bridge (`PARENT_SESSION_VARS` in its `cc-child.ts`) — two repos
  now own that list; update both together.
