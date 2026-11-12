# 030 — Agent review loop (inline sky-eye during an agent session)

Let an *agent* (pi, Claude Code, any harness that can run a shell) drive
sky-eye inline while it works: the agent's session knows **why** a change
was made, so it — not sky-eye's internal LLM — authors the chapter
narratives and attention marks; the human reviews in the browser and
submits comments; the agent blocks until the review comes back and receives
the comments to act on.

**Generic integration = CLI with JSON I/O, no MCP.** Any agent with shell
access can drive three subcommands; MCP would add tool discovery, not
capability (decided with user, 2025 session).

## The loop

```
1. TRIGGER   user asks (keyword or explicitly) → agent runs the flow
2. START     sky-eye review start
             → server up? probe :4800 (any bound port in the scan range);
               else spawn detached `sky-eye serve` (same startup sequence,
               browser open suppressed)
             → POST /api/sessions {base: defaultBase, head: @|branch}
               with analysis skipped (rules marks only)
             → stdout JSON: { sessionId, url, port,
                              chapters: [{id, title, files, hunkRanges}] }
3. NARRATE   agent authors narratives + marks from its session context
             (it may not even need the diff re-sent — it wrote the code)
             → sky-eye review narrate <sessionId> --from review.json
             → one bulk PATCH; then open the browser at the session URL
4. WAIT      sky-eye review wait <sessionId> [--timeout N]
             → prints the session URL prominently; re-prints it on a
               refreshed line every ~30s while waiting (user returning to
               the terminal can still find it)
             → blocks until the user clicks "Submit review" (default:
               forever; --timeout N seconds → exit 2 with "no review")
             → prints the submitted review snapshot (readable text;
               --json optional): file, line, side, text, priority, resolved
5. ACT       agent works on the comments; empty submit → "review passed"
```

Blocking wait also solves working-copy drift: the diff can't change under
the reviewer because the agent is parked.

## Decisions (made with user unless noted)

- **Narrator = the agent** (option A). sky-eye's internal LLM narration is
  untouched for standalone use; inline sessions skip it at creation.
- **Agent authors marks too** — including custom mark names ("unsure",
  "risky"). Agent marks behave like authored content: rerun/rechunk/rerun-all
  treat a chapter with agent marks like one with an edited narrative
  (same `needsConfirm` gate). New chapter flag `marksEdited`.
- **Agent narratives set `narrativeEdited: true`** (existing semantics —
  free).
- **Review snapshot model**: `Session.review = { submittedAt, comments: [...] }`
  set by POST submit; comments added afterwards don't retroactively join.
  The session-level `reviewed` flag stays untouched (user reading progress).
- **Empty submit is valid** → agent receives "no comments".
- **Bulk write** for narratives + marks (one atomic write, one `lastWriteAt`).
- **URL prominence**: printed once at wait start; refreshed line re-shows it
  every ~30s. Session URL = `http://localhost:<port>/#<sessionId>` (spec §17).
- **Wait output**: readable text by default, `--json` optional.
- Server security model unchanged: agent sends `X-Sky-Eye: 1` on non-GETs.

## Accept

- Spec gains an "agent review loop" section (CLI contract, schema, API
  deltas); design/ux touched where they reference narration ownership.
- `POST /api/sessions` accepts `analysis: "skip"` (rules marks only, no
  narrate/LLM pass).
- `PATCH /api/sessions/:id` accepts `marks?: { chapterId, marks: [...] }`
  (agent-authored, sets `marksEdited`) and `submitReview?: true`.
- CLI: `sky-eye review start|narrate|wait` (pattern: existing
  `debug-classify` / `check-config` subcommands in `main.ts`).
- UI: "Submit review" button in the session header (only meaningful always;
  clicking sets the snapshot; disabled/no-op gracefully when already
  submitted this round — decide exact re-submit semantics during planning).
- Tests: bulk-narrate pure logic as fixtures; CLI/server exercised in the
  integration test (temp repo, scripted comments, submit, wait returns).

## Out of scope

- MCP server, auto-trigger at task boundaries, re-request loops (agent
  fixes → new review round) — a second round is just running the flow again
  on a new session; decide later whether to chain.
