# Plan 011 — M7 LLM narratives + refined classification

Decisions settled at task start (§22.2, confirmed by user 2025-06):

1. **Providers**: default OpenAI-compatible chat completions **and** a native
   Anthropic (`/v1/messages`) adapter, selected via `provider` in config.
   Plus a **custom adapter**: `command` (exec, same spirit as the classifier
   hook — JSON on stdin, `{ "text": "…" }` on stdout).
2. **Blocking** requests for v1; streaming is deferred (future task, note in
   spec §22.2).

## What changes

- `src/types.ts` — `LlmTaskConfig` (provider/apiKey/model/baseUrl/command/
  timeoutMs), `LlmConfig` (defaults + tasks.{narrate,classify}), `LlmRequest`.
  No Session/Chapter changes (`narrative`, `narrativeEdited`, `markSource:
  "llm"` all exist).
- `src/llm.ts` — config resolution (defaults ← task override; missing
  model+command → undefined = task skipped, §16.1) and three adapters:
  - openai: POST `{baseUrl|https://api.openai.com/v1}/chat/completions`
  - anthropic: POST `{baseUrl|https://api.anthropic.com}/v1/messages`
  - custom: `sh -c command` (reuse the classifier's shRun pattern), stdin
    `{ protocol: 1, task, model, system, prompt }`, stdout `{ text }`.
  Adapter identity string (`provider:baseUrl:model` / `custom:command`) is
  what the shared-call check (§16.3) compares. fetch injected for tests.
- `src/narrate.ts` — prompt build (pure): chapter diff across **all** file
  slices (006 model), ~10 lines of new-side context per hunk (head file
  content passed in by the caller), file paths, other chapter titles.
  Orchestration `rerunChapter(root, kind, session, chapterId, confirm)`:
  - 409 `{ error: "narrative edited", needsConfirm: true }` when
    `narrativeEdited && !confirm` (§10);
  - no adapter → return session unchanged (rules-only world never blocks);
  - shared call when both tasks resolve to the same adapter id → one request
    expecting `{ narrative, marks: [{ file, side, line, mark }] }` (marks
    carry `file` — chapters span files since 006); otherwise two calls;
  - LLM marks overwrite only `markSource: "rules"` marks; malformed LLM
    output → discard the LLM part entirely, keep rules marks (degrade);
  - persistSession → session returned (writeSession bumps updatedAt/
    lastWriteAt).
- `src/routes.ts` — `POST /api/sessions/:id/rerun { chapterId, confirm? }`.
- `src/public/app.js` — after wiring a session, sequentially rerun every
  chapter whose narrative is still `"unanalyzed"` (lazy firing = session
  open, since chapters render expanded); textarea shows a analyzing state;
  on response update textarea + restamp marks for that chapter (marks are
  stamped at createFileDiff time, so a changed mark needs a diff rebuild);
  per-chapter re-run button in the chapter head (user-facing re-run);
  409 needsConfirm → confirm() → re-send with `confirm: true`.
- Docs: spec §16.1/§16.2/§16.3 + §22.2, design §6a — provider selection,
  custom adapter, blocking decision, `file` in shared-call marks.

## What could break

- Concurrent reruns vs. narrative edits: reruns fire sequentially on the
  frontend and each response refreshes `current` (incl. lastWriteAt), so the
  PATCH conflict token stays fresh. Server-side reruns don't take
  `lastWriteAt` (machine-owned mutation, no user edit to lose).
- Refresh/supersede rebuilds marks → LLM marks are lost there. Accepted by
  spec: marks are machine-owned and always rebuilt (§9.3); narratives
  survive by chapter-id match (already handled in remap.ts).
- Custom adapter failures must degrade (skip), never 500 a session route.

## Tests

- `tests/llm.test.ts` — config resolution (defaults/override/missing),
  openai + anthropic request/response shape via injected fetch, custom
  adapter exec via a node echo script, failure → throw (caller degrades).
- `tests/narrate.test.ts` — prompt build (all slices, context window, other
  titles), shared-call vs two-call, LLM-marks-over-rules-only merge, parse
  failure discards, 409 guard, no-config skip.
- `tests/integration.test.ts` — rerun route: no config → unchanged session;
  409 guard on edited narrative; confirm path persists.

## Verification

`npm run check && npm test`; manual: tmp/demo with a config pointing at a
local OpenAI-compatible server (or a stub adapter script) — open session,
narratives fill in, edit one, re-run asks.
