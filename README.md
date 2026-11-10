# sky-eye

A local code review helper: turns a git/jj branch diff into a chaptered,
PR-style review — two-column diff split into readable ~50–100-line chapters
with narrative overviews, per-line attention marks, and content-anchored
comments that survive rebases. Runs entirely on your machine; no GitHub/GitLab
API, no auth, no server deployment.

## Install (local, no npm publish)

Requirements: **Node ≥ 22.6** and **git** (and/or **jj**) on PATH.

From a clone of this repo (anywhere on the target machine):

```sh
git clone git@github.com:MadhavM-117/sky-eye.git
cd sky-eye
npm run build        # bundles the frontend into src/public/dist
npm install -g .     # installs the `sky-eye` binary globally
```

Or straight from the remote in one step (npm packs it the same way — run
`npm run build` inside a clone first, or `dist/` won't be included):

```sh
npm install -g git+ssh://git@github.com/MadhavM-117/sky-eye.git
```

Updating: `git pull && npm run build && npm install -g .`

## Usage

```sh
cd your-project        # any git or jj repo
sky-eye                # detects the repo, starts the server, opens the browser
```

Not inside a repo → sky-eye exits with an error and no browser is opened.
All state lives in `.sky-eye/` inside the reviewed repo (session JSON,
config, logs) — never in the sky-eye install.

## Configuration

All config lives in `<repo>/.sky-eye/config.json` (inside the ignored
folder — keys never land in git/jj). Missing file or missing keys never
block anything: LLM-powered features are simply skipped and you get the
purely local experience (rule-based marks, "unanalyzed" chapters).

```jsonc
{
  // LLM tasks: `defaults` + per-task overrides (later keys win).
  "defaults": { "provider": "openai", "apiKey": "...", "model": "...", "baseUrl": "..." },
  "tasks": {
    "narrate":  { "model": "..." },   // chapter narratives + LLM attention marks
    "classify": { "model": "..." },   // per-line attention marks (LLM pass)
    "chunk":    { "model": "..." }    // semantic chapter grouping
  },

  // Second, separate classifier pass (built-in backends or exec hook).
  "classifier": {
    "builtin": "openrouter",          // OpenRouter decision-model API
    "model": "typesafe/jev-1.14",
    "apiKey": "...",                  // or env OPENROUTER_API_KEY, or llm defaults.apiKey
    "baseUrl": "https://openrouter.ai/api",
    "instructions": "...",            // per-line question override
    "criteria": { "risk": "..." },    // mark NAME → criteria description
    "timeoutMs": 30000,
    "fallback": true,                 // rules marks survive a failed run
    "debug": false                    // full request/response into classifier.log
  },

  // Extend the built-in rule-pass buckets (globs).
  "classifyRules": { "safePaths": [], "focusPaths": [] },

  // Chapter sizing.
  "review": { "targetLines": 75, "maxLines": 200 }
}
```

### LLM task options

Per task (`defaults` merged with `tasks.<name>`):

| Option      | Meaning                                                          | Default                     |
| ----------- | ---------------------------------------------------------------- | --------------------------- |
| `provider`  | `openai` (OpenAI-compatible), `anthropic` (native Messages API), or `claude` (official `@anthropic-ai/sdk` — supports Claude subscription OAuth tokens and automatic retries) | `openai`                    |
| `apiKey`    | API key sent with the request                                    | —                           |
| `authToken` | `claude` only: OAuth token for Claude subscriptions (Pro/Max); falls back to env `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` | —                           |
| `model`     | Model name. **A task with no `model` is skipped.**               | —                           |
| `baseUrl`   | API base URL                                                     | `https://api.openai.com/v1` (openai) / `https://api.anthropic.com` (anthropic) |
| `command`   | Custom exec adapter instead of an API: shell command, request JSON on stdin, expects `{ "text": "..." }` on stdout. Wins over `provider`. | —      |
| `timeoutMs` | Per-call timeout                                                 | `120000`                    |

When `narrate` and `classify` resolve to the same adapter (same provider +
baseUrl + model after merging), they share one request; otherwise two calls.

### OpenRouter (OpenAI-compatible)

OpenRouter speaks the OpenAI chat-completions protocol, so it needs only
`baseUrl` + `model` + `apiKey`:

```jsonc
{
  "defaults": {
    "provider": "openai",
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKey": "sk-or-...",
    "model": "anthropic/claude-sonnet-4.5"
  }
}
```

Tip: put the key and baseUrl in `defaults` and pick models per task — e.g.
a fast model for `narrate`/`classify`, and `chunk` on the same model. If the
key is unset here, the classifier pass also falls back to the
`OPENROUTER_API_KEY` environment variable.

### Anthropic (native API)

Uses Anthropic's native `/v1/messages` endpoint:

```jsonc
{
  "defaults": {
    "provider": "anthropic",
    "apiKey": "sk-ant-...",
    "model": "claude-sonnet-4-5"
  }
}
```

No `baseUrl` needed for the public API; set it only for a proxy/gateway.

### Claude (SDK — subscriptions supported)

The `claude` provider uses the official `@anthropic-ai/sdk` client, so a
Claude **subscription** (Pro/Max) works too, not just API keys:

```jsonc
{
  "defaults": {
    "provider": "claude",
    "model": "claude-sonnet-4-5"
  }
}
```

Credentials resolve in order: config `apiKey` → env `ANTHROPIC_API_KEY`,
then config `authToken` → env `ANTHROPIC_AUTH_TOKEN` →
`CLAUDE_CODE_OAUTH_TOKEN` (the same OAuth token Claude Code uses for
subscription auth). With no credential the task is skipped, like any other
unconfigured task. API-key auth and subscription auth are mutually
exclusive; a key wins if both are set.

### Built-in classifier via OpenRouter's decision API

Separate from the LLM task above — a lightweight per-line decision-model pass:

```jsonc
{
  "classifier": {
    "builtin": "openrouter",
    "model": "typesafe/jev-1.14",
    "apiKey": "sk-or-..."        // or OPENROUTER_API_KEY env, or defaults.apiKey
  }
}
```

Everything else (`instructions`, `criteria`, `timeoutMs`, `fallback`,
`debug`) is optional — see the schema above.

### What each LLM feature does

- **narrate** — a short narrative paragraph per chapter, generated eagerly
  when a session is built. Without it, chapters show as "unanalyzed".
- **classify (LLM)** — per-line attention marks beyond the rule pass.
  Without it you still get rule-based marks (test files, lockfiles, security
  keywords, etc.).
- **chunk** — semantic chapter grouping instead of the size-based heuristic.
- **classifier** — a second per-line pass that can override rule marks
  (never narrative/LLM marks).

## Development

```sh
npm install
npm run build   # esbuild → src/public/dist
npm run check   # tsc --noEmit
npm test        # node --test tests/
```

Server code runs via Node's native type stripping (`node src/main.ts`) —
no build step for the server itself.
