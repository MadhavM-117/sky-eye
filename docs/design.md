# sky-eye — local code review helper

A local web app that turns a branch diff into a readable, chaptered review —
like a GitHub PR view, but running entirely on your machine, with narratives,
attention markers, and comments that survive rebases and can be handed to
someone else as a single file.

The user-facing flow is specified in `docs/ux.md`; this file specifies how
it works.

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
│  (SPA)     │   sessions, comments,        │              │──► LLM (opt-in, config file)
└────────────┘   export/import, files        └──────┬───────┘
                                                   ▼
                                     .sky-watch/<session-id>.json
```

- **Server**: one small HTTP server (Node + Hono or plain `node:http`),
  serves the static frontend plus a handful of JSON endpoints. On startup:
  bind the preferred port, scan upward through user-space ports (>1024) on
  `EADDRINUSE`; print `serving <repo-root> (<kind> repo) → <url>`; open the
  browser (`xdg-open`/`open`).
- **Not open by design**: no auth (it's local), but "local" means this
  browser, not this tab — any webpage the user visits can send requests to
  the localhost port. So: reject requests whose `Host` header is not this
  server's host:port, and require a custom header (`X-Sky-Eye: 1`) on every
  non-GET request — browsers cannot attach custom headers cross-origin
  without a passing preflight, which kills drive-by CSRF.
- **Frontend**: single-page, no build step — plain JS ES modules in
  `public/`, calling the JSON API. Left column old code, right column new,
  like GitHub. The interesting logic (diff parsing, chunking, remap) is
  server-side TypeScript in `src/`; the browser gets data, not logic.
  Highlighting is the one browser-side module (`public/highlight.js` +
  vendored tree-sitter WASM grammars, §6b). If vendoring grammars proves too
  clumsy in practice, the fallback is esbuild — that would be a build step;
  decide then, not now.
- **State**: one JSON file per review session in `.sky-watch/` (see §4). The
  export file *is* this file.
- **Paths are relative**: all file paths in session JSON and API responses
  are relative to the repo root, so moving or renaming the repo directory
  never invalidates sessions.

## 3. Feature map

| # | Requirement | Component | Notes |
|---|---|---|---|
| 0 | Repo detection + ref discovery | `refs.ts` | `.jj` dir → jj mode (colocated: jj wins), else git mode; `GET /api/refs` returns root/kind, current head, default base, bookmarks/branches, recent commits; discovery gaps → 200 with empty lists, never errors |
| 0a | Ignore-file upkeep | startup step | ensure `.sky-watch/` is ignored: append to `.gitignore` (also honored by jj) and `.dockerignore` if not already present |
| 0b | File explorer | `tree.ts` + frontend | GitHub/GitLab-style repo tree browsing and read-only file viewing (§6b) |
| 1 | GitHub-style diff view | frontend diff renderer + `diff.ts` | hunks with context lines, per-file tabs or accordion |
| 1a | Syntax highlighting | `public/highlight.js` | tree-sitter (WASM) in the browser, grammars loaded on demand, plain-text fallback; applied to file views and diff lines alike — key requirement (§6b) |
| 2 | Chapters of ~50–100 lines (max 200, configurable) | `chunker.ts` | split hunks at file/function boundaries; keep related hunks together (same function, rename pairs); config knob for max size |
| 3 | Attention highlighting (focus / glance / safe) | `classify.ts` | rule pass first (test changes, comments, lockfiles → safe; new auth/money/async/error paths → focus); LLM pass refines, opt-in |
| 4 | Comments on lines | comments API + frontend gutter click | GitHub-style: click line → inline composer, reply, resolve |
| 5 | Local persistence + single-file export | per-session JSON files; export = copy of the file, import = load + merge by session ID | re-verify guards against importing a review of a different commit |
| 6 | Narrative overview per chapter | `narrate.ts` | LLM per chapter (diff hunk + surrounding file context in, short paragraph out); cached in the session file so it's generated once; human-editable afterwards (§6a) |

Features 3 and 6 realistically need an LLM; rules alone give coarse
classification and "unanalyzed" narratives. The LLM is a quality upgrade, not
a structural dependency — the tool works without a key.

## 4. Data model

### Session identity

A session is keyed by the **diff itself**, not the branch name — branch names
move, commits don't. All paths stored anywhere are repo-relative so a moved
repo keeps working (§2):

```ts
SessionId = `${base}..${head}`   // e.g. "a1b2c3..d4e5f6" (git) or "kvtxslq..qpslwo" (jj)
```

Each side of the key is the repo's **stable revision id**:

- **git**: the commit id.
- **jj**: the **change id** when the side is a mutable change (the working
  copy `@` included) — jj rewrites `@`'s *commit* id on every file save, so
  commit ids are useless as keys; for bookmarks and immutable commits the
  commit id is the stable id.

Consequences:

- jj working-copy edits (saving files) never invalidate the session key; the
  diff is rebuilt and shown as-is on open.
- A jj rebase preserves change ids, so the key survives it: the session
  becomes "same key, changed diff" and goes through the refresh flow (stale
  banner + remap pass, §6.1). The supersede flow only applies when the key
  itself breaks.
- A git rebase rewrites commit ids → new session id → §6.2 supersede flow.

Branch names encountered at creation time are stored as `aliases` for lookup
only.

Multiple sessions exist side by side — one file per session under
`.sky-watch/`, no locking between them.

### Types

```ts
Session {
  id:         SessionId
  aliases:    string[]          // branch names seen when created, e.g. ["main...feature/x"]
  createdAt, updatedAt
  meta:       { repo, exportedBy }   // repo = repo root at creation, display only;
                                     // all stored file paths are repo-relative (§2)
  label?:     string            // human name, e.g. "the auth refactor"
  reviewed:   boolean           // false until marked; drives the session-list chip
  chapters:   Chapter[]
  comments:   Comment[]
  supersededBy?: SessionId      // set when a rebase created a successor session
}

Chapter {
  id: string                    // stable hash of file + hunk range
  files: [{ path, oldStart, newStart, lines }]
  narrative: string             // what's happening here (LLM, "unanalyzed", or human-written)
  narrativeEdited?: boolean     // set when a human edited the narrative; a re-run
                                // must confirm before overwriting it
  attention: LineMark[]         // per-line: "focus" | "glance" | "safe"
}

Comment {
  id, chapterId, file, side: "old"|"new", line, text, createdAt
  author: { name, email } | null   // from git/jj config; null → shown as "anonymous"
  resolved: boolean
  resolvedAt?: timestamp
  priority?:  "nit" | "must-fix"  // unset → normal comment
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

### Deep links

Every line and comment has a copyable local URL fragment —
`#<sessionId>/<chapterId>/<file>/<line>` (file path percent-encoded, since
paths contain `/`) and `#<sessionId>/<commentId>` —
resolved client-side: the app scrolls to and highlights the target. No
dedicated endpoint; fragments are pure frontend routing over session data.
Deep links stay valid across export/import (same IDs) but, like everything,
only within the same diff (rebase breaks them like any chapter ID).

## 5. Endpoints

```
GET  /api/sessions                  → list sessions (id, aliases, updatedAt, open-comment count)
GET  /api/sessions/:id              → full Session
GET  /api/refs                      → repo root/kind, current head, default base,
                                      bookmarks/branches, recent commits
                                      (empty lists on discovery gaps; 200 either way)
GET  /api/tree                      → directory listing at a ref (repo-relative path)
GET  /api/file                      → file content at a ref, head or base side
                                      (repo-relative path)
POST /api/sessions                  → create from {base, head} (or current branch vs default)
POST /api/comments                  → add comment (session id in URL/body)
PATCH /api/sessions/:id             → set label / reviewed flag
PATCH /api/comments/:id             → edit / resolve / re-pin anchor / set priority
POST /api/sessions/:id/rerun        → narrative/classification for one chapter;
                                      performs the first generation when none exists
POST /api/sessions/:id/refresh      → head moved with same base: rebuild diff,
                                      carry over comments via the §6 remap pass
                                      (supersede flow, new session id)
GET  /api/sessions/:id/export       → download the session's json
POST /api/import                    → import; merges into the session with the same ID
                                      (merge rule: match comments by id, newer
                                      timestamp wins per comment, nothing deleted)
```

## 6. Comment carry-over across rebase

A rebase rewrites commit IDs, so the session key breaks and line numbers
shift. Comments survive via **content anchors**:

1. **Re-anchor pass** (`remap.ts`): runs when a session is **refreshed** —
   user clicks "refresh review?", or an import brings a changed diff. Never
   silently on open: opening a stale session only shows the banner. Each
   comment's anchor is searched for in the *new* version of the file:
   - Exact `text` match near the old line number → re-pin. (Common case:
     lines above the change didn't move.)
   - Multiple candidates → score by `before`/`after` context matches; best
     score wins.
   - No match (commented line edited away, file renamed) → comment becomes
     **orphaned**: keeps its old anchor, stays visible, shows in triage.
2. **Session identity**: a rebase that breaks the session key (git mode;
   jj keys survive rebases, §4) produces a new session ID. No silent
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

## 6a. Narrative generation

How a chapter summary is produced:

- **Firing**: lazily on first chapter expansion, not eagerly at session
  creation — chapters never expanded stay unanalyzed.
- **Prompt input** (one call per chapter): the chapter's unified diff text;
  ~10 lines of new-side context above/below each hunk; file paths; the list
  of other chapter titles (so the narrative can reference, not repeat).
- **Output**: a short paragraph — what is happening here, not a judgment.
- **Caching**: written to `Chapter.narrative` on first generation; survives
  reloads and exports. Re-run via `POST /api/sessions/:id/rerun`.
- **Human editing (the rule, not the exception)**: the narrative is a plain
  editable text field. Saving writes `narrative` and sets
  `narrativeEdited: true`. A re-run on an edited chapter asks for
  confirmation before overwriting. No LLM needed to edit — the field is
  writable over "unanalyzed" too.
- **Per-task model/key config**: a config file at `.sky-watch/config.json`
  (inside the ignored state folder, so keys never land in git/jj/docker).
  Tasks (v1: `narrate`, `classify`; later tasks join the same scheme) fall
  back to shared defaults, per-task entries override:

  ```jsonc
  {
    "defaults": { "apiKey": "…", "model": "…", "baseUrl": "…" },
    "tasks": {
      "narrate":  { "model": "…", "apiKey": "…" },
      "classify": { "model": "…" }
    }
  }
  ```

  e.g. a cheap fast model for `classify`, a stronger one for `narrate`.
  Missing file or missing key for a task → that task is skipped (its output
  degrades to rules only / "unanalyzed"); it never blocks the session.
- **Shared call with classification**: the LLM refinement in `classify.ts`
  (feature 3) shares the narrate request by default — one response carries
  both the paragraph and per-line marks — but only while both tasks resolve
  to the *same* provider/model; different configs mean two calls.

## 6b. File explorer and syntax highlighting

`GET /api/tree?ref=…&dir=…` lists a directory at a ref (head or base side);
`GET /api/file?ref=…&path=…` returns file content. **Path containment:** both
resolve the requested path against the repo root and reject anything that
resolves outside it — `..` segments, absolute paths, and symlinks escaping
the repo (`fs.realpath` containment check). The frontend offers a
GitHub/GitLab-style tree browser: click through directories, open files
read-only. Changed files in a diff link into the explorer at that path.

Syntax highlighting is a tree-sitter (WASM) highlighter in the browser
(`public/highlight.js`): per-language grammars fetched on demand and cached;
unknown extensions render as plain text. The same highlighter colors file
views and diff lines so both stay consistent. An LSP backend is a possible
later upgrade (semantic accuracy at the cost of a per-language server);
tree-sitter alone is the v1 commitment — this reverses the earlier
"simple tokenizer or none" cut.

## 6c. Ref discovery (jj vs git)

Implements `GET /api/refs` (§5). Detection: `.jj` dir present → jj mode
(jj wins for colocated repos), else git mode.

- **git mode**: head = HEAD branch; default base = merge-base with the
  default branch (main/master); base candidates = local + remote branches
  and `git log --oneline -n 20`.
- **jj mode (v1)**: head = working copy `@` only (arbitrary-head comparisons
  deferred); default base = trunk bookmark, falling back to `@-`; base
  candidates = bookmarks (`jj bookmark list`) and recent commits
  (`jj log` with an id+description template).

Discovery gaps (detached head, no bookmarks, fresh repo) yield empty lists
in a 200 response — the frontend renders an informative message; the API
never fails on a structurally valid repo. No repo at all is a startup
error.

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
│   ├── refs.ts         # repo detection (jj/git), ref discovery for /api/refs
│   ├── tree.ts         # file explorer: tree listing + file content at a ref
│   ├── diff.ts         # git/jj → hunks
│   ├── chunker.ts      # hunks → chapters (the interesting part)
│   ├── classify.ts     # rules for attention marks
│   ├── narrate.ts      # LLM chapter narratives (optional)
│   ├── remap.ts        # rebase survival: re-anchor comments
│   ├── identity.ts     # author name/email from jj/git config
│   ├── store.ts        # session files: load/save/list/merge-import
│   └── public/         # index.html, app.js, style.css, highlight.js +
│                       #   vendored tree-sitter WASM grammars (no build step)
├── .sky-watch/         # one session json per file; kept out of git/jj/docker
│                       # by ignore-file upkeep at startup (§3, row 0a)
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
attachments, PR-provider integration, LSP-backed highlighting (tree-sitter ships in v1
instead, §6b), diff navigation shortcuts, dark
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
