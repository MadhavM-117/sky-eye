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
                                     .sky-eye/<session-id>.json
```

- **Server**: one small HTTP server (plain `node:http`),
  serves the static frontend plus a handful of JSON endpoints. On startup:
  bind the preferred port on `127.0.0.1`, scan upward through user-space
  ports (>1024) on `EADDRINUSE`; print `serving <repo-root> (<kind> repo) → <url>`;
  open the browser (`xdg-open`/`open`).
- **Not open by design**: no auth (it's local), bound strictly to `127.0.0.1`
  so other machines on the LAN cannot connect. Because "local" still means
  any webpage open in the user's browser can send requests to localhost, the
  server rejects requests whose `Host` header is not `localhost:<port>` or
  `127.0.0.1:<port>`, and requires `X-Sky-Eye: 1` on every non-GET request —
  browsers cannot attach custom headers cross-origin without a passing
  preflight, which kills drive-by CSRF.
- **Frontend**: single-page app in `public/`, calling the JSON API. Left
  column old code, right column new, like GitHub. The heavy UI lifting —
  two-column diff rendering with a line-annotation framework, 152-language
  syntax highlighting, the file tree — comes from the open-source
  `@pierre/diffs` / `@pierre/highlights` / `@pierre/trees` packages
  (Apache-2.0, source vendored at `tmp/pierre/packages/` for reference),
  wired to the server JSON through one thin adapter module. Bundled with
  esbuild (the only build step; the server itself stays buildless and
  dependency-free — see §8). The interesting logic (diff parsing, chunking,
  remap) is server-side TypeScript in `src/`; the browser gets data, not
  logic.
- **State**: one JSON file per review session in `.sky-eye/` (see §4). The
  export file *is* this file.
- **Paths are relative**: all file paths in session JSON and API responses
  are relative to the repo root, so moving or renaming the repo directory
  never invalidates sessions.

## 3. Feature map

| # | Requirement | Component | Notes |
|---|---|---|---|
| 0 | Repo detection + ref discovery | `refs.ts` | `.jj` dir → jj mode (colocated: jj wins), else git mode; `GET /api/refs` returns root/kind, current head, default base, bookmarks/branches, recent commits; discovery gaps → 200 with empty lists, never errors |
| 0a | Ignore-file upkeep | startup step | ensure `.sky-eye/` is ignored: append to `.gitignore` (created if missing; also honored by jj) and to `.dockerignore` (only if `.dockerignore` already exists) |
| 0b | File explorer | `tree.ts` + frontend | GitHub/GitLab-style repo tree browsing and read-only file viewing (§6b) |
| 1 | GitHub-style diff view | frontend diff renderer + `diff.ts` | hunks with context lines; one chapter at a time with a chapter rail for navigation (frontend-only, ux.md §3.2–3.3) |
| 1a | Syntax highlighting | `@pierre/highlights` (via `@pierre/diffs` rendering) | tree-sitter-grade WAT/WASM highlighter, 152 languages, plain-text fallback; applied to file views and diff lines alike — key requirement (§6b) |
| 2 | Chapters of ~50–100 lines (max 200, configurable), spanning files when no split rule fires | `chunker.ts`, `semantic-chunk.ts` | split hunks at function boundaries within a file; keep related hunks in the same function together; a chapter holds one contiguous slice per file; config knob for max size. Opt-in semantic mode (spec §8a): a `chunk` LLM task groups hunks into titled chapters in one call; the pure chunker is the fallback at every point |
| 3 | Attention highlighting (focus / glance / safe) | `classify.ts` | rule pass first (test changes, comments, lockfiles → safe; new auth/money/async/error paths → focus); LLM pass refines, opt-in |
| 4 | Comments on lines | comments API + frontend gutter click | GitHub-style: click line → inline composer, reply, resolve |
| 5 | Local persistence + single-file export | per-session JSON files; export = copy of the file, import = load + merge by session ID | re-verify guards against importing a review of a different commit |
| 6 | Narrative overview per chapter | `narrate.ts` | LLM per chapter (diff hunk + surrounding file context in, short paragraph out); cached in the session file so it's generated once; human-editable afterwards (§6a). An agent session (spec §16a) is a first-class alternative narrator: it authors narratives + marks from its own task context and sky-eye only structures them |

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

- A jj working-copy edit or rebase preserves change ids, so the session key
  survives: the session becomes "same key, changed diff" and goes through the
  refresh flow (stale banner + remap pass, §6.1). Never auto-refresh silently
  on open.
- A git amend or rebase rewrites commit ids: the server detects that the
  session's `headRef` (branch name) now points to a new commit id → stale
  banner → §6.2 supersede flow (new session id, old marked `supersededBy`).

Branch names encountered at creation time are stored as `baseRef` / `headRef`
and `aliases`.

Multiple sessions exist side by side — one file per session under
`.sky-eye/`, no locking between them.

### Types

```ts
Session {
  id:         SessionId
  base:       string            // resolved stable revision id for base
  head:       string            // resolved stable revision id for head
  baseRef?:   string            // symbolic branch/bookmark name at creation
  headRef?:   string            // symbolic branch/bookmark name at creation
  diffDigest: string            // sha256 of normalized diff text at build time
  aliases:    string[]          // branch names seen when created, e.g. ["main...feature/x"]
  createdAt, updatedAt, lastWriteAt
  meta:       { repo, exportedBy }   // repo = repo root at creation, display only;
                                     // all stored file paths are repo-relative (§2)
  label?:     string            // human name, e.g. "the auth refactor"
  reviewed:   boolean           // false until marked; drives the session-list chip
  chapters:   Chapter[]
  comments:   Comment[]
  supersededBy?: SessionId      // set when a rebase created a successor session
}

Chapter {
  id: string                    // stable hash of all file slices + first/last hunk ranges
  files: FileSlice[]            // one contiguous slice per file, in path order
                                // FileSlice { file, status, hunks } — a chapter may span files
  title?: string                // one-line semantic description from the chunk task
                                // (spec §8a); absent from pure-chunked chapters
  narrative: string             // what's happening here (LLM, "unanalyzed", or human-written)
  narrativeEdited?: boolean     // set when a human edited the narrative; a re-run
                                // must confirm before overwriting it
  attention: LineMark[]         // per-line: "focus" | "glance" | "safe"; carries the slice's file
  viewedFiles: string[]         // repo-relative paths of this chapter's file slices marked
                                // viewed (subset of files[].file); a chapter counts as viewed
                                // when every slice path is listed — derived, never stored
}

Comment {
  id, chapterId, file, side: "old"|"new", line, text, createdAt, updatedAt
  author: { name, email } | null   // from git/jj config; null → shown as "anonymous"
  resolved: boolean
  resolvedAt?: timestamp
  priority?:  "nit" | "must-fix"  // unset → normal comment
  orphaned?:  boolean           // set when remap cannot place the comment in any new diff hunk
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
POST /api/comments                  → add comment (sessionId in body; server captures anchor)
PATCH /api/sessions/:id             → set label / reviewed flag / chapter narrative /
                                      viewed files (spec §9.3)
PATCH /api/comments/:id             → edit / resolve / re-pin anchor / set priority (sessionId in body)
POST /api/sessions/:id/rerun        → narrative/classification for one chapter;
                                      performs the first generation when none exists
POST /api/sessions/:id/refresh      → head moved with same base: rebuild diff,
                                      carry over comments via the §6 remap pass
                                      (in-place for jj, supersede flow for git)
GET  /api/sessions/:id/export       → download the session's json
POST /api/import                    → import; merges into the session with the same ID
                                      (merge rule: match comments by id, newer
                                      updatedAt timestamp wins per comment, nothing deleted)
```

## 6. Comment carry-over across rebase

A rebase rewrites commit IDs, so the session key breaks and line numbers
shift. Comments survive via **content anchors**:

1. **Re-anchor pass** (`remap.ts`): runs when a session is **refreshed** —
   user clicks "refresh review?", or an import brings a changed diff. Never
   silently on open: opening a stale session only shows the banner. Each
   comment's anchor is searched for in the *new* version of the file:
   - Exact `text` match near the old line number → candidate line.
   - Multiple candidates → score by `before`/`after` context matches; best
     score wins.
   - If the matched line falls inside a hunk of the rebuilt chapters → re-pin.
   - Matched line outside all diff hunks → still re-pinned: it is a
     comment on an **unchanged line** (only possible since full-file mode
     allows commenting there, §6b) and renders in the file block's
     full-file mode, not in the diff view.
   - No match at all (commented line edited away, file renamed) → comment
     becomes **orphaned**: keeps its old anchor, stays visible, shows in
     triage.
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

How a chapter summary is produced (the standalone path — the agent review
loop of spec §16a is the second, agent-authored source):

- **Firing**: eagerly, as the final step of every chapter-building pipeline
  (creation, refresh/supersede, re-chunk) — a session is fully analysed
  before it is shown (spec §16.2). Chapters that could not be analysed
  (no LLM configured, failed call) stay "unanalyzed"; the session never
  blocks on the LLM layer.
- **Prompt input** (one call per chapter): the chapter's unified diff text;
  ~10 lines of new-side context above/below each hunk; file paths; the list
  of other chapter titles (so the narrative can reference, not repeat) —
  semantic titles from the chunk task when present (spec §8a), else the
  file list.
- **Output**: a short paragraph — what is happening here, not a judgment.
- **Ordering**: chapters are arranged for reading as part of the analysis
  (spec §16.7): the semantic chunker returns reading order; otherwise a
  cheap ordering call arranges the chapter list; with no LLM, path order.
- **Caching**: written to `Chapter.narrative` on first generation; survives
  reloads and exports. Re-run via `POST /api/sessions/:id/rerun`.
- **Human editing (the rule, not the exception)**: the narrative renders as
  markdown by default (escape-first, XSS-safe); an edit button swaps in a
  textarea prefilled with the current markdown text. Saving writes
  `narrative` (markdown text verbatim) and sets
  `narrativeEdited: true`. A re-run on an edited chapter asks for
  confirmation before overwriting; while generation runs, the edit button
  is hidden behind the loading indicator. No LLM needed to edit — the
  editor opens over "unanalyzed" too.
- **Per-task model/key config**: a config file at `.sky-eye/config.json`
  (inside the ignored state folder, so keys never land in git/jj/docker),
  layered under an optional machine-wide
  `$XDG_CONFIG_HOME/sky-eye/config.json` (repo wins per field; spec §16.1).
  Tasks (v1: `narrate`, `classify`, `chunk`; the classifier pass (spec §16.5 — exec
  hook or built-in backends — decision-model APIs: OpenRouter's
  (`builtin: "openrouter"`, e.g. typesafe/jev-1.14) or OpenAI's
  (`builtin: "openai"`, `src/decisions.ts`) join the same
  scheme) fall
  back to shared defaults, per-task entries override:

  ```jsonc
  {
    "defaults": { "apiKey": "…", "model": "…", "baseUrl": "…" },
    "tasks": {
      "narrate":  { "model": "…", "apiKey": "…" },
      "classify": { "provider": "anthropic", "model": "…" }
    }
  }
  ```

  e.g. a cheap fast model for `classify`, a stronger one for `narrate`.
  `provider` selects the adapter (§22.2): `"openai"` (default —
  OpenAI-compatible chat completions, which also covers compatible routers
  like OpenRouter via `baseUrl`) or `"anthropic"` (native
  `/v1/messages`); setting `command` instead makes the task use a **custom
  adapter**: an executable reading `{ "protocol": 1, "task", "model",
  "system", "prompt" }` JSON on stdin and writing `{ "text": "…" }` on
  stdout (same spirit as the custom classifier hook). Requests are blocking
  in v1; streaming deferred.
  Missing file or missing key for a task → that task is skipped (its output
  degrades to rules only / "unanalyzed"); it never blocks the session.
- **Shared call with classification**: the LLM refinement in `classify.ts`
  (feature 3) shares the narrate request by default — one response carries
  both the paragraph and per-line marks — but only while both tasks resolve
  to the *same* adapter (same provider/baseUrl/model, or the same custom
  command); different configs mean two calls.

## 6b. File explorer and syntax highlighting

`GET /api/tree?ref=…&dir=…` lists a directory at a ref (head or base side)
from the VCS object store; `GET /api/file?ref=…&path=…` returns file content
at that ref from the VCS object store (so deleted or moved files still render
on the `base` side). **Path containment:** both normalize the requested
repo-relative path with `path.posix.normalize` and reject anything that escapes
the repo root (`..` segments, leading `/` or `-`, backslashes, NUL bytes). The
frontend offers a GitHub/GitLab-style tree browser: click through directories,
open files read-only. Changed files stay reachable from the chapter rail and
the header's files link; the diff block itself does not link its file path —
it offers an explicit **full-file button** that renders the whole file in
the diff viewer (hunks expanded to whole-file context by the adapter from
`/api/file` content, ux §3.2), where any line — changed or unchanged — is
commentable.

Syntax highlighting is provided by `@pierre/highlights` (WAT/WASM,
152 built-in languages, Zed-compatible themes) rather than a hand-rolled
tokenizer; unknown extensions render as plain text. The same highlighter
colors file views and diff hunks consistently because `@pierre/diffs` renders
both with a shared Shiki/highlights backend and theme. An LSP backend is a
possible later upgrade; with 152 languages already covered, highlighting is
no longer a sky-eye problem.

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
│   ├── semantic-chunk.ts # LLM semantic grouping (optional, spec §8a)
│   ├── classify.ts     # rules for attention marks
│   ├── narrate.ts      # LLM chapter narratives (optional)
│   ├── remap.ts        # rebase survival: re-anchor comments
│   ├── identity.ts     # author name/email from jj/git config
│   ├── store.ts        # session files: load/save/list/merge-import
│   └── public/         # index.html, app.js, pierre adapter, style.css
│                       # bundled by esbuild → public/dist/ (frontend-only build;
│                       # @pierre/* deps are frontend runtime deps, §2)
├── .sky-eye/         # one session json per file; kept out of git/jj/docker
│                       # by ignore-file upkeep at startup (§3, row 0a)
└── tests/              # chunker + remap fixtures first — that's where the bugs live
```

## 9. Milestones

1. **Spine** — diff → chapters → read-only chaptered diff view + file explorer +
   syntax highlighting in browser (all via the `@pierre/*` packages, §2); pick
   base/head, create session; session list screen.
2. **Comments** — click line, write (with author from jj/git config and
   server-side anchor capture), resolve, deep links, persist, survive reload.
3. **Rebase survival** — staleness detection, remap pass on session refresh,
   orphan triage banner, git supersede flow.
4. **Chunker tuning** — function-boundary splits, size limits, config knob.
5. **Rule-based attention marks.**
6. **Export/import** with merge-on-import (`updatedAt` wins) and digest re-verification.
7. **LLM narratives + refined classification**, opt-in.
8. **Review ergonomics** — session header redesign (three-line layout:
   title / repo-path + head/base context / grouped actions with a
   mark-reviewed button and an overflow menu, hover help text; ux §3.1),
   whole-bar accordion toggling with an explicit full-file button,
   full-file diff mode with unchanged-line comments (ux §3.2).

## 10. Deliberate cuts

Auth/multi-user (it's local), markdown rendering in comments, inline image
attachments, PR-provider integration, LSP semantic highlighting
(`@pierre/highlights` ships 152 languages of tree-sitter-grade coloring in
v1, §6b), diff navigation shortcuts (in-diff hunk jumping — chapter-level
navigation and the one-chapter focus view are in, ux.md §3.3), dark mode,
per-session identity override, session file locking (save-on-write with a
`lastWriteAt` conflict check and a warning is enough). All addable later
without rework.

Also cut: building UI from the `@pierre/*` React entries — sky-eye uses only
their vanilla JavaScript entries.

## 11. Known risks

- **Chapter IDs break on rebase** — mitigated by the remap pass and import
  re-verification, not fully solved.
- **Export to a different clone** only re-attaches if both clones share the
  commits (same remote).
- **Same diff, two browser tabs** — last writer wins; acceptable for a local
  single-user tool, warned on conflict.
- **jj/git identity fallback** — assumed `jj config get` falls through to git
  config for user identity; verify when building `identity.ts`.
- **`@pierre/diffs` API churn** — 1.x with active development (`@pierre/trees`
  is beta). Pin exact versions; the one-adapter-module rule (§2) keeps the
  churn contained; bump deliberately, not transitively.
