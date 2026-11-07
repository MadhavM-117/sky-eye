# sky-eye — Technical Specification (v1)

Derived from `docs/design.md` (architecture, binding) and `docs/ux.md` (UX,
binding on the design). Where the docs left an "A or B" choice open, this
spec **decides** and marks the decision. Section numbers in the docs are
referenced as `D§n` (design) and `U§n` (ux).

---

## 1. Product summary

A local web app that turns a git/jj branch diff into a chaptered, readable
review: PR-style two-column diff, split into ~50–100-line chapters with
narrative overviews, per-line attention marks, and content-anchored comments
that survive rebases. Sessions persist as JSON in `.sky-watch/` and export
as single files. No GitHub/GitLab API, no auth, no server deployment.

**Non-goals (D§10, U§4):** auth/multi-user, markdown in comments, inline
images, PR-provider integration, LSP highlighting, diff navigation
shortcuts, dark mode, per-session identity override, session file locking
beyond a `lastWriteAt` conflict check, arbitrary-head comparisons in jj v1.

## 2. Stack decisions

The docs left several "or" choices (D§2). Resolved here:

| Decision | Choice | Rationale |
|---|---|---|
| HTTP server | **plain `node:http`** (not Hono) | ~13 routes; a 100-line hand-rolled router beats a dependency. Nothing else in the stack needs a framework. |
| Language / runtime | **TypeScript, run via Node native type stripping** (`node --experimental-strip-types`, Node ≥ 22.6); `tsc --noEmit` for type checking only | No build step for the server either. If type stripping fights back (enum/namespace/decorators — don't use those), fall back to `tsx` as the single devDependency. |
| Frontend framework | **No app framework.** Thin vanilla app on top of the `@pierre/*` UI packages (`@pierre/diffs`, `@pierre/trees`; `@pierre/highlights` + `@pierre/theme` transitively) | Pierre's diff renderer already does what sky-eye would otherwise hand-build three times over: two-column rendering, line annotations (comments, attention marks), selection, virtualization. Its file tree has search + git-status badges. Writing our own diff/comment rendering layer is the slowest path to M2. |
| Frontend bundling | **`esbuild`** (devDependency) bundles `public/` JS → `public/dist/` | The `@pierre/*` dist files are ESM with bare imports (`shiki`, `diff`, `lru_map`, …) that a static file server cannot resolve; a bundle is the robust answer, an import map the brittle one. The *server* keeps its no-build rule (Node native type stripping). |
| Diff source | **Shell out to the `git` / `jj` CLI**, parse unified diff output | No libgit2/nodegit. The tool already assumes both CLIs exist. |
| LLM access | **OpenAI-compatible `POST {baseUrl}/chat/completions` via `fetch`** | Matches the config schema's `baseUrl`/`model`/`apiKey` (D§6a); covers OpenAI, Anthropic-compatible gateways, ollama, llama.cpp. No SDK dependency. |
| Syntax highlighting | **`@pierre/highlights`** — WAT/WASM tree-sitter-grade highlighter, 152 languages, Zed-compatible themes | Applied by `@pierre/diffs` to rendered diff hunks automatically; same engine colors explorer file views. 152 languages for free replaces a hand-rolled 5-language tokenizer. |
| Test runner | **`node:test`** (built-in) | No test-specific dependencies; the tests are pure-function fixtures (D§8). |
| Distribution | npm package with a `bin` entry (`sky-eye`), run inside any repo; server resolves the repo from `process.cwd()` | D/U§1.1: "user runs `sky-eye` inside a repository". |

Dependency policy (v1 revision): **server runtime dependencies stay zero**
(`node:http`, `node:test`, CLIs, `fetch` — all unchanged). **Frontend runtime
dependencies allowed**, pinned exact: `@pierre/diffs`, `@pierre/trees`, and
their transitive set (`shiki`, `diff`, `lru_map`, `hast-util-to-html`,
`@pierre/highlights`, `@pierre/theme`/`@pierre/theming`). Dev dependencies:
`typescript`, `@types/node`, `esbuild`. Motivation: build speed — the diff
annotation framework, per-language highlighting, and virtualization would
otherwise be hand-built inside M1/M2/M5. Source of these packages is vendored
for reference at `tmp/pierre/packages/` (upstream monorepo, Apache-2.0);
production builds come from npm.

Isolation rule: exactly one frontend module (the adapter, §18) imports from
`@pierre/*`; the rest of `public/` stays vanilla ES modules against sky-eye's
own API shapes. Pin exact versions and bump deliberately — `@pierre/diffs` is
1.x with active development, `@pierre/trees` is beta.

## 3. Repository layout

Exactly D§8, with the frontend expanded:

```
sky-eye/
├── package.json              # bin: sky-eye, engines: node >=22.6
├── tsconfig.json             # noEmit, strict
├── src/
│   ├── main.ts               # entry: repo detect → ignore upkeep → server start → browser open
│   ├── server.ts             # http server, router, static serving, security checks
│   ├── refs.ts               # repo detection (jj/git), ref discovery
│   ├── tree.ts               # tree listing + file content at a ref (path containment!)
│   ├── diff.ts               # git/jj CLI → unified diff → parsed hunks
│   ├── chunker.ts            # hunks → chapters
│   ├── classify.ts           # rule pass for attention marks
│   ├── narrate.ts            # LLM narrative + shared classification refinement
│   ├── remap.ts              # re-anchor comments onto a new diff
│   ├── identity.ts           # author name/email from jj/git config
│   ├── store.ts              # session files: load/save/list/merge-import, atomic writes
│   └── llm.ts                # OpenAI-compatible client + config loading (.sky-watch/config.json)
│   └── public/               # source; bundled by esbuild → public/dist/ (served statically)
│       ├── index.html
│       ├── app.js            # router + views (first screen / session / explorer)
│       ├── pierre-adapter.js # the ONLY module importing @pierre/*: maps sky-eye JSON → pierre render input
│       ├── explorer.js       # explorer view: @pierre/trees FileTree + breadcrumb + side toggle
│       ├── api.js            # fetch wrapper (adds X-Sky-Eye on non-GET)
│       └── style.css         # app chrome; diff/tree internals styled by @pierre/theme CSS vars
├── esbuild.config.mjs        # bundles public/app.js + explorer entries → public/dist/
├── tests/
│   ├── chunker.test.ts       # pure-function fixtures
│   ├── diffparse.test.ts
│   ├── remap.test.ts         # anchor scoring fixtures
│   └── integration.test.ts   # real temp git repo, spine smoke test
└── .sky-watch/               # created per-user-repo, never in this repo
```

## 4. Server core (D§2, U§1.1)

### 4.1 Startup sequence (`main.ts`)

1. Resolve repo root from `process.cwd()`: walk up until `.jj` or `.git` is
   found. Not found → print clear error to stderr, **exit non-zero, no
   browser open** (U§1.1.1).
2. Repo kind: `.jj` present → `jj` (jj wins for colocated), else `git`.
3. Ignore-file upkeep (§6 below).
4. Bind preferred port **4800** on **`127.0.0.1`** (`server.listen(port, "127.0.0.1")`);
   on `EADDRINUSE` scan upward through user-space ports (>1024) until one binds.
5. Print exactly: `sky-eye serving <repo-root> (<kind> repo) → http://localhost:<port>`
6. Open browser (`xdg-open`, macOS `open`) at the bound URL; failure to open
   is a warning, not an error.

### 4.2 Security (D§2)

Local-only, no auth, protected from both LAN access and drive-by browser requests:

- **Loopback-only socket:** server binds strictly to `127.0.0.1`, never `0.0.0.0`
  or `::`, so other machines on the local network cannot connect.
- **Host check:** every request's `Host` header must equal `localhost:<port>` or
  `127.0.0.1:<port>`. Anything else → 403. This kills DNS-rebinding.
- **Custom header check:** every non-GET request must carry `X-Sky-Eye: 1`,
  else 403. Browsers can't attach custom headers cross-origin without a
  passing preflight; no CORS headers are ever sent, so preflight always
  fails → CSRF dead.
- **CLI argument safety:** all `git` and `jj` commands are spawned via
  `execFile` / `spawn` with `shell: false`. User- or network-supplied refs
  are validated against `/^[0-9a-zA-Z][0-9a-zA-Z._/@+-]*$/` (no leading `-`,
  no whitespace or NUL bytes), and commands pass `--end-of-options` (git) and
  `--` before path arguments to prevent flag injection.
- GET routes are all read-only (sessions, refs, tree, file, export), so a
  plain cross-origin GET leaks nothing the browser could read anyway (no
  `Access-Control-Allow-Origin` is ever emitted).

### 4.3 Router & static serving

- `GET /` and unmatched non-`/api` paths → serve from `public/` with
  correct MIME types; unknown asset → 404. Path traversal on static serving
  is rejected (normalize + prefix check, same containment rule as §9.3).
- `/api/*` routes are JSON in / JSON out. Errors are
  `{ error: string }` with a correct status (400 bad input, 404 unknown
  session/comment, 409 write conflict, 500 unexpected).

## 5. Repo detection & ref discovery (`refs.ts`, D§3 row 0, D§6c, U§1.2–1.4)

`GET /api/refs` response:

```jsonc
{
  "root": "/abs/repo/root",     // display only; all stored paths are repo-relative
  "kind": "git" | "jj",
  "head": { "id": "...", "label": "main" | "@ (working copy)" },
  "defaultBase": { "id": "...", "label": "origin/main" } | null,
  "branches":  [{ "id": "...", "name": "..." }],   // bookmarks in jj
  "commits":   [{ "id": "...", "subject": "..." }] // ~20 recent
}
```

**git mode** (`execFile`, `--no-color` everywhere, full 40-char commit SHAs in all `.id` fields):
- head = `git symbolic-ref --short HEAD` (`label`) + `git rev-parse HEAD` (`id`);
  detached head → head `id` with `label: null`, still 200.
- default base = `git merge-base HEAD <branch>` with the first existing default
  branch (`origin/main`, `main`, `origin/master`, `master`); `id` is the full
  merge-base commit SHA and `label` is the branch name; none exist → `null`.
- branches = `git for-each-ref --format=%(objectname)%x00%(refname:short) refs/heads refs/remotes`.
- commits = `git log -n 20 --format=%H%x00%s`.

**jj mode (v1, head = working copy only):**
- head = `@`; `id` = **change id** of `@` (`jj log --no-graph -r @ -T 'change_id'`,
  session-key rule, D§4). Label `@ (working copy)`.
- default base = `trunk` bookmark if it exists (resolved to its commit id, `label: "trunk"`),
  else `@-` (resolved to its change id if mutable or commit id if immutable, `label: "@-"`).
- branches = `jj bookmark list -T 'name ++ "\0" ++ normal_target.commit_id() ++ "\n"'`
  (filtering out untracked/absent targets).
- commits = `jj log --no-graph -n 20 -T 'change_id ++ "\0" ++ commit_id ++ "\0" ++ description.first_line() ++ "\n"'`
  (`id` uses change id for mutable commits and commit id for immutable commits).

**Empty-data rule (binding):** any discovery gap (detached head, no
bookmarks, fresh repo with zero commits, no default branch) yields an empty
list / `null` in a **200** response. The API fails only on a structurally
invalid repo, which is caught at startup instead. The frontend shows an
informative message when `defaultBase` is null and no base candidates exist.

## 6. Ignore-file upkeep (D§3 row 0a, U§1.1.2)

At startup, ensure `.sky-watch/` is ignored:

- `.gitignore`: if no line matching `^\s*\.sky-watch/?\s*$` exists, append
  `\n.sky-watch/\n` (creating `.gitignore` with a trailing newline if missing;
  jj honors `.gitignore`).
- `.dockerignore`: **only if `.dockerignore` already exists**, perform the
  same check/append. Never create a new `.dockerignore` in a repo that does
  not have one (otherwise non-Docker repos get an untracked file that `jj`
  auto-snapshots into `@`).

Failures (read-only fs) → warning, continue.

## 7. Diff generation & parsing (`diff.ts`, D§3 row 1)

### 7.1 Generation

- git: `git diff --no-color --no-ext-diff --no-renames -U3 --end-of-options <base>...<head> --` —
  three-dot diff (diff against merge-base), matching the "default base = merge-base"
  semantics. Rename detection **off** (`--no-renames`): a rename is
  reviewed as delete + add (D§6 deliberate cut).
- jj: `jj diff --git --no-color --context 3 --from <base> --to <head>`. `--git`
  emits standard unified-diff format; parse identically. Note: jj's hunk
  headers may lack the funcname context git provides (see Open Questions).

The resolved stable revision IDs (`base` and `head`) and optional symbolic
ref names (`baseRef`, `headRef`, e.g. `"main"`, `"feature/x"`) are stored on
the `Session` so the diff can always be rebuilt and branch movement in git
mode can be detected (§13.1).

### 7.2 Parsing

Parse the unified diff into:

```ts
FileDiff {
  path: string            // canonical repo-relative path (new-side path, or oldPath when new-side is /dev/null)
  oldPath: string         // old-side path (repo-relative; equals path when not deleted/added)
  status: "modified" | "added" | "deleted"
  hunks: Hunk[]           // Hunk { header?: string, oldStart, newStart, oldLines, newLines, lines: DiffLine[] }
  binary: boolean
}
DiffLine { type: "ctx" | "add" | "del", oldLine?: number, newLine?: number, text: string }
```

For deleted files (`+++ /dev/null`), `path` falls back to `oldPath` (from
`--- a/<path>` or `diff --git a/<path> b/<path>`) so `path` is never
`"/dev/null"`. Binary files (`GIT binary patch` / `Binary files ... differ`)
→ `binary: true`, no hunks; UI shows a "binary file" placeholder.

## 8. Chunking into chapters (`chunker.ts`, D§3 row 2)

The interesting part; pure function, heavily tested.

**Input:** `FileDiff[]` (+ config). **Output:** `Chapter[]`.

Algorithm:

1. All hunks across all files are candidate units, ordered by `FileDiff.path`
   (alphabetical), then by position within the file.
2. A new chapter starts when any of:
   - the **function context within a file** changes — git hunk headers carry
     `@@ ... @@ <funcname>`; use it. When unavailable (jj, or git hunk
     without context), fall back to: blank-line/indentation heuristic on the
     hunk content, or simply position distance (> 30 unchanged lines
     between hunks → split).
   - the accumulated **size** would exceed the chapter target.
   Chapters **may span multiple files**: hunks are ordered by path then
   position; when no split rule fires, hunks of the next file continue the
   chapter as a further slice. Each file appears at most once per chapter
   (one contiguous slice), because the ordering groups a file's hunks.
3. Size accounting counts **changed lines** (`add` + `del`) across the
   chapter's hunks. Target: 50–100; hard max **200** (a single unbreakable
   hunk larger than 200 stays one chapter — never split a hunk).
4. **Keep-together rule:** hunks with the same `(file, funcname)` context
   stay in one chapter even if that pushes past `targetLines` (up to the
   `maxLines` hard max).
5. Chapter id = first 12 hex chars of `sha256(...)` over **all** the
   chapter's file slices, joined by `|`, each slice hashed as
   `${file}:${oldStart},${oldLines}->${newStart},${newLines}` — the
   "stable hash of file(s) + hunk ranges" (D§4). Including both
   `oldStart,oldLines` and `newStart,newLines` alongside the canonical `file`
   path guarantees unique IDs even for pure-deletion slices where
   `newStart = 0, newLines = 0`. Stable under re-running the chunker on an
   identical diff; breaks when the diff changes (accepted, D§11).

**Config knob:** chapter size limits live in `.sky-watch/config.json` under
`"review": { "targetLines": 75, "maxLines": 200 }` (see §16.3; Open
Question on whether a UI for this is ever needed — v1: file only).

## 9. Data model & session store (`store.ts`, D§4)

### 9.1 Session identity (binding, restated for implementers)

- `SessionId = "<base>..<head>"` where each side is the repo's **stable
  revision id**: git → full 40-char commit id; jj → **change id** for mutable
  changes (incl. `@`), commit id for bookmarks/immutable commits.
- Consequence to implement: in jj mode, rebuilding the diff on session open
  uses change ids, so working-copy saves and rebases show up as "same session,
  same key, changed diff" (`stale: true`); in git mode, commit ids are
  immutable so the session also records `baseRef` / `headRef` (e.g. `"main"`,
  `"feature/x"`), detects when `headRef` points to a new commit id, and runs
  the supersede flow (§13.2).
- Branch names at creation time go into `aliases` (and `baseRef` / `headRef`).

### 9.2 File layout & atomic writes

- One file per session: `.sky-watch/<sessionId>.json`.
- **Filename & CLI flag safety:** session ids from URLs, bodies, or imports
  are validated against
  `/^[0-9a-zA-Z][0-9a-zA-Z+-]*\.\.[0-9a-zA-Z][0-9a-zA-Z+-]*$/` before
  touching the filesystem or spawning CLIs — this prevents path traversal
  (the id contains `..` as a substring by design!), prevents leading-`-`
  CLI option injection into `git`/`jj`, and rejects junk ids.
- Saves are atomic: write `<sessionId>.json.tmp` → `fs.rename`.
- `list()` reads all files' lightweight headers (id, aliases, label,
  updatedAt, open-comment count, reviewed) — cache the header by mtime to
  avoid re-parsing everything on every `/api/sessions` call.

### 9.3 Schema

As D§4 (`Session`, `Chapter`, `Comment`, `Anchor`), with these concrete fields:

- `Session`: includes `base: string`, `head: string` (resolved stable IDs),
  `baseRef?: string`, `headRef?: string` (symbolic branch/bookmark names when
  known), `diffDigest: string` (sha256 of normalized diff text at build time),
  and `lastWriteAt: number` (bumped on every write; used for conflict check §9.4).
- `meta.repo` is display-only; **every** path anywhere (files, anchors,
  comments) is repo-relative.
- `Chapter`: may span multiple files (`files: FileSlice[]`, each
  `FileSlice { file: string, status: "modified"|"added"|"deleted",
  hunks: Hunk[] }`, at most one slice per file, in path order). **No legacy
  migration:** sessions persisted before this schema are treated as absent
  (`.sky-watch/` is derived cache; losing pre-multi-file sessions/comments
  is an accepted tradeoff).
- `Chapter.attention: LineMark[]` — `LineMark { file: string, side:
  "old"|"new", line: number, mark: "focus"|"glance"|"safe", markSource:
  "rules"|"llm" }` (`file` required: a multi-file chapter's line numbers are
  per-slice). Rules
  pass fills marks at session creation; LLM pass may overwrite `markSource:
  "rules"` marks without confirmation (only human data is protected; marks are
  always machine-owned).
- `Comment`: includes both `createdAt: number` and `updatedAt: number` (set to
  `createdAt` on creation and bumped on every `PATCH`), plus `orphaned?: boolean`.

### 9.4 Conflict handling (D§10)

Two tabs editing one session: every mutating request carries the client's
known `lastWriteAt`. Mismatch with the stored value → **409** with the
current session JSON; frontend warns "session changed elsewhere — reload?"
and offers reload (dropping the local edit is the user's call; no merge).

## 10. HTTP API (D§5, full contract)

All bodies JSON unless noted. All non-GET require `X-Sky-Eye: 1`.

| Route | Request | Response / behavior |
|---|---|---|
| `GET /api/sessions` | — | `[{ id, aliases, label, updatedAt, openComments, reviewed }]` |
| `GET /api/sessions/:id` | — | full stored `Session` plus computed `stale: boolean` (see §13.1) |
| `GET /api/refs` | — | §5 |
| `GET /api/tree?ref=&dir=[&recursive=1]` | — | `[{ name, type: "dir"|"file", path }]`; `dir` defaults to root; with `recursive=1` returns every *file* path at `ref`, flat (dirs derived by the client tree) — feeds the explorer's whole-repo `FileTree`, whose search needs the full path list; read from VCS object store at `ref`, repo-relative, contained (§11) |
| `GET /api/file?ref=&path=&side=` | — | `{ content, binary }`; read from VCS object store at `ref` (`side` selects base/head ref of the open session or a plain ref, §11) |
| `POST /api/sessions` | `{ base, head, baseLabel?, headLabel? }` | Resolves `base` and `head` to canonical stable IDs (§5/§9.1). If a session with `<base>..<head>` exists → **200 with the existing session** (no duplicate, U§1.5); else create: build diff, chunk, run rule classification, persist → `201` + `Session` |
| `POST /api/comments` | `{ sessionId, chapterId, file, side, line, text, priority? }` | `201` + `Comment`; server captures `anchor` from the session diff/VCS file (§12) |
| `PATCH /api/sessions/:id` | `{ label?, reviewed?, narrative?: { chapterId, text }, lastWriteAt }` | updated `Session`; when `narrative` is present, saves the chapter's `narrative` and sets `narrativeEdited: true` |
| `PATCH /api/comments/:id` | `{ sessionId, text?, resolved?, priority?, reanchor?: { chapterId, file, side, line }, lastWriteAt }` | updated `Comment` (bumps `updatedAt`); `resolved: true` stamps `resolvedAt`; `reanchor` captures a fresh server-side `anchor` and clears `orphaned` |
| `POST /api/sessions/:id/rerun` | `{ chapterId, confirm? }` | regenerates narrative + LLM marks for one chapter; if `narrativeEdited` → requires `{ confirm: true }` else **409** `{ error: "narrative edited", needsConfirm: true }`. First generation happens here too (lazy, D§6a) |
| `POST /api/sessions/:id/refresh` | — | §13; returns `{ session, supersededBy? }` |
| `GET /api/sessions/:id/export` | — | the raw session JSON as a download (`Content-Disposition: attachment`) |
| `POST /api/import` | session JSON body | merge into session with same id (§14) → merged `Session` |

## 11. File explorer (`tree.ts`, D§6b, U§2)

- `GET /api/tree`: list directory at `ref` from the VCS object store
  (`git ls-tree --end-of-options <ref> -- <dir>` / `jj file list -r <ref> -- <dir>`),
  return entries with repo-relative paths. `recursive=1` returns the flat
  list of every file path at `ref` instead (`git ls-tree -r --name-only`,
  `jj file list` is recursive already) — the explorer FileTree needs the
  full path list for search (§18.3); note git's `--end-of-options` makes a
  trailing `--` a pathspec for ls-tree, so the recursive form omits it.
- `GET /api/file`: read file blob at `ref` from the VCS object store
  (`git cat-file -p <ref>:<path>` / `jj file show -r <ref> -- <path>`),
  never from the live working tree on disk (so files deleted or moved in head
  still render cleanly on the `base` side).
- **Path & ref containment is mandatory:** validate `ref` against
  `/^[0-9a-zA-Z@][0-9a-zA-Z._/@+-]*$/` (no leading `-`); normalize `path`/`dir`
  with `path.posix.normalize` and reject (400) NUL bytes, backslashes, leading
  `/` or `-`, or paths that equal `..` or start with `../`.
- Read-only: no write endpoints exist, period.

## 12. Comments & anchors (D§4, D§6, U§4)

- Gutter click on a diff line → inline composer (designed at milestone M2,
  U§4 — layout already reserves the click target). Author from `identity.ts`
  (§15); missing config → `author: null` → UI shows "anonymous".
- **Server-side anchor capture:** when creating a comment (`POST /api/comments`)
  or re-pinning an orphan (`PATCH /api/comments/:id` with `reanchor`), the
  **server** reads the target file at the session's `head` (or `base` for
  `side: "old"`, falling back to the chapter's hunk lines) and extracts the
  pinned line's exact `text` plus up to 3 lines `before` and 3 lines `after`.
  Capturing anchors on the server guarantees full 3-line context even at hunk
  boundaries and avoids scraping highlighted DOM nodes in the browser. Editing
  a comment's `text`, `priority`, or `resolved` state preserves its existing
  `anchor` and bumps `updatedAt`.
- Old-side comments are stored normally but their anchors are expected to
  orphan on refresh (D§6 cut: old side is history, never remapped).

## 13. Refresh, remap, supersede (`remap.ts`, D§6, U§3.1)

### 13.1 Staleness detection

On every `GET /api/sessions/:id` the server checks whether the underlying
comparison has changed and returns the stored `Session` with `stale: boolean`
(**never auto-refresh**, D§6):

- **jj mode:** change ids survive working-copy edits and rebases, so the
  server rebuilds `jj diff --from <base> --to <head>` and compares its sha256
  digest against `session.diffDigest`. Different → `stale: true`.
- **git mode:** commit SHAs are immutable, so the server resolves the
  session's `headRef` (e.g. `refs/heads/feature`, falling back to `HEAD` when
  on the same branch) via `git rev-parse`. If `headRef` now resolves to a
  commit SHA different from `session.head`, `stale: true` is stamped.

### 13.2 The two flows

- **jj (key survives):** rebase preserves change ids → same session id,
  changed diff. `POST /api/sessions/:id/refresh` updates the session in place:
  rebuild diff + chapters, carry over matching unedited/edited narratives by
  chapter id, run the remap pass (§13.3), update `diffDigest`.
- **git (key breaks):** amend/rebase rewrites commit ids → `headRef` resolves
  to `<newHeadId>`, producing a new session id `<base>..<newHeadId>`.
  `POST /api/sessions/:id/refresh` creates the successor session (rebuild +
  remap carried over), sets `supersededBy: "<base>..<newHeadId>"` on the old
  session, and keeps the old file on disk as history. Opening a superseded
  session shows the banner and deep-links to the successor.

### 13.3 Remap pass (re-anchoring)

For each comment (new-side anchors only; old-side orphan immediately):

1. Fetch the file content at the **new head** from the VCS object store.
2. Find exact matches of `anchor.text` in the new content.
3. One candidate near the old line → candidate line wins. Multiple candidates
   → score each by (a) `before`/`after` context-line matches (weighted,
   ordered), (b) proximity to the old line; best wins, ties → nearest.
4. **Diff-hunk visibility check:** verify that the winning new-side line
   number falls inside a hunk of the rebuilt slice for `anchor.file` in the
   rebuilt `chapters` (a file's hunks may be split across several chapters —
   use the slice that contains the line). If it does, re-pin the comment
   (set `line`, `chapterId` of the chapter owning that slice, fresh `anchor`
   with updated `before`/`after`, `orphaned: false`).
5. If there is no match in the file **or** the matched line now sits outside
   all diff hunks in the rebuilt chapters → mark the comment **orphaned**
   (`orphaned: true`), keep the anchor, and surface it in the orphan triage
   banner so no open comment is ever hidden outside the rendered diff.

### 13.4 Orphan triage UI (U§3.1, D§6.3)

"N comments need re-pinning" banner on the session view. Per orphan: show
the comment + the new diff of that file → click a line to re-pin (sends
`PATCH /api/comments/:id` with `reanchor`, which writes a fresh server-side
anchor and clears `orphaned`), or resolve / wontfix (set `resolved: true`).

**Chapter rebuild on refresh:** chapters are re-chunked from the new diff;
their ids will differ when hunk ranges shift. Comments ride on content
anchors, not chapter ids — `chapterId` is re-derived from the matched hunk
during step 4. This is the D§11 risk, accepted.

## 14. Export / import (D§5, D§6)

- Export = the session file, byte-for-byte, as a download.
- Import: validate the JSON shape (and `SessionId` format §9.2), then merge
  into the stored session with the same id:
  - Comments matched by `id`; per comment, **newer `updatedAt` wins** (ties
    broken by `createdAt`); nothing is ever deleted.
  - Narratives: matched by `chapter.id`; imported `narrative` wins only if
    locally `!narrativeEdited` or imported `updatedAt` is newer — flag
    `narrativeEdited` travels in the export and is respected.
  - If the imported session's `diffDigest` differs from the local diff digest
    for that session (other machine had a rebased clone), run the remap pass
    (§13.3) after merging and surface the stale banner rather than silently
    mixing review state (D§3 row 5, D§6).
- Importing a session id that doesn't exist locally → validate, create it,
  and run staleness check on open.

## 15. Identity (`identity.ts`, D§7)

- Resolve once, cache in memory: `jj config get user.name` /
  `user.email` first, then `git config user.name` / `user.email`.
  **Verify the jj→git fall-through when building this** (D§11 last risk) —
  if `jj config get` errors rather than falling through, catch and fall
  through manually.
- Missing → `author: null` → "anonymous". No UI override in v1.

## 16. LLM layer (`llm.ts`, `narrate.ts`, `classify.ts`, D§3 rows 3/6, D§6a)

### 16.1 Config

`.sky-watch/config.json` (inside the ignored folder — keys never land in
git/jj/docker), exactly D§6a: `defaults` + per-task overrides for
`narrate` / `classify` (`apiKey`, `model`, `baseUrl`). Missing file or
missing key for a task → **task skipped, never blocks the session**
(narrative = "unanalyzed", marks = rules only).

### 16.2 Narrative firing & caching

- Lazily on first chapter expansion — `POST .../rerun { chapterId }` from
  the frontend when `narrative` is empty. Never eager at session creation.
- Prompt input: the chapter's unified diff text + ~10 lines of new-side
  context around each hunk + file paths + the list of other chapter titles.
- Output: short paragraph, stored in `Chapter.narrative`.
- `narrativeEdited` guard: re-run over an edited narrative requires
  confirmation (409 flow, §10).

### 16.3 Shared call with classification

When `narrate` and `classify` resolve to the same provider/model (same
`baseUrl`+`model` after config merge), one request carries both prompts and
expects JSON back: `{ "narrative": "...", "marks": [{ "side", "line",
"mark" }] }`. Different configs → two calls. LLM marks overwrite only
`markSource: "rules"` marks. Malformed LLM output → discard LLM part, keep
rules result (degrade, don't fail).

### 16.4 Rule pass (`classify.ts`) — v1 rules

Runs at session creation, no LLM needed:

- **safe:** test files (`*test*`, `*spec*`, `__tests__/`), lockfiles
  (`package-lock.json`, `Cargo.lock`, `uv.lock`, `pnpm-lock.yaml`, …),
  comment-only lines, `*.md`, generated paths (`*.min.js`, `dist/`, …).
- **focus:** security/money/async-sensitive paths (`auth/`, `*payment*`,
  `*token*`, `*secret*`) and lines touching `await`/`async`, `try`/`catch`/
  `throw`, crypto/password/permission/SQL keywords.
- **everything else:** glance.

## 17. Deep links (D§4, U§3.2)

Pure frontend routing over session data; no endpoint:

- `#<sessionId>/<chapterId>/<file>/<line>` — file path percent-encoded.
- `#<sessionId>/<commentId>`
- On load, resolve the fragment: fetch the session, scroll to + flash-
  highlight the target. Valid across export/import; break on rebase like
  everything session-keyed.

## 18. Frontend architecture (U§1.5–3.2)

Three views, hash-routed (`#` empty → first screen):

1. **First screen:** header (repo path + kind badge) → compare picker
   (head fixed per mode, base dropdown grouped: default base / bookmarks /
   branches / recent commits; default preselected) → "Create review" →
   existing-sessions list (label/aliases, `updatedAt`, open-comment count,
   reviewed chip). Creating an existing range opens the existing session.
2. **Session view:** header (editable label, aliases, open-comment count,
   reviewed toggle, actions: refresh / re-run / export, stale banner, orphan
   banner) → chapters as accordion, **expanded by default**; narrative as a
   plain editable text field above the diff (save → `narrativeEdited`); per-
   file headings; per chapter, a `@pierre/diffs` `FileDiff` (split style, one
   file) renders the two-column diff with hunks + context. Attention marks
   and comments attach through FileDiff's **line-annotation framework** (the
   same mechanism Pierre's own review UI uses) — no hand-built DOM overlays;
   gutter clicks use its selection API. Empty diff → "nothing to review"
   message.
3. **Explorer:** breadcrumb + head/base side toggle (sky-eye) around an
   `@pierre/trees` `FileTree` (directory navigation, search, git-status
   badges on changed files via `setGitStatus`); read-only file view rendered
   by `@pierre/diffs` `File` / `CodeView`. Changed files in chapters link here.

**Pierre adapter (`pierre-adapter.js`):** maps sky-eye's server JSON
(`Session`, `Hunk`, `DiffLine`, `LineMark`, `Comment`) onto the shapes
`FileDiff`/`FileTree` expect, and translates selection/annotation events
back into API calls. The only module that knows pierre's types.

Data flow: `api.js` wraps fetch (adds `X-Sky-Eye` on non-GET, propagates
409s); views re-render from fetched session JSON; no client state worth
syncing. Diff rendering is the perf-sensitive path — chaptering caps each
`FileDiff` at `maxLines` changed lines (§8, §22.5), which keeps renders small
without lazy expansion; `VirtualizedFileDiff` is the standing upgrade path.

## 19. Syntax highlighting (D§3 row 1a, D§6b)

- Provided by **`@pierre/highlights`** (WAT/WASM; 152 built-in languages;
  Zed-compatible themes; runs synchronously after import). No hand-rolled
  tokenizer — `public/highlight.js` is deleted in favor of it.
- In v1 sky-eye never calls the highlighter directly: `@pierre/diffs`
  highlights rendered diff hunks, file views, and code lines as part of its
  rendering, using a shared Shiki/highlights backend and theme. One engine,
  one theme, consistent colors across chapter diffs and explorer views.
- Theme: `@pierre/theme` drives diff + file coloring; sky-eye maps its CSS
  custom properties into app chrome (process.md foundations). Dark mode
  remains cut in v1, but the theming system makes it cheap later.
- Unknown extensions render as plain escaped text (pierre's default).
- An LSP backend remains a later upgrade, unchanged.

## 20. Testing strategy (D§8)

Priority order — "chunker + remap first, that's where the bugs live":

1. **`chunker.test.ts`** — pure fixtures: size limits, keep-together,
   function-boundary splits, unbreakable oversized hunk, deleted files
   (no `/dev/null` ID collision), empty diff.
2. **`remap.test.ts`** — anchor scoring: exact match near old line, multiple
   candidates, match outside new diff hunks → orphan, no match → orphan,
   old-side anchors orphan immediately.
3. **`diffparse.test.ts`** — unified-diff parsing edge cases (no newline at
   EOF, binary, deleted file `+++ /dev/null`, hunk without funcname).
4. **`integration.test.ts`** — create a temp git repo, commit base + head,
   run server handlers against it: refs discovery, tree/file explorer
   (including deleted file on `base` side), session create, comment add +
   resolve, narrative edit save, export → import merge (`updatedAt` wins),
   refresh/supersede after `git commit --amend`.

All pure logic is kept dependency-free (spawn CLIs only at integration
boundaries) so tests stay fast.

## 21. Milestones → deliverables & acceptance criteria

The docs' 7 milestones (D§9), made concrete. Each ends in a demoable state.

**M1 — Spine.** Deliver: `main.ts` startup (`127.0.0.1` bind) + security +
ignore upkeep; `refs.ts`; `tree.ts` (`/api/tree`, `/api/file`); `diff.ts`;
`chunker.ts` (basic size splitting); session store; `POST/GET/PATCH sessions`;
first screen + session view with chaptered two-column diff + file explorer
view + syntax highlighting — all rendering via the `@pierre/*` bundles (§18,
§19); binary/empty-diff handling.
*Accept:* run `sky-eye` in a git and a colocated jj repo; pick base; see
highlighted chapters and browse repo files at base/head; edit narrative/label
and reload; a second browser tab cannot CSRF mutations; `.sky-watch/` ignored
without creating `.dockerignore` in non-Docker repos.

**M2 — Comments.** Deliver: composer UI, `identity.ts`, `POST/PATCH
comments`, resolve, counters, server-side anchor capture on create/re-pin,
deep links (`#sessionId/...`, §17).
*Accept:* comment, resolve, copy/open deep link, reload — all persist with
correct author; anchors stored with 3-line before/after context even at hunk
edges.

**M3 — Rebase survival.** Deliver: staleness detection (jj diff digest + git
`headRef` resolution), refresh flow (both modes), `remap.ts` (including
diff-hunk visibility check), orphan triage banner, supersede handling.
*Accept:* in a jj repo, rebase the working copy → banner → refresh →
comments re-pinned; amend a git commit → stale banner → refresh → new
session, old marked superseded, comments carried and editable.

**M4 — Chunker tuning.** Deliver: function-boundary detection, keep-together
rules, `review` config knob. *Accept:* fixture suite green; manual review of
a real 500-line diff reads sensibly.

**M5 — Rule-based attention marks.** Deliver: `classify.ts` rules + line
marking UI. *Accept:* test files/lockfiles show safe; a touched auth line
shows focus.

**M6 — Export/import.** Deliver: export download, import + merge (`updatedAt`
wins per comment) + digest re-verification + remap-on-mismatch. *Accept:*
export from repo A, resolve/edit in repo B, re-import into A or a rebased
clone → edits/resolutions kept, comments re-anchor or orphan correctly,
nothing lost.

**M7 — LLM narratives + refined classification.** Deliver: `llm.ts`,
`narrate.ts`, shared-call optimization, config file, lazy firing,
`narrativeEdited` guard, re-run confirm. *Accept:* no config → everything
still works rules-only; with config → narratives on first expansion, cached,
editable, re-run asks before overwriting edits.

## 22. Open questions

Genuine gaps the docs don't settle — decide or verify when the relevant
milestone starts:

1. **jj hunk headers lack funcname context** — RESOLVED (verified at M3 on
   jj 0.46): `jj diff --git` emits `@@ ... @@ <funcname>` just like git
   (e.g. `@@ -1,9 +1,10 @@ fn a() {`), so the chunker's function-boundary
   rule (§8.2) works in jj mode with no fallback needed.
2. **LLM protocol confirmation.** OpenAI-compatible chat completions is
   assumed (fits `baseUrl`/`model`/`apiKey`). Confirm which providers the
   user actually wants; Anthropic-native APIs differ enough to matter.
   Also: blocking request vs streaming for narrative generation — v1
   assumes blocking (one paragraph, seconds), revisit if slow models annoy.
3. **Chapter-id instability on every diff change.** Any diff change (not
   just rebases — even new commits on top) rebuilds chapters and thus
   chapter ids. Comments survive via content anchors, but deep links and
   the "other chapter titles" prompt context churn. Accept as documented
   (D§11), or consider making chapter ids hash only the file + hunk
   *content*, not line ranges — cheap to change now, expensive later.
4. **Default port & configurability.** 4800 assumed from U§1.1's example.
   Should there be a `--port` flag / env var, or is scan-upward enough?
5. **Large diffs.** RESOLVED at M4: chaptering *is* the virtualization —
   each chapter renders as one pierre `FileDiff` instance capped at `maxLines`
   (200) changed lines, so no single render is ever huge. No `FileDiff` →
   `VirtualizedFileDiff` swap and no lazy expansion in v1; sessions with many
   chapters render eagerly. Upgrade path if a real diff is observed crawling:
   swap the component in the adapter (same input shape), one line.
6. **Base-side semantics for user-picked bases.** Default base uses
   merge-base semantics (`base...head`). When the user picks an arbitrary
   commit as base, is that also three-dot, or literal two-dot? Three-dot
   everywhere is the least surprising — confirm intent.
7. **jj change-id uniqueness scope.** Change ids are only unique within a
   repo *and can be re-issued after `jj abandon`* in principle. Session
   collision (two different diffs, same change-id key) is vanishingly rare
   but nonzero — accept, or add the commit id to the stored meta for
   display disambiguation.
8. **Refresh for base-side changes.** D§6 cuts "base-commit-change
   remapping". If the *base* moves (e.g. trunk advanced), the diff changes
   shape but head didn't — is that "stale"? v1 answer: no banner (head
   digest only); revisit if it bites.
9. **Windows support.** Startup uses `xdg-open`/`open`; paths are
   repo-relative but the server runs on posix assumptions. Explicitly
   out of scope v1, or handle `win32` in `main.ts` for cheap?
