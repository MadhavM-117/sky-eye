# Plan — 030 Agent review loop

## Spec/docs first

- `docs/spec.md`: new section "Agent review loop" — CLI contract (three
  subcommands, JSON shapes), schema deltas (`Session.review`, `Chapter.marksEdited`,
  `analysis: "skip"`), API deltas, rerun-gate extension. Update §19 route
  table and §20 test notes.
- `docs/design.md`/`docs/ux.md`: narration ownership note (agent-authored
  is a first-class source, not just "human edit"); Submit review button in
  the header spec (ux §3.1).

## Schema (`src/types.ts`)

- `Session.review?: { submittedAt: string; comments: SubmittedComment[] }`
  where `SubmittedComment` = the comment at submit time (id, file, side,
  line, text, priority, resolved, chapterId).
- `Chapter.marksEdited?: boolean` — set when agent marks land; joins the
  existing `needsConfirm` gate alongside `narrativeEdited` (rerun, rerun-all,
  rechunk paths in `remap.ts` / `narrate.ts` check both).

## API (`src/server.ts`, small pure pieces in `store.ts` / `narrate.ts`)

- `POST /api/sessions` body grows `analysis?: "full" | "skip"` (default
  `"full"`). `"skip"` → rules marks only, no classifier/narrate/LLM-marks
  pass (reuse the §16.1 degradation plumbing: skip = same code path as "no
  adapter configured").
- `PATCH /api/sessions/:id` grows:
  - `marks?: { chapterId, marks: RawMark[] }` → validates mark names
    (`MARK_NAME` in narrate.ts), replaces that chapter's LLM/rule marks,
    sets `marksEdited: true`.
  - `submitReview?: true` → snapshots open (non-resolved? decide: **all
    non-resolved open comments**; resolved ones excluded) into
    `Session.review`, stamps `submittedAt`. Second submit while one exists
    → replaces the snapshot only if new comments exist since; else 409.
    (Exact re-submit rule decided here, written back to spec.)
- Comment POST/PATCH after submit does **not** touch `Session.review`.

## CLI (`src/main.ts`, reuse `cli.ts` helpers)

- `sky-eye review start [--base <ref>]`:
  1. Resolve repo (existing logic). 2. Probe scan-range ports for a live
  sky-eye server (GET /api/refs); if none, spawn `sky-eye serve` detached
  (`unref`, stdio ignore, browser-open suppressed via env/flag) and poll
  until up. 3. POST create session with `analysis: "skip"`. 4. Print JSON
  `{ sessionId, url, port, chapters }` — chapters reduced to TOC
  (id, title, files + statuses, hunk ranges, changed-line counts).
- `sky-eye review narrate <id> --from <file>` (or `-` stdin):
  body `{ narratives: [{chapterId, text}], marks: [{chapterId, marks}] }`
  → one PATCH (server applies both atomically), then prints `url`.
- `sky-eye review wait <id> [--timeout N] [--json]`:
  prints URL banner, polls `GET /api/sessions/:id` every 2s, re-prints URL
  on one refreshed line (ANSI `\r` or plain repeat — decide: plain repeat
  every 30s, lazy) every ~30s; on `review` appearing → print snapshot
  (text default: per comment `file:line — text (priority)`; `--json` raw)
  → exit 0; on timeout → stderr "no review received", exit 2.
- start does NOT open the browser; wait does (user reviews after the agent
  finished narrating). `start` prints the URL anyway for the agent to relay.

## UI (`src/public/app.js`, `style.css`)

- "Submit review" button in the session header actions (§3.1 pattern,
  class-scoped like task 022). Click → PATCH `submitReview` → brief
  confirmation ("review submitted — the waiting agent received it").
- No first-screen changes.

## What could break

- Rerun gate: adding `marksEdited` touches three confirm checks — grep
  `needsConfirm` and extend all; fixtures for the new gate combination.
- `analysis: "skip"` must not break existing create paths (default full).
- Detached `sky-eye serve` spawn: make sure it doesn't inherit stdio
  (hangs the agent) and honors port-scan like the foreground path.
- Comment snapshot at submit: capture text *as of submit*; later edits to
  the live comment don't mutate the snapshot (copy fields, don't reference).

## Tests

- Pure: snapshot builder (which comments join, resolved excluded), marks
  validation + `marksEdited` gate in rerun/rechunk fixtures.
- Integration: temp repo → `review start` (parse JSON) → POST a comment →
  `submitReview` via PATCH → `review wait` (short poll) returns the comment
  text; timeout path exit 2.
- Manual recipe: run the loop from a real agent session; verify URL
  re-print, browser open, submit button, agent receives comments.
