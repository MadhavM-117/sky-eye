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
images, PR-provider integration, LSP highlighting, shortcuts (in-diff hunk jumping — chapter-level navigation and the focus
view do exist, §18.2), dark mode, per-session identity override,
session file locking
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
│   ├── narrate.ts            # LLM narrative + shared classification refinement + chapter ordering
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

- git: `git -c diff.mnemonicPrefix=false diff --no-color --no-ext-diff --no-renames -U3 --end-of-options <base>...<head> --` —
  three-dot diff (diff against merge-base), matching the "default base = merge-base"
  semantics. Rename detection **off** (`--no-renames`): a rename is
  reviewed as delete + add (D§6 deliberate cut). `diff.mnemonicPrefix=false`
  overrides a user config that would emit `c/`/`i/`/`w/` path prefixes and
  silently break parsing (§7.2 expects `a/`/`b/`).
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

## 8a. Semantic chunking (`tasks.chunk`, task 019)

When the LLM config resolves a `chunk` task adapter (same model as
narrate/classify, §16.1), the rebuild pipeline (`chaptersFromDiff`, shared by
creation, refresh and supersede) groups hunks **semantically**: one blocking
LLM call — grouping, titles and the analysis are one step (user decision).

Algorithm (`src/semantic-chunk.ts`):

1. **Inventory (pure):** all hunks get ids `h0…hN-1` in path-then-position
   order; each entry carries file, status, funcname (§8.2 header), ranges,
   changed-line count, and the hunk's changed-line text **capped at 40 lines**
   (elision marker beyond). An inventory over a size budget (> 2000 hunks or
   > 400 KB of text) skips the semantic pass entirely — chunking a monster
   diff semantically is worse than the heuristic.
2. **One LLM call** — reply is ONLY JSON:
   `{ "chapters": [{ "title": "...", "hunks": ["h0", "h3"] }] }`. The model
   is told to make each chapter one semantic change, order chapters in
   review-reading order, and keep ~50–100 changed lines per chapter, never
   over `maxLines`.
3. **Validation (pure):** a hunk id must exist and is used at most once
   (duplicates: first group wins); unknown ids and empty titles are dropped;
   titles are trimmed and capped at 80 chars.
4. **Guardrails:** chapters are built as FileSlices per file in path order
   (§8 shape unchanged); a group over `maxLines` changed lines is re-split by
   the pure chunker (§8) on its own hunks — never split an individual hunk,
   every chapter stays ≤ `maxLines` (the renderer's virtualization guarantee,
   §22.5); the title applies only to the first re-split chapter. Hunks the
   model missed (or a fully failed grouping) fall through to the pure
   chunker, appended at the end.
5. **Chapter ids** keep the §8.5 formula; chapter **order** is the model's
   returned order (semantic reading order) instead of path order — pure-chunked
   sessions fall through to the ordering pass (§16.7) or, with no LLM
   configured, path order.

**Degradation (§16.1 rule extended):** no config, failed/malformed call, or
oversized inventory → the pure chunker, unchanged. A session is never blocked
on the LLM layer. Chapter creation is as slow as the full analysis (chunk
call + per-chapter narratives, §16.2) when configured — accepted; the UI
shows an "analyzing…" loader with per-chapter progress during creation
(U§1.5).

**Determinism (resolved, task 019):** the grouping is model-derived, so
§8.5's "stable under re-running on an identical diff" holds only for the pure
chunker. Accepted: nothing re-chunks an unchanged diff within a session's
life — refresh/supersede own diff changes, rerun-all (§16.6) explicitly never
re-chunks, and the explicit re-chunk endpoint below is user-initiated.

**Re-chunk endpoint:** `POST /api/sessions/:id/rechunk` rebuilds the grouping
in place on the stored diff (semantic when configured, else pure), carries
narratives and viewedFiles over by chapter id, generates narratives for chapters without a
carried-over one (§16.2), re-runs the ordering pass (§16.7), and remaps
comments (§13.3); any edited
narrative → the usual 409 `needsConfirm` gate (§10).

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

- One file per session: `.sky-watch/<sessionId>.json`. Archived sessions
  move to `.sky-watch/archive/<sessionId>.json` (same format; not openable
  in place — restore first, §10). Generated logs live in
  `.sky-watch/logs/` (§16.5). Both are subdirectories, so `list()`
  (non-recursive) only ever sees active sessions.
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
  hunks: Hunk[] }`, at most one slice per file, in path order).
  `title?: string` — one-line semantic description set by the chunk task
  (§8a); absent from pure-chunked chapters; feeds the chapter rail row and
  the classifier/narrate context. **No legacy
  migration:** sessions persisted before this schema are treated as absent
  (`.sky-watch/` is derived cache; losing pre-multi-file sessions/comments
  is an accepted tradeoff).
- `Chapter.viewedFiles: string[]` — repo-relative paths of the chapter's
  file slices marked viewed, persisted as an exact list (always a subset of
  the slice paths — the PATCH handler drops anything else, §10). A chapter
  **counts as viewed when every slice path is listed** — derived wherever
  displayed, never stored separately. Marking a chapter viewed lists all its
  slice paths; marking a file viewed adds its path. Viewed state is per
  `(chapter, file)` slice: a file whose hunks span two chapters is viewed
  per chapter. The session-level `reviewed` flag stays a manual toggle —
  no auto-derivation from chapters (revisit if wanted).
- `Chapter.attention: LineMark[]` — `LineMark { file: string, side:
  "old"|"new", line: number, mark: "focus"|"glance"|"safe", markSource:
  "rules"|"llm"|"custom" }` (`file` required: a multi-file chapter's line
  numbers are per-slice; `mark` uses the canonical vocabulary but is
  extensible — custom classifiers (§16.5) may emit other names, rendered as
  a neutral glyph: the name's initial in the muted color (readable, no
  canonical semantics; a bare dot was invisible in dark mode — task 013). Rules
  pass fills marks at session creation; the classifier pass (§16.5 — exec
  hook or built-in backend) overrides marks per line with
  `markSource: "custom"`; LLM pass may
  overwrite `markSource: "rules"` marks without confirmation (only human
  data is protected; marks are always machine-owned).
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
| `GET /api/sessions` | — | `[{ id, aliases, label, updatedAt, openComments, reviewed }]`; `?archived=1` lists `.sky-watch/archive/` instead (same header shape) |
| `GET /api/sessions/:id` | — | full stored `Session` plus computed `stale: boolean` (see §13.1) |
| `GET /api/refs` | — | §5 |
| `GET /api/tree?ref=&dir=[&recursive=1]` | — | `[{ name, type: "dir"|"file", path }]`; `dir` defaults to root; with `recursive=1` returns every *file* path at `ref`, flat (dirs derived by the client tree) — feeds the explorer's whole-repo `FileTree`, whose search needs the full path list; read from VCS object store at `ref`, repo-relative, contained (§11) |
| `GET /api/file?ref=&path=&side=` | — | `{ content, binary }`; read from VCS object store at `ref` (`side` selects base/head ref of the open session or a plain ref, §11) |
| `POST /api/sessions` | `{ base, head, baseLabel?, headLabel? }` | Resolves `base` and `head` to canonical stable IDs (§5/§9.1). If a session with `<base>..<head>` exists → **200 with the existing session** (no duplicate, U§1.5); else create: build diff, chunk, run the full analysis pipeline (rules marks → classifier → narrative/LLM marks → ordering, §16.2/§16.6/§16.7), persist → `201` + `Session` |
| `POST /api/comments` | `{ sessionId, chapterId, file, side, line, text, priority? }` | `201` + `Comment`; server captures `anchor` from the session diff/VCS file (§12) |
| `PATCH /api/sessions/:id` | `{ label?, reviewed?, narrative?: { chapterId, text }, viewedFiles?: { chapterId, files: string[] }, lastWriteAt }` | updated `Session`; when `narrative` is present, saves the chapter's `narrative` and sets `narrativeEdited: true`; when `viewedFiles` is present, replaces that chapter's `viewedFiles` (unknown chapterId → 404; paths intersected with the chapter's slices — the client sends the full toggle list, computed per ux §3.2) |
| `PATCH /api/comments/:id` | `{ sessionId, text?, resolved?, priority?, reanchor?: { chapterId, file, side, line }, lastWriteAt }` | updated `Comment` (bumps `updatedAt`); `resolved: true` stamps `resolvedAt`; `reanchor` captures a fresh server-side `anchor` and clears `orphaned` |
| `POST /api/sessions/:id/rerun` | `{ chapterId, confirm? }` | regenerates narrative + LLM marks for one chapter (sessions are analysed at creation, §16.2; this is manual regeneration); if `narrativeEdited` → requires `{ confirm: true }` else **409** `{ error: "narrative edited", needsConfirm: true }` |
| `POST /api/sessions/:id/rerun-all` | `{ confirm? }` | regenerates everything in place (§16.6): rules marks + classifier pass + narrative/LLM marks for **every** chapter; any edited narrative → same 409 `needsConfirm` gate as above |
| `POST /api/sessions/:id/rechunk` | `{ confirm? }` | re-runs the chapter grouping in place on the stored diff (semantic when `tasks.chunk` is configured, §8a; else pure §8); carries narratives and viewedFiles by chapter id, remaps comments (§13.3); any edited narrative → 409 `needsConfirm` gate as above |
| `POST /api/sessions/:id/archive` | — | moves the session file to `.sky-watch/archive/` (§9.2); leaves the active list, subsequent loads → 404 |
| `POST /api/sessions/:id/unarchive` | — | moves an archived session back to the active list |
| `DELETE /api/sessions/:id` | — | permanently deletes the session file, active or archived |
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
  rebuild diff + chapters, carry over matching unedited/edited narratives and
  viewedFiles by chapter id, generate narratives for chapters without a
  carried-over one (eager rule, §16.2), run the remap pass (§13.3), update
  `diffDigest`.
- **git (key breaks):** amend/rebase rewrites commit ids → `headRef` resolves
  to `<newHeadId>`, producing a new session id `<base>..<newHeadId>`.
  `POST /api/sessions/:id/refresh` creates the successor session (rebuild +
  remap carried over), sets `supersededBy: "<base>..<newHeadId>"` on the old
  session, and keeps the old file on disk as history. Opening a superseded
  session shows the banner and deep-links to the successor.

**Viewed carry-over:** `viewedFiles` ride the same chapter-id matching as
narratives in every rebuild flow (refresh and supersede here, re-chunk §8a):
a rebuilt chapter with an unchanged id keeps its `viewedFiles`, any other
starts unviewed (ids hash hunk ranges, §8.5).

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
    locally `!narrativeEdited` (a locally edited narrative is never
    overwritten — chapters carry no timestamp, so there is nothing newer to
    compare; the `narrativeEdited` flag travels in the export and is
    respected). Chapters themselves are diff-derived and stay local.
  - Session-level fields (label, reviewed) and per-chapter `viewedFiles` are
    not merged — only comments and narratives are user state the spec merges
    (§14 scope); viewed progress stays local, like `reviewed`.
  - If the imported session's `diffDigest` differs from the local diff digest
    for that session (other machine had a rebased clone), run the remap pass
    (§13.3) after merging and surface the stale banner rather than silently
    mixing review state (D§3 row 5, D§6).
- Importing a session id that doesn't exist locally → validate, create it
  (verbatim), and run staleness check on open.
- Export/import UI: the session header carries an `export` link (the
  route's `Content-Disposition` triggers the download); the first screen
  carries an `import` button that POSTs the picked file's JSON and opens
  the merged session (U§3.1, designed at M6 per U§4).

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
`narrate` / `classify` / `chunk` (`apiKey`, `model`, `baseUrl`, `provider`, plus
`command` / `timeoutMs` for the custom adapter — §22.2); plus `classifier`
(classifier pass: `command` (exec hook), or built-in backends — `builtin:
"openrouter"` + `model` (e.g. typesafe/jev-1.14) via OpenRouter — plus
`apiKey` (falls back to
`OPENROUTER_API_KEY` env, then the llm `defaults` key), `baseUrl`,
`instructions`, and `criteria` (mark NAME → criteria description; keys are
the mark vocabulary, default = the rules buckets) — §16.5), and
`classifyRules` (`safePaths` / `focusPaths` globs extending the built-in
buckets — §16.4). Missing file or
missing key for a task → **task skipped, never blocks the session**
(narrative = "unanalyzed", marks = rules only).

### 16.2 Narrative generation — eager, at build time

- **Every chapter is analysed before the session is shown.** The generation
  pass runs as the final step of every pipeline that (re)builds chapters —
  session creation (§10), refresh/supersede (§13.2), re-chunk (§8a) — so a
  served session is always fully analysed: narrative + LLM marks for every
  chapter, in addition to the rule pass. `POST .../rerun { chapterId }`
  remains for manual regeneration only.
- **Never blocks on the LLM layer (§16.1 rule):** no config, or a
  failed/malformed call for a chapter → that chapter stays "unanalyzed"
  (rules marks only) and the pipeline still completes; the UI shows an
  indeterminate "analyzing…" banner (ux §1.5; per-chapter live progress
  deferred until creation latency earns it). Creation is as slow as the full analysis
  (chunk call + one narrate call per chapter, or the shared call, §16.3) —
  accepted; the one-chapter-at-a-time view (ux §3.3) needs the analysis up
  front to be readable.
- Prompt input: the chapter's diff across **all** its file slices (§8) +
  ~10 lines of new-side context around each hunk + file paths + the list of
  other chapter titles (semantic titles from the chunk task when present,
  §8a; else the file list).
- Output: short paragraph, stored in `Chapter.narrative`; cached in the
  session file (generated once per chapter build).
- `narrativeEdited` guard: re-run over an edited narrative requires
  confirmation (409 flow, §10); the eager pass never overwrites anything —
  it only fills chapters that have no narrative yet.

### 16.3 Shared call with classification

When `narrate` and `classify` resolve to the same adapter (same
`provider`+`baseUrl`+`model`, or the same custom `command`, after config
merge), one request carries both prompts and
expects JSON back: `{ "narrative": "...", "marks": [{ "file", "side",
"line", "mark" }] }` — `file` because chapters span files since the
multi-file model (§8). Different configs → two calls. LLM marks overwrite only
`markSource: "rules"` marks (custom-classifier marks are equally protected).
Malformed LLM output → discard LLM part, keep
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

The built-in buckets are user-extensible via `classifyRules` (`safePaths` /
`focusPaths` globs, §16.1); a configured custom classifier (§16.5) overrides
rule marks per line.

### 16.5 Classifier pass (exec hook + built-in backends)

The classifier pass runs at every chapter rebuild (creation, refresh,
supersede) — the same moments as the rule pass. Two backends share one
merge/fallback/log path; `classifier.command` (exec hook) wins when both
are configured.

**Exec hook** — when `classifier.command` is set, sky-eye spawns it.
Request/response JSON on stdin/stdout (`protocol: 1`): chapters with their
changed lines — plus the chapter's semantic `title` when present (§8a,
additive field; hooks may ignore it) — in; sparse `marks` out, overriding
rules marks per `(file, side, line)` with `markSource: "custom"`; unmarked
lines keep rules marks. Invalid entries are dropped.

**Built-in backends** — when `classifier.builtin: "openrouter"` (+
`model`) is set, sky-eye itself classifies via **OpenRouter's
decision-model API** (`POST
{baseUrl:-https://openrouter.ai/api}/alpha/decisions`); any model served by
it works — out of the box: typesafe's **jev** (`typesafe/jev-1.14`),
one request per rebuild, one `choice` question per changed line, criteria =
the configured `criteria` map (mark names = keys, descriptions = values;
default = the rules buckets), diff rendered as `state` — with the chapter's
semantic title (§8a) prefixed to its `state` block and appended to its
questions' instructions when present. API key: `apiKey` →
`OPENROUTER_API_KEY` env → llm `defaults` (one OpenRouter key serves both
tasks). Responses answer at `answers[<qKey>].choice`.

**Shared semantics** — a failed run (non-zero exit, timeout, HTTP error,
malformed output) falls back to rules marks unless
`classifier.fallback: false`, in which case marks are cleared. Every run
logged to `.sky-watch/logs/classifier.log`, overwritten per run — only the
most recent run is kept (user decision, task 016; full transcript with
`classifier.debug`);
`sky-eye debug-classify <sessionId>` replays the configured backend against
a stored session and prints the transcript.

### 16.6 Regenerate all (`rerun-all`)

`POST /api/sessions/:id/rerun-all` re-runs the generation pipeline in place
on the stored diff: rules marks (§16.4) rebuilt per chapter, classifier pass
(§16.5) re-applied, then narrative + LLM marks for every chapter — the same
per-chapter logic as §16.2/§16.3. The stored diff/hunks are **not**
re-generated: refresh (§13) is the tool when the underlying diff changed;
rerun-all is for marks/narratives only. Chapter ids don't move (same diff →
same ids, §8.5). Edited narratives are machine-overwritten only after
`{ confirm: true }` — the UI asks once for all chapters, not per chapter.
Re-grouping the chapters themselves is the separate re-chunk endpoint
(§8a); rerun-all still never re-chunks.

### 16.7 Chapter ordering

Chapter order is part of the analysis: it must aid reading, not follow the
diff's alphabetical path order.

- **Semantic chunking configured (§8a):** the chunk call already returns
  chapters in review-reading order — no extra step.
- **Pure-chunked session with an LLM configured (any of narrate/classify):**
  one cheap ordering call over the chapter list — input is each chapter's
  id, title (or file list), changed-line count and file statuses; output is
  ONLY the chapter ids in review-reading order. Validation (pure): the
  reply must be a permutation — unknown/duplicate ids dropped (first wins),
  chapters the model missed keep path order, appended at the end. The
  stored `chapters` array is physically reordered.
- **No LLM configured:** path order (deterministic fallback).
- Failed/malformed ordering call → path order (degrade, don't fail, §16.1).
  Refresh/re-chunk re-run the pass for the new chapter set; narratives are
  carried by chapter id, so ordering churn does not lose them.
- The chapter rail (ux §3.3) and the "other chapter titles" prompt context
  (§16.2) both follow the stored order.

## 17. Deep links (D§4, U§3.2)

Pure frontend routing over session data; no endpoint:

- `#<sessionId>/<chapterId>/<file>/<line>` — file path percent-encoded.
- `#<sessionId>/<commentId>`
- On load, resolve the fragment: fetch the session, open the focus view
  (§18.2) on the owning chapter when the target is a chapter, file/line, or
  comment, scroll to + flash-highlight the target. Valid across
  export/import; break on rebase like everything session-keyed.

## 18. Frontend architecture (U§1.5–3.2)

Three views, hash-routed (`#` empty → first screen):

1. **First screen:** header (repo path + kind badge) → compare picker
   (head fixed per mode, base dropdown grouped: default base / bookmarks /
   branches / recent commits; default preselected) → "Create review" →
   existing-sessions list (label/aliases, `updatedAt`, open-comment count,
   reviewed chip). Creating an existing range opens the existing session.
   Below the list: archived reviews (§10 archive routes) with restore +
   delete; restore moves a review back into the active list, delete
   (confirmed) removes it permanently.
2. **Session view:** header (editable label, aliases, open-comment count,
   reviewed toggle, actions: refresh / re-run / regenerate all (§16.6) /
   export / archive / delete, stale banner, orphan
   banner) → **one chapter at a time**, navigated by the chapter rail
   (below); narrative as a
   rendered markdown view above the diff (stored as markdown text verbatim,
   HTML-escaped before rendering — never raw HTML), editable only via an
   edit button that swaps in a textarea prefilled with the current markdown
   (save → `narrativeEdited`); while the LLM analysis runs, a loading
   indicator replaces the view and the edit button is hidden; a chapter-
   viewed toggle in the chapter header (marks all files viewed, §9.3);
   per-file headings are accordion headers — clickable to collapse/expand
   the block, each carrying the file's viewed checkbox (a viewed file
   renders collapsed; collapse itself is ephemeral, ux §3.2); per chapter,
   a `@pierre/diffs` `FileDiff` (split style, one file) renders the
   two-column diff with hunks + context. Comments attach
   through FileDiff's **line-annotation framework** (annotation rows under
   the line) — no hand-built DOM overlays; gutter clicks use its selection
   API. Attention marks do **not** occupy annotation rows: they render as
   one colored glyph per marked line in the diff's gutter column (beside
   the line numbers) via FileDiff's `onPostRender` hook — a post-render
   decoration pass, swept and re-stamped on every repaint including
   virtualized scroll — so a mark adds no vertical space and large MRs stay
   readable (task 009; full plan `tmp/plans/marks-column/plan.md`). Custom
   classifier names render as the name's initial in the muted color (§9.3,
   task 013). Empty diff → "nothing to review" message.
3. **Explorer:** breadcrumb + head/base side toggle (sky-eye) around an
   `@pierre/trees` `FileTree` (directory navigation, search, git-status
   badges on changed files via `setGitStatus`); read-only file view rendered
   by `@pierre/diffs` `File` / `CodeView`. Changed files in chapters link here.

**Chapter rail (ux §3.3):** the session body shows **one chapter at a
chapter at a time**; a collapsible rail left of the body is the navigation.

- One row per chapter: title (`Chapter.title`, §9.3, else file-list
  fallback), one-line narrative description (first line, or "unanalyzed"),
  and a change summary `N files · +x −y` — the line counts computed
  client-side by counting `add`/`del` `DiffLine`s across the chapter's
  slices.
- The active chapter's row is highlighted and nests its file list (path,
  viewed ✓ when the slice path is in `viewedFiles`, status glyph from
  `FileSlice.status`, per-slice `+x −y`; the chapter row shows ✓ when all
  its files are viewed); clicking a file
  scrolls to that file's diff block (same scroll-and-flash as deep links,
  §17); prev/next chapter controls move between chapters; opening a session
  starts at the first chapter.
- Deep links (§17) targeting a chapter, file/line, or comment open the
  owning chapter, then scroll to the target.

All of it is computed from the session JSON already fetched — no new
endpoints, no schema change — and rendered as plain DOM (the pierre
isolation rule is untouched; a chapter's 1–3 files don't warrant a
`FileTree`). Only the active chapter's `FileDiff` instances are mounted,
which also settles the eager-render concern below.

**Pierre adapter (`pierre-adapter.js`):** maps sky-eye's server JSON
(`Session`, `Hunk`, `DiffLine`, `LineMark`, `Comment`) onto the shapes
`FileDiff`/`FileTree` expect, and translates selection/annotation events
back into API calls. The only module that knows pierre's types.

Data flow: `api.js` wraps fetch (adds `X-Sky-Eye` on non-GET, propagates
409s); views re-render from fetched session JSON; no client state worth
syncing. Diff rendering is the perf-sensitive path — chaptering caps each
`FileDiff` at `maxLines` changed lines (§8, §22.5), which keeps renders small
without lazy expansion; `VirtualizedFileDiff` is the standing upgrade path.
(With the one-chapter-at-a-time body, ux §3.3, only the active chapter's
`FileDiff`s are mounted in the first place.)

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
1a. **`semantic-chunk.test.ts`** — pure fixtures (§8a): inventory build
   (ids, funcname, 40-line cap), response validation (duplicate hunk id
   first-wins, unknown ids, title capping, malformed JSON throws),
   `buildChapters` (slice shape, maxLines re-split, leftovers via pure
   chunker, id formula unchanged), prompt-size circuit breaker.
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

**M5.1 — Custom classifier hook.** Deliver: config block, exec protocol,
merge/fallback semantics, `classifier.log`, `debug-classify`. *Accept:*
demo repo with a scripted classifier → session creation shows
`markSource: "custom"` marks; broken classifier → rules fallback (or
cleared with `fallback:false`); `debug-classify` prints the transcript.

**M5.2 — Built-in classifier (OpenRouter decision API).** Deliver:
`classifier` config built-in branch
(`builtin`/`model`/`apiKey`/`baseUrl`/`instructions`/`criteria`), the
OpenRouter decision backend (`decisions.ts`) — jev
(`typesafe/jev-1.14`) supported out of the box,
backend-shared fallback/log/debug semantics. *Accept:* openrouter + key
config →
per-line AI marks at session creation with user-chosen mark names/criteria;
missing key or HTTP failure → rules fallback (or cleared with
`fallback:false`); run in `classifier.log`; `debug-classify` prints the
HTTP transcript; exec-hook configs behave exactly as before.

**M6 — Export/import.** Deliver: export download, import + merge (`updatedAt`
wins per comment) + digest re-verification + remap-on-mismatch. *Accept:*
export from repo A, resolve/edit in repo B, re-import into A or a rebased
clone → edits/resolutions kept, comments re-anchor or orphan correctly,
nothing lost.

**M7 — LLM narratives + refined classification.** Deliver: `llm.ts`,
`narrate.ts`, shared-call optimization, config file, eager analysis
(chapters fully analysed at creation, §16.2) + ordering pass (§16.7),
`narrativeEdited` guard, re-run confirm. *Accept:* no config → everything
still works rules-only (chapters stay "unanalyzed", order falls back to
path); with config → a new session opens fully analysed, chapters in
reading order, narratives cached,
editable, re-run asks before overwriting edits.

## 22. Open questions

Genuine gaps the docs don't settle — decide or verify when the relevant
milestone starts:

1. **jj hunk headers lack funcname context** — RESOLVED (verified at M3 on
   jj 0.46): `jj diff --git` emits `@@ ... @@ <funcname>` just like git
   (e.g. `@@ -1,9 +1,10 @@ fn a() {`), so the chunker's function-boundary
   rule (§8.2) works in jj mode with no fallback needed.
2. **LLM protocol confirmation.** RESOLVED (user decision at M7, 2025-06):
   three adapters ship — OpenAI-compatible chat completions (default),
   native Anthropic `/v1/messages` (selected via `provider: "anthropic"`),
   and a custom exec adapter (`command` in the task config: JSON
   `{ protocol, task, model, system, prompt }` on stdin, `{ "text" }` on
   stdout — same spirit as the classifier hook §16.5). Requests are
   **blocking** in v1 (one paragraph, seconds); streaming is deferred to a
   future task — revisit if slow models annoy.
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
   `VirtualizedFileDiff` swap and no lazy expansion in v1; with the
   one-chapter-at-a-time body (ux §3.3) only the active chapter's diffs
   are mounted anyway. Upgrade path if a real diff is observed crawling:
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
