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
