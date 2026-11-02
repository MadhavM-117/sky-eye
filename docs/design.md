# sky-eye — local code review helper

A local web app that turns a branch diff into a readable, chaptered review —
like a GitHub PR view, but running entirely on your machine, with narratives,
attention markers, and comments that survive rebases and can be handed to
someone else as a single file.

## 1. Core idea

Run a review against a diff locally (no GitHub/GitLab API, no server). A local
web server serves a PR-style diff view in your browser. The diff is re-chunked
into human-readable chapters, each with a narrative overview, per-line
attention markers, and a comment thread. Everything lives in per-session JSON
files you can export and share.

## 2. Architecture

```
┌────────────┐   JSON over localhost HTTP   ┌──────────────┐
│  browser   │ ◄──────────────────────────► │ local server │──► git/jj diff
│  (SPA)     │   sessions, comments,        │              │──► LLM (opt-in, env key)
└────────────┘   export/import               └──────┬───────┘
                                                   ▼
                                        reviews/<session-id>.json
```

- **Server**: one small HTTP server (Node + Hono or plain `node:http`),
  serves the static frontend plus a handful of JSON endpoints.
- **Frontend**: single-page, no build step preferred — vanilla JS or
  htmx-level complexity. Left column old code, right column new, like GitHub.
- **State**: one JSON file per review session (see §4). The export file *is*
  this file.

## 3. Feature map

| # | Requirement | Component | Notes |
|---|---|---|---|
| 1 | GitHub-style diff view | frontend diff renderer + `diff.ts` | hunks with context lines, per-file tabs or accordion |
| 2 | Chapters of ~50–100 lines (max 200, configurable) | `chunker.ts` | split hunks at file/function boundaries; keep related hunks together (same function, rename pairs); config knob for max size |
| 3 | Attention highlighting (focus / glance / safe) | `classify.ts` | rule pass first (test changes, comments, lockfiles → safe; new auth/money/async/error paths → focus); LLM pass refines, opt-in |
| 4 | Comments on lines | comments API + frontend gutter click | GitHub-style: click line → inline composer, reply, resolve |
| 5 | Local persistence + single-file export | per-session JSON files; export = copy of the file, import = load + merge by session ID | re-verify guards against importing a review of a different commit |
| 6 | Narrative overview per chapter | `narrate.ts` | LLM per chapter (diff hunk + surrounding file context in, short paragraph out); cached in the session file so it's generated once |

Features 3 and 6 realistically need an LLM; rules alone give coarse
classification and "unanalyzed" narratives. The LLM is a quality upgrade, not
a structural dependency — the tool works without a key.

## 4. Data model

### Session identity

A session is keyed by the **diff itself**, not the branch name — branch names
move, commits don't:

```ts
SessionId = `${baseCommit}..${headCommit}`   // e.g. "a1b2c3..d4e5f6"
```

Branch names encountered at creation time are stored as `aliases` for lookup
only.

Multiple sessions exist side by side — one file per session, no locking
between them.

### Types

```ts
Session {
  id:         SessionId
  aliases:    string[]          // branch names seen when created, e.g. ["main...feature/x"]
  createdAt, updatedAt
  meta:       { repo, exportedBy }
  chapters:   Chapter[]
  comments:   Comment[]
  supersededBy?: SessionId      // set when a rebase created a successor session
}

Chapter {
  id: string                    // stable hash of file + hunk range
  files: [{ path, oldStart, newStart, lines }]
  narrative: string             // what's happening here (LLM or "unanalyzed")
  attention: LineMark[]         // per-line: "focus" | "glance" | "safe"
}

Comment {
  id, chapterId, file, side: "old"|"new", line, text, createdAt
  author: { name, email } | null   // from git/jj config; null → shown as "anonymous"
  resolved: boolean
  resolvedAt?: timestamp
  anchor: Anchor                // content anchor for rebase survival (§6)
}

Anchor {
  file: string
  side: "old" | "new"
  line: number                  // line number at comment time (hint, not truth)
  text: string                  // exact content of the pinned line
  before: string[]              // 3 lines above, as they were
  after: string[]               // 3 lines below
  chapterId: string             // best-effort chapter hint
}
```

Stable chapter IDs make exports re-attachable to the same diff on another
machine. Comment anchors make comments re-attachable after a rebase (§6).

## 5. Endpoints

```
GET  /api/sessions                  → list sessions (id, aliases, updatedAt, open-comment count)
GET  /api/sessions/:id              → full Session
POST /api/sessions                  → create from {base, head} (or current branch vs default)
POST /api/comments                  → add comment (session id in URL/body)
PATCH /api/comments/:id             → edit / resolve / re-pin anchor
POST /api/sessions/:id/rerun        → re-run narrative/classification for one chapter
GET  /api/sessions/:id/export       → download the session's json
POST /api/import                    → import; merges into the session with the same ID
```

## 6. Comment carry-over across rebase

A rebase rewrites commit IDs, so the session key breaks and line numbers
shift. Comments survive via **content anchors**:

1. **Re-anchor pass** (`remap.ts`): when a session is opened and the current
   diff's head doesn't match the stored session ID, each comment's anchor is
   searched for in the *new* version of the file:
   - Exact `text` match near the old line number → re-pin. (Common case:
     lines above the change didn't move.)
   - Multiple candidates → score by `before`/`after` context matches; best
     score wins.
   - No match (commented line edited away, file renamed) → comment becomes
     **orphaned**: keeps its old anchor, stays visible, shows in triage.
2. **Session identity**: the rebase produces a new session ID. No silent
   merge — the old session is marked `supersededBy: <newId>` and its
   comments, chapters, and narratives are carried into the new session on
   first open. The old file stays on disk as history.
3. **Orphan triage UI**: an "N comments need re-pinning" banner. Click one →
   shown the comment plus the new diff of that file → click a line to re-pin
   (writes a fresh anchor), or mark resolved/wontfix.

Export/import inherits this for free: the same mechanism handles "another
machine has a rebased clone".

Out of scope (deliberate cuts): git-level rename detection, comment threading
across remap, remapping comments pinned to *old-side* lines (old side is
history — those get orphaned, not moved), and base-commit-change remapping
(build only if it bites in practice).

## 7. Identity and resolution

- **Author identity** (`identity.ts`): read once at startup or first comment
  — `jj config get user.name` / `user.email` first, then `git config
  user.name` / `user.email` (jj falls through to git config). Cached in
  memory. No UI override in v1. Missing config → `author: null`, comments
  still save, shown as "anonymous".
- **Resolved**: `PATCH /api/comments/:id { resolved: true }` sets flag +
  timestamp. UI: toggle on each comment; resolved comments collapse to a
  one-line summary, expandable; per-chapter and per-session "open comments: N"
  counters in the header. Resolved comments stay in the session file and in
  exports (they're part of the narrative), just visually demoted.

## 8. Project layout

```
sky-eye/
├── src/
│   ├── server.ts       # HTTP + static file serving
│   ├── diff.ts         # git/jj → hunks
│   ├── chunker.ts      # hunks → chapters (the interesting part)
│   ├── classify.ts     # rules for attention marks
│   ├── narrate.ts      # LLM chapter narratives (optional)
│   ├── remap.ts        # rebase survival: re-anchor comments
│   ├── identity.ts     # author name/email from jj/git config
│   ├── store.ts        # session files: load/save/list/merge-import
│   └── public/         # index.html, app.js, style.css (no build step)
├── reviews/            # one json file per session (gitignored by default)
└── tests/              # chunker + remap fixtures first — that's where the bugs live
```

## 9. Milestones

1. **Spine** — diff → chapters → read-only chaptered diff view in browser;
   pick base/head, create session; session list screen.
2. **Comments** — click line, write (with author from jj/git config), resolve,
   persist, survive reload.
3. **Rebase survival** — anchor capture on every comment write, remap pass on
   session open, orphan triage banner.
4. **Chunker tuning** — function-boundary splits, size limits, config knob.
5. **Rule-based attention marks.**
6. **Export/import** with merge-on-import and chapter-ID re-verification.
7. **LLM narratives + refined classification**, opt-in.

## 10. Deliberate cuts

Auth/multi-user (it's local), markdown rendering in comments, inline image
attachments, PR-provider integration, diff-syntax highlighting libraries
(start with a simple tokenizer or none), diff navigation shortcuts, dark
mode, per-session identity override, session file locking (save-on-write with
a `lastWriteAt` conflict check and a warning is enough). All addable later
without rework.

## 11. Known risks

- **Chapter IDs break on rebase** — mitigated by the remap pass and import
  re-verification, not fully solved.
- **Export to a different clone** only re-attaches if both clones share the
  commits (same remote).
- **Same diff, two browser tabs** — last writer wins; acceptable for a local
  single-user tool, warned on conflict.
- **jj/git identity fallback** — assumed `jj config get` falls through to git
  config for user identity; verify when building `identity.ts`.
