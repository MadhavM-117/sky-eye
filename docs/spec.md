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
| Frontend framework | **None.** Vanilla ES modules, no build step | Per D§2. The UI is one session view + a tree browser + a first screen; a framework buys nothing and costs the build step. |
| Diff source | **Shell out to the `git` / `jj` CLI**, parse unified diff output | No libgit2/nodegit. The tool already assumes both CLIs exist. |
| LLM access | **OpenAI-compatible `POST {baseUrl}/chat/completions` via `fetch`** | Matches the config schema's `baseUrl`/`model`/`apiKey` (D§6a); covers OpenAI, Anthropic-compatible gateways, ollama, llama.cpp. No SDK dependency. |
| Syntax highlighting | **`web-tree-sitter` (WASM) in the browser**, grammars vendored as `.wasm` files under `public/grammars/` | Per D§6b. Vendored = no CDN dependency, works offline. |
| Test runner | **`node:test`** (built-in) | Zero dev dependencies; the tests are pure-function fixtures (D§8). |
| Distribution | npm package with a `bin` entry (`sky-eye`), run inside any repo; server resolves the repo from `process.cwd()` | D/U§1.1: "user runs `sky-eye` inside a repository". |

Package runtime dependencies: **none**. Dev dependencies: `typescript` only
(plus optionally `tsx`). `web-tree-sitter` is browser-side; its runtime
`web-tree-sitter.wasm` and grammar `.wasm` files are vendored into `public/`,
not installed at runtime.

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
│   └── public/               # served statically
│       ├── index.html
│       ├── app.js            # router + views (first screen / session / explorer)
│       ├── diffview.js       # two-column diff renderer
│       ├── explorer.js       # tree browser + file view
│       ├── api.js            # fetch wrapper (adds X-Sky-Eye on non-GET)
│       ├── highlight.js      # web-tree-sitter wrapper, lazy grammar loading
│       ├── style.css
│       └── grammars/         # vendored tree-sitter .wasm files + web-tree-sitter.wasm
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
3. Ignore-file upkeep (§17 below).
4. Bind preferred port **4800**; on `EADDRINUSE` scan upward through
   user-space ports (>1024) until one binds.
5. Print exactly: `sky-eye serving <repo-root> (<kind> repo) → http://localhost:<port>`
6. Open browser (`xdg-open`, macOS `open`) at the bound URL; failure to open
   is a warning, not an error.

### 4.2 Security (D§2)

Local-only, no auth, but protected from drive-by browser requests:

- **Host check:** every request's `Host` header must equal the served
  `host:port`. Anything else → 403. This kills DNS-rebinding.
- **Custom header check:** every non-GET request must carry `X-Sky-Eye: 1`,
  else 403. Browsers can't attach custom headers cross-origin without a
  passing preflight; no CORS headers are ever sent, so preflight always
  fails → CSRF dead.
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

**git mode** (spawn, `--no-color` everywhere):
- head = `git symbolic-ref --short HEAD` + `git rev-parse HEAD`;
  detached head → head id with label `null`, still 200.
- default base = merge-base of HEAD with the first existing default branch
  (`main`, then `master`); none exist → `null`.
- branches = `git for-each-ref --format=... refs/heads refs/remotes`.
- commits = `git log --oneline -n 20`.

**jj mode (v1, head = working copy only):**
- head = `@`; id = **change id** of `@` (session-key rule, D§4). Label `@ (working copy)`.
- default base = `trunk` bookmark if it exists, else `@-`.
- branches = `jj bookmark list` (parse name + commit id; change-id not needed here).
- commits = `jj log` with a template emitting change id + commit id + subject, `-n 20`.

**Empty-data rule (binding):** any discovery gap (detached head, no
bookmarks, fresh repo with zero commits, no default branch) yields an empty
list / `null` in a **200** response. The API fails only on a structurally
invalid repo, which is caught at startup instead. The frontend shows an
informative message when `defaultBase` is null and no base candidates exist.

## 6. Ignore-file upkeep (D§3 row 0a, U§1.1.2)

At startup, ensure `.sky-watch/` is ignored:

- `.gitignore`: if no line matching `^\s*\.sky-watch/?\s*$` exists, append
  `\n.sky-watch/\n`. (jj honors `.gitignore`; no separate `.gitignore` handling needed.)
- `.dockerignore`: same check/append.

Create the file if missing (with a trailing newline). Failures (read-only
fs) → warning, continue.

## 7. Diff generation & parsing (`diff.ts`, D§3 row 1)

### 7.1 Generation

- git: `git diff --no-color --no-ext-diff -U3 <base>...<head>` — three-dot
  diff (diff against merge-base), matching the "default base = merge-base"
  semantics. Rename detection **off** (`--no-renames`): a rename is
  reviewed as delete + add (D§6 deliberate cut).
- jj: `jj diff --git --no-color --from <base> --to <head> -U3`. `--git`
  emits standard unified-diff format; parse identically. Note: jj's hunk
  headers may lack the funcname context git provides (see Open Questions).

The base/head sides are stored in the session as the raw ref-ish strings
the user/`refs` supplied (commit ids in git; change ids or commit ids in jj),
so the diff can always be rebuilt.

### 7.2 Parsing

Parse the unified diff into:

```ts
FileDiff {
  path: string            // new-side path, repo-relative
  oldPath: string         // old-side path (differs only without rename detection... identical here)
  oldStart, oldLines, newStart, newLines
  hunks: Hunk[]           // Hunk { oldStart, newStart, oldLines, newLines, lines: DiffLine[] }
  binary: boolean
}
DiffLine { type: "ctx" | "add" | "del", oldLine?: number, newLine?: number, text: string }
```

Binary files (`GIT binary patch` / jj equivalent) → `binary: true`, no
hunks; UI shows a "binary file" placeholder.

## 8. Chunking into chapters (`chunker.ts`, D§3 row 2)

The interesting part; pure function, heavily tested.

**Input:** `FileDiff[]` (+ config). **Output:** `Chapter[]`.

Algorithm:

1. All hunks across all files are candidate units, ordered by file path
   (alphabetical), then by position within the file.
2. A new chapter starts when any of:
   - the **file** changes (one chapter never mixes unrelated files), or
   - the **function context** changes — git hunk headers carry
     `@@ ... @@ <funcname>`; use it. When unavailable (jj, or git hunk
     without context), fall back to: blank-line/indentation heuristic on the
     new-side content, or simply position distance (> 30 unchanged lines
     between hunks → split).
   - the accumulated **size** would exceed the chapter target.
3. Size accounting counts **changed lines only** (add + del) on the new
   side. Target: 50–100; hard max **200** (a single unbreakable hunk larger
   than 200 stays one chapter — never split a hunk).
4. **Keep-together rules:** hunks within the same function context stay in
   one chapter even if that pushes past 100 (up to the 200 hard max).
   Rename pairs (same content delete+add, detected by identical or
   near-identical line sets) may share a chapter — v1 keeps this simple:
   only exact-path rename pairs detected from the diff header when a
   producer emits one; otherwise skip.
5. Chapter id = first 12 hex chars of `sha256("<newPath>:<newStart>-<newEnd>")`
   of the chapter's first file span — the "stable hash of file + hunk range"
   (D§4). Stable under re-running the chunker on an identical diff; breaks
   when the diff changes (accepted, D§11).

**Config knob:** chapter size limits live in `.sky-watch/config.json` under
`"review": { "targetLines": 75, "maxLines": 200 }` (see §16.3; Open
Question on whether a UI for this is ever needed — v1: file only).

## 9. Data model & session store (`store.ts`, D§4)

### 9.1 Session identity (binding, restated for implementers)

- `SessionId = "<base>..<head>"` where each side is the repo's **stable
  revision id**: git → commit id; jj → **change id** for mutable changes
  (incl. `@`), commit id for bookmarks/immutable commits.
- Consequence to implement: in jj mode, rebuilding the diff on session open
  uses change ids, so working-copy saves show up as "same session, same
  key, current diff"; in git mode, any history rewrite → new session id →
  supersede flow (§13.2).
- Branch names at creation time go into `aliases`.

### 9.2 File layout & atomic writes

- One file per session: `.sky-watch/<sessionId>.json`.
- **Filename safety:** session ids from URLs are validated against
  `/^[0-9a-zA-Z+-]+\.\.[0-9a-zA-Z+-]+$/` before touching the filesystem —
  this both prevents path traversal (the id contains `..` as a substring by
  design!) and rejects junk ids. Same validation wherever a session id
  arrives from the network.
- Saves are atomic: write `<sessionId>.json.tmp` → `fs.rename`.
- `list()` reads all files' lightweight headers (id, aliases, label,
  updatedAt, open-comment count, reviewed) — cache the header by mtime to
  avoid re-parsing everything on every `/api/sessions` call.

### 9.3 Schema

As D§4, verbatim (`Session`, `Chapter`, `Comment`, `Anchor`). Implementation
notes the docs imply but don't state:

- `meta.repo` is display-only; **every** path anywhere (files, anchors,
  comments) is repo-relative.
- `Chapter.attention: LineMark[]` — `LineMark { side: "old"|"new", line:
  number, mark: "focus"|"glance"|"safe" }`. Rules pass fills marks at
  session creation; LLM pass may overwrite (`markSource: "rules"|"llm"` kept
  per mark so a re-run knows what it may replace without confirmation —
  only human data is protected, marks are always machine-owned).
- `Session.lastWriteAt` (number): bumped on every write; used for the
  conflict check (§10.5).

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
| `GET /api/sessions/:id` | — | full `Session`; on open, server rebuilds the diff from stored base/head and **stamps `stale: boolean`** + current diff digest into the response (see §13.1) |
| `GET /api/refs` | — | §5 |
| `GET /api/tree?ref=&dir=` | — | `[{ name, type: "dir"|"file", path }]`; `dir` defaults to root; repo-relative, contained (§11) |
| `GET /api/file?ref=&path=&side=` | — | `{ content, binary }`; `side` selects base/head ref of the open session or a plain ref |
| `POST /api/sessions` | `{ base, head, baseLabel?, headLabel? }` | If a session with this id exists → **200 with the existing session** (no duplicate, U§1.5); else create: build diff, chunk, run rule classification, persist → `201` + `Session` |
| `POST /api/comments` | `{ sessionId, chapterId, file, side, line, text, anchor }` | `201` + `Comment`; anchor is captured client-side from rendered content (§12) |
| `PATCH /api/sessions/:id` | `{ label?, reviewed?, lastWriteAt }` | updated `Session` |
| `PATCH /api/comments/:id` | `{ text?, resolved?, priority?, anchor?, lastWriteAt }` | updated `Comment`; `resolved: true` also stamps `resolvedAt` |
| `POST /api/sessions/:id/rerun` | `{ chapterId }` | regenerates narrative + LLM marks for one chapter; if `narrativeEdited` → requires `{ confirm: true }` else **409** `{ error: "narrative edited", needsConfirm: true }`. First generation happens here too (lazy, D§6a) |
| `POST /api/sessions/:id/refresh` | — | §13; returns `{ session, supersededBy? }` |
| `GET /api/sessions/:id/export` | — | the raw session JSON as a download (`Content-Disposition: attachment`) |
| `POST /api/import` | session JSON body | merge into session with same id (§14) → merged `Session` |

## 11. File explorer (`tree.ts`, D§6b, U§2)

- `GET /api/tree`: list directory at a ref via the CLI (`git ls-tree` /
  `jj file list`), return entries with repo-relative paths.
- `GET /api/file`: content at a ref. **Path containment is mandatory:**
  resolve the requested path against the repo root and reject (400) if it
  escapes — `..` segments, absolute paths, and symlinks resolving outside
  the repo (`fs.realpath` containment check on the resolved target).
- Read-only: no write endpoints exist, period.

## 12. Comments & anchors (D§4, D§6, U§4)

- Gutter click on a diff line → inline composer (designed at milestone T3,
  U§4 — layout already reserves the click target). Author from `identity.ts`
  (§15); missing config → `author: null` → UI shows "anonymous".
- **Anchor capture** happens on every comment write (create *and* edit):
  the client sends the pinned line's exact `text`, plus 3 lines `before` and
  `after` as currently rendered (post-highlight stripped to plain text), the
  line number, side, and best-effort `chapterId`. Server stores as-is.
- Old-side comments are stored normally but their anchors are expected to
  orphan on refresh (D§6 cut: old side is history, never remapped).

## 13. Refresh, remap, supersede (`remap.ts`, D§6, U§3.1)

### 13.1 Staleness detection

On every `GET /api/sessions/:id` the server rebuilds the diff from the
stored base/head and compares a digest (sha256 of the normalized diff text)
against the digest stored at last build. Changed → response carries
`stale: true`; UI shows the "review is stale — refresh?" banner. **Never
auto-refresh** (D§6: never silently on open).

### 13.2 The two flows

- **jj (key survives):** rebase preserves change ids → same session id,
  changed diff. Refresh updates the session in place: rebuild diff + chapters,
  run the remap pass.
- **git (key breaks):** rebase rewrites commit ids → new session id. Refresh
  creates the successor session (rebuild + remap carried over), sets
  `supersededBy` on the old session, keeps the old file on disk as history.
  Opening a superseded session shows the banner and deep-links to the
  successor.

### 13.3 Remap pass (re-anchoring)

For each comment (new-side anchors only; old-side orphan immediately):

1. Fetch the file content at the **new head**.
2. Find exact matches of `anchor.text` in the new content.
3. One candidate near the old line → re-pin (write fresh anchor: new line
   number, same text, refreshed before/after from the new content).
4. Multiple candidates → score each by (a) `before`/`after` context-line
   matches (weighted, ordered), (b) proximity to the old line. Best wins;
   ties → nearest.
5. No match → comment is **orphaned**: flag `orphaned: true` on the comment,
   keep the old anchor, keep it visible, count it in the triage banner.

### 13.4 Orphan triage UI (U§3.1, D§6.3)

"N comments need re-pinning" banner on the session view. Per orphan: show
the comment + the new diff of that file → click a line to re-pin (writes a
fresh anchor, clears the flag), or resolve / wontfix (set `resolved`).

**Chapter rebuild on refresh:** chapters are re-chunked from the new diff;
their ids will differ (id = hash of file+range). Comments ride on content
anchors, not chapter ids — `anchor.chapterId` is re-derived as a hint after
remap. This is the D§11 risk, accepted.

## 14. Export / import (D§5, D§6)

- Export = the session file, byte-for-byte, as a download.
- Import: validate the JSON shape, then merge into the stored session with
  the same id:
  - Comments matched by `id`; per comment, **newer `createdAt` wins**;
    nothing is ever deleted.
  - If the imported session's diff digest differs from the local one (other
    machine had a rebased clone), run the remap pass after merging (D§6:
    "export/import inherits this for free").
  - Narratives: imported `narrative` wins only if locally `!narrativeEdited`
    or imported `updatedAt` is newer — flag `narrativeEdited` travels in the
    export and is respected.
- Importing a session id that doesn't exist locally → create it.
- Re-verification (D§3 row 5): after import, if the diff digest mismatches,
  surface the stale banner rather than silently mixing review state.

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
   file headings; two-column GitHub-style diff (old left / new right), hunks
   with context; empty diff → "nothing to review" message.
3. **Explorer:** breadcrumb tree navigation, read-only file view with the
   same highlighter, head/base side toggle within a session; changed files
   in chapters link here.

Data flow: `api.js` wraps fetch (adds `X-Sky-Eye` on non-GET, propagates
409s); views re-render from fetched session JSON; no client state worth
syncing. Diff rendering is the perf-sensitive path — chapters render lazily
on first expansion if the session has >N chapters (N ≈ 50; see Open
Questions).

## 19. Syntax highlighting (D§3 row 1a, D§6b)

- `public/highlight.js` wraps `web-tree-sitter`; the runtime
  `web-tree-sitter.wasm` + grammar `.wasm` files are vendored under
  `public/grammars/`.
- **v1 grammar set:** JavaScript/TypeScript (one grammar), Python, Rust,
  Go, JSON. Unknown extension → plain text. Loading is lazy per language,
  cached in a module-level map.
- The same highlighter colors file views and diff lines (consistency
  requirement). Highlighting is progressive: lines render unhighlighted and
  colorize when the grammar is ready — never block rendering on it.
- If vendoring proves clumsy in practice → esbuild fallback is a **decided-
  later** escape hatch (D§2), not planned work.

## 20. Testing strategy (D§8)

Priority order — "chunker + remap first, that's where the bugs live":

1. **`chunker.test.ts`** — pure fixtures: size limits, keep-together,
   function-boundary splits, unbreakable oversized hunk, empty diff.
2. **`remap.test.ts`** — anchor scoring: exact match near old line, multiple
   candidates, no match → orphan, old-side anchors orphan immediately.
3. **`diffparse.test.ts`** — unified-diff parsing edge cases (no newline at
   EOF, binary, hunk without funcname).
4. **`integration.test.ts`** — create a temp git repo, commit base + head,
   run server handlers against it: refs discovery, session create, comment
   add + resolve, export → import merge, refresh/supersede after `git
   commit --amend`.

All pure logic is kept dependency-free (spawn CLIs only at integration
boundaries) so tests stay fast.

## 21. Milestones → deliverables & acceptance criteria

The docs' 7 milestones (D§9), made concrete. Each ends in a demoable state.

**M1 — Spine.** Deliver: `main.ts` startup + security + ignore upkeep;
`refs.ts`; `diff.ts`; `chunker.ts` (basic size splitting only); session
store; `POST/GET sessions`; first screen + session view with read-only
chaptered two-column diff; binary/empty-diff handling.
*Accept:* run `sky-eye` in a git and a colocated jj repo; pick base; see
chapters; reload persists; a second browser tab cannot CSRF the mutations;
`.sky-watch/` ignored.

**M2 — Comments.** Deliver: composer UI, `identity.ts`, `POST/PATCH
comments`, resolve, counters, anchor capture on write.
*Accept:* comment, resolve, reload — all persist with correct author;
anchors stored with before/after context.

**M3 — Rebase survival.** Deliver: staleness digest, refresh flow (both
modes), `remap.ts`, orphan triage banner, supersede handling.
*Accept:* in a jj repo, rebase the working copy → banner → refresh →
comments re-pinned; amend a git commit → new session, old marked
superseded, comments carried.

**M4 — Chunker tuning.** Deliver: function-boundary detection, keep-together
rules, `review` config knob. *Accept:* fixture suite green; manual review of
a real 500-line diff reads sensibly.

**M5 — Rule-based attention marks.** Deliver: `classify.ts` rules + line
marking UI. *Accept:* test files/lockfiles show safe; a touched auth line
shows focus.

**M6 — Export/import.** Deliver: export download, import + merge + re-
verification + remap-on-mismatch. *Accept:* export from repo A, import into
a rebased clone B → comments re-anchor or orphan correctly, nothing lost.

**M7 — LLM narratives + refined classification.** Deliver: `llm.ts`,
`narrate.ts`, shared-call optimization, config file, lazy firing,
`narrativeEdited` guard, re-run confirm. *Accept:* no config → everything
still works rules-only; with config → narratives on first expansion, cached,
editable, re-run asks before overwriting edits.

## 22. Open questions

Genuine gaps the docs don't settle — decide or verify when the relevant
milestone starts:

1. **jj hunk headers lack funcname context** (probably). The chunker's
   function-boundary rule depends on `@@ ... @@ <funcname>`, which git
   provides and jj's `--git` output may not. Verify at M4; fallback is the
   blank-line/indentation heuristic (§8.2), but confirm it's good enough in
   jj mode — jj is this repo's own VCS, so it's the primary path, not the
   edge case.
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
4. **Grammar vendoring mechanics.** Which exact languages ship in v1
   (§19 is a proposal), where the `.wasm` binaries come from (committed to
   this repo vs. a fetch script), and license implications of committing
   them. Decide before M1 ships the highlighter.
5. **Default port & configurability.** 4800 assumed from U§1.1's example.
   Should there be a `--port` flag / env var, or is scan-upward enough?
6. **Large diffs.** No pagination anywhere. Chapters render lazily (§18),
   but a 5,000-line diff in one session may still crawl. Decide at M4
   whether per-file virtualization is needed or the accordion is enough.
7. **Base-side semantics for user-picked bases.** Default base uses
   merge-base semantics (`base...head`). When the user picks an arbitrary
   commit as base, is that also three-dot, or literal two-dot? Three-dot
   everywhere is the least surprising — confirm intent.
8. **jj change-id uniqueness scope.** Change ids are only unique within a
   repo *and can be re-issued after `jj abandon`* in principle. Session
   collision (two different diffs, same change-id key) is vanishingly rare
   but nonzero — accept, or add the commit id to the stored meta for
   display disambiguation.
9. **Refresh for base-side changes.** D§6 cuts "base-commit-change
   remapping". If the *base* moves (e.g. trunk advanced), the diff changes
   shape but head didn't — is that "stale"? v1 answer: no banner (head
   digest only); revisit if it bites.
10. **Windows support.** Startup uses `xdg-open`/`open`; paths are
    repo-relative but the server runs on posix assumptions. Explicitly
    out of scope v1, or handle `win32` in `main.ts` for cheap?
