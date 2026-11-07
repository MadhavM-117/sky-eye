# Plan — Task 001: M1 Spine

**Task:** `.implementation/tasks/001-m1-spine.md` · **Spec:** `docs/spec.md` §2–§5, §7–§11, §18–§21 (M1)
**Acceptance (spec §21 M1):** run in a git and a colocated jj repo; pick base; see
highlighted chaptered two-column diff; browse repo files at base/head; edit
narrative/label and reload persists; CSRF mutations rejected; `.sky-watch/` ignored
without creating `.dockerignore` in non-Docker repos.

**M1 scope boundary:** sessions, refs, tree/file, diff, chunker (basic), first screen +
session view + explorer + highlighting. *Not in M1:* comments (M2), staleness/refresh
(M3), funcname/keep-together chunker tuning (M4), classify marks (M5), export/import
(M6), LLM narratives (M7). `Session`/`Chapter`/`Hunk` types are defined **once, now**,
in full (spec §9.3) so later tasks never touch the schema shape.

Canonical plan location per `process.md`: `.implementation/plans/001-m1-spine.md`
(a copy of this file).

---

## 1. Scaffolding

### `package.json` (new)

```jsonc
{
  "name": "sky-eye",
  "bin": { "sky-eye": "./bin/sky-eye.js" },
  "engines": { "node": ">=22.6" },
  "type": "module",
  "scripts": {
    "check": "tsc --noEmit",
    "test": "node --experimental-strip-types --test tests/"
  }
}
```

- Runtime deps: **none**. Dev deps: `typescript` only (spec §2).
- `bin/sky-eye.js` (new): two-liner — `#!/usr/bin/env node` + `import("../src/main.ts")`
  won't survive type stripping via bin path, so instead point bin at a plain `.js` that
  spawns `node --experimental-strip-types <abs src/main.ts>`. Alternative: make bin the
  `.ts` file directly (`node` strips types when the shebang'd file is `.ts` and invoked
  via node ≥22.6). Try bin → `./src/main.ts` first; if npm can't exec it, fall back to
  the two-line `.js` wrapper.
- `tsconfig.json` (new): `{ "compilerOptions": { "noEmit": true, "strict": true,
  "module": "nodenext", "target": "esnext", "allowImportingTsExtensions": true } }`.

Note: Node type stripping requires `--experimental-strip-types` on the server process
and `.ts` extension in import specifiers (`import { x } from "./refs.ts"`).

---

## 2. Slice 1 — startup, server core, security, ignore upkeep

### `src/types.ts` (new)

All shared types, defined once (foundations rule). Copy the shapes from spec §7.2/§9.3:

```ts
export type DiffLineType = "ctx" | "add" | "del";
export interface DiffLine { type: DiffLineType; oldLine?: number; newLine?: number; text: string }
export interface Hunk { header?: string; oldStart: number; newStart: number; oldLines: number; newLines: number; lines: DiffLine[] }
export interface FileDiff { path: string; oldPath: string; status: "modified" | "added" | "deleted"; hunks: Hunk[]; binary: boolean }
export interface LineMark { side: "old" | "new"; line: number; mark: "focus" | "glance" | "safe"; markSource: "rules" | "llm" }
export interface Anchor { file: string; side: "old" | "new"; line: number; text: string; before: string[]; after: string[]; chapterId: string }
export interface Comment { id: string; chapterId: string; file: string; side: "old" | "new"; line: number; text: string; createdAt: number; updatedAt: number; author: { name: string; email: string } | null; resolved: boolean; resolvedAt?: number; priority?: "nit" | "must-fix"; orphaned?: boolean; anchor: Anchor }
export interface Chapter { id: string; file: string; status: FileDiff["status"]; hunks: Hunk[]; narrative: string; narrativeEdited?: boolean; attention: LineMark[] }
export interface Session { id: string; base: string; head: string; baseRef?: string; headRef?: string; diffDigest: string; aliases: string[]; createdAt: number; updatedAt: number; lastWriteAt: number; meta: { repo: string; exportedBy?: string }; label?: string; reviewed: boolean; chapters: Chapter[]; comments: Comment[]; supersededBy?: string }
export interface Refs { root: string; kind: "git" | "jj"; head: { id: string; label: string | null }; defaultBase: { id: string; label: string } | null; branches: { id: string; name: string }[]; commits: { id: string; subject: string }[] }
```

### `src/cli.ts` (new) — the only place that spawns CLIs for refs/diff

```ts
import { execFile } from "node:child_process";
export const run = (cmd: "git" | "jj", args: string[], cwd: string): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
```

- Always `shell: false` (spec §4.2). Refs validated before use — see `validateRef` below.
- jj/git calls that may fail structurally (no commits yet) get caught by callers →
  empty lists per the empty-data rule (spec §5).

```ts
export const VALID_REF = /^[0-9a-zA-Z@][0-9a-zA-Z._/@+-]*$/;   // no leading '-', no whitespace/NUL
export const validateRef = (r: string) => { if (!VALID_REF.test(r)) throw new ApiError(400, "bad ref"); return r; };
export class ApiError extends Error { constructor(readonly status: number, msg: string) { super(msg); } }
```

### `src/main.ts` (new) — startup sequence, spec §4.1 verbatim

```ts
import path from "node:path"; import fs from "node:fs";
const findRoot = (dir: string): string | null =>
  fs.existsSync(path.join(dir, ".jj")) || fs.existsSync(path.join(dir, ".git"))
    ? dir : path.dirname(dir) === dir ? null : findRoot(path.dirname(dir));

const root = findRoot(process.cwd());
if (!root) { console.error("sky-eye: no git or .jj repo found in " + process.cwd()); process.exit(1); }
const kind = fs.existsSync(path.join(root, ".jj")) ? "jj" : "git";   // jj wins for colocated
upsertIgnoreFile(root, ".gitignore", true);
upsertIgnoreFile(root, ".dockerignore", fs.existsSync(path.join(root, ".dockerignore")));
const port = await serve(root, kind);                                // §server below, returns bound port
console.log(`sky-eye serving ${root} (${kind} repo) → http://localhost:${port}`);
openBrowser(`http://localhost:${port}`);                             // xdg-open | open, failure = warning
```

- `openBrowser`: `execFile("xdg-open", [url], ...)` on linux, `open` on darwin,
  `process.platform === "win32"` → out of scope v1 (spec §22.9): print the URL, don't
  try. Failure → `console.warn`, never crash.

### Ignore upkeep (in `main.ts` or small `ignore.ts`, spec §6)

```ts
function upsertIgnoreFile(root: string, name: string, create: boolean) {
  const p = path.join(root, name);
  if (create && !fs.existsSync(p)) { fs.writeFileSync(p, "\n"); }          // only .gitignore
  let lines = fs.readFileSync(p, "utf8").split("\n");
  if (lines.some(l => /^\s*\.sky-watch\/?\s*$/.test(l))) return;
  if (lines.at(-1)?.trim() !== "") lines.push("");                          // trailing newline
  lines.push(".sky-watch/");
  fs.writeFileSync(p, lines.join("\n"));
}
```

- `create=false` for `.dockerignore` (never create; accept: only touch existing).
- Read-only fs failure → `console.warn`, continue (spec §6).

### `src/server.ts` (new) — http, router, static, security (spec §4.2–4.3)

```ts
import http from "node:http";
export function serve(root: string, kind: "git" | "jj"): Promise<number> {
  return new Promise(resolve => {
    const handler = (req, res) => handle(root, req, res).catch(e =>
      res.writeHead(e.status ?? 500, { "content-type": "application/json" })
         .end(JSON.stringify({ error: e.message })));
    let port = 4800;
    const tryBind = () => {
      const srv = http.createServer(handler);
      srv.on("error", () => tryBindOn(++port, resolve));
      srv.listen(port, "127.0.0.1", () => resolve(port));
    };
    tryBind();
  });
}
```

(Structure the retry loop cleanly — a small `listen(port)` helper returning a promise
that resolves `{ srv, port }` and rejects on `EADDRINUSE`, called in a `for` loop from
4800 upward, is fine.)

**Security checks, every request, before routing:**

```ts
// 1. Host check (kills DNS-rebinding)
const host = req.headers.host ?? "";
const allowed = ["localhost:" + port, "127.0.0.1:" + port];
if (!allowed.includes(host)) return res.writeHead(403).end(JSON.stringify({ error: "forbidden" }));
// 2. CSRF check on mutations
if (req.method !== "GET" && req.headers["x-sky-eye"] !== "1") return 403;
// 3. Never emit CORS headers anywhere.
```

**Routing:**

- `GET /api/...` → route table (match by method + regex, extract `:id` params).
- `GET /` and non-`/api` paths → static from `src/public/`: resolve + `path.normalize`,
  reject anything outside the `public` dir (same containment rule as §11); MIME map for
  `.html .js .css` (+ a generic default); unknown asset → 404.
- `/api` body: `for await` chunks → `JSON.parse`, 400 on failure.
- Errors → `{ error: string }` with correct status: 400 bad input, 404 unknown
  session, 409 conflict, 500 unexpected (spec §4.3).

**Routes registered in M1** (others arrive with their milestones):

| Route | Handler | Notes |
|---|---|---|
| `GET /api/refs` | `refs.ts` | spec §5 |
| `GET /api/tree?ref=&dir=` | `tree.ts` | containment §11 |
| `GET /api/file?ref=&path=` | `tree.ts` | containment §11; binary detect §below |
| `GET /api/sessions` | `store.ts` | header list, spec §10 |
| `GET /api/sessions/:id` | `store.ts` | validate id §9.2; full session |
| `POST /api/sessions` | `store.ts` + diff pipeline | §10; existing id → 200, new → 201 |
| `PATCH /api/sessions/:id` | `store.ts` | `{ label?, reviewed?, narrative?: {chapterId, text}, lastWriteAt }` |

M1 leaves the remaining route stubs out entirely — the router is a match list, adding
routes later is one entry each.

---

## 3. Slice 2 — refs + tree

### `src/refs.ts` (new) — spec §5, both modes

**git mode** (all via `run("git", [...], root)`, `--no-color` where relevant, full
40-char SHAs as `id`):

```ts
// head
const branch = await run("git", ["symbolic-ref", "--short", "HEAD"], root);   // may fail → detached
const headId  = await run("git", ["rev-parse", "HEAD"], root);
// default base: first existing of ["origin/main", "main", "origin/master", "master"]
for (const b of candidates) { const mb = await run("git", ["merge-base", "HEAD", b], root);
  if (ok) return { id: mb.trim(), label: b }; }                                // else null
// branches
await run("git", ["for-each-ref", "--format=%(objectname)%00%(refname:short)", "refs/heads", "refs/remotes"], root)
// commits
await run("git", ["log", "-n", "20", "--format=%H%00%s"], root)
```

Detached head → `head: { id: revParseHEAD, label: null }`, still 200. `symbolic-ref`
failure and empty-repo `log` failure are caught → per-category empty (spec §5 empty-data rule).

**jj mode (v1: head = working copy only):**

```ts
// head: change id of @ (session-key rule, spec §9.1)
const headChangeId = await run("jj", ["log", "--no-graph", "-r", "@", "-T", "change_id"], root);
// default base: trunk bookmark if it exists (→ its commit id, label "trunk"), else @-
//   @- resolution: commit id if immutable, change id if mutable.
const trunk = await run("jj", ["log", "--no-graph", "-r", "trunk", "-T", "commit_id"], root); // may fail
// branches (filter absent/untracked targets)
await run("jj", ["bookmark", "list", "-T", 'name ++ "\\0" ++ normal_target.commit_id() ++ "\\n"'], root)
// commits: change_id for mutable, commit_id for immutable
await run("jj", ["log", "--no-graph", "-n", "20", "-T",
  'if(immutable, commit_id, change_id) ++ "\\0" ++ commit_id ++ "\\0" ++ description.first_line() ++ "\\n"'], root)
```

Verify the exact jj template syntax against the installed jj version while
implementing (`jj log --help`); keep templates as named constants for easy fixing.

Response shape exactly per spec §5 (`Refs` type). Session `POST` resolves user-picked
ids through the same helpers.

### `src/tree.ts` (new) — spec §11

```ts
export const validatePath = (p: string) => {
  const n = path.posix.normalize(p);
  if (p.includes("\0") || p.includes("\\") || n.startsWith("/") || n.startsWith("-")
      || n === ".." || n.startsWith("../")) throw new ApiError(400, "bad path");
  return n;
};
```

- `GET /api/tree`: git → `git ls-tree --end-of-options <ref> -- <dir>`; jj →
  `jj file list -r <ref> -- <dir>`. Map output to `[{ name, type: "dir"|"file", path }]`
  (repo-relative paths). jj `file list` output is path-per-line and includes dirs —
  derive `type` from trailing content / `--` flags; verify against installed jj and
  fall back to `jj file list -r <ref> <dir>` + `ls-tree`-style parsing as needed.
- `GET /api/file`: git → `git cat-file -p <ref>:<path>`; jj → `jj file show -r <ref> -- <path>`.
  **Never** read from the working tree (spec §11).
- Binary detection: content contains a NUL byte in the first ~8000 bytes →
  `{ content: "", binary: true }`; else `{ content, binary: false }`.
- `ref` always passes `validateRef`; `path`/`dir` always `validatePath` (dir defaults `"."`).

---

## 4. Slice 3 — diff, chunker, store, session API

### `src/diff.ts` (new) — spec §7

```ts
export async function buildDiff(root: string, kind: "git" | "jj", base: string, head: string): Promise<string>
```

```ts
// git: three-dot diff (merge-base semantics, spec §22.6: three-dot everywhere)
await run("git", ["diff", "--no-color", "--no-ext-diff", "--no-renames", "-U3",
                  "--end-of-options", `${base}...${head}`, "--"], root)
// jj
await run("jj", ["diff", "--git", "--no-color", "--context", "3", "--from", base, "--to", head], root)
```

```ts
export function parseUnifiedDiff(text: string): FileDiff[]
```

- Parse `diff --git a/… b/…` headers, `---`/`+++`, `@@ -a,b +c,d @@ [funcname]` hunks,
  ` ` / `+` / `-` line payloads with running line counters producing `oldLine`/`newLine`.
- `+++ /dev/null` → `status: "deleted"`, `path` falls back to the `---` path (never
  `"/dev/null"`); `--- /dev/null` → `status: "added"`; else `"modified"`.
- `Binary files … differ` or `GIT binary patch` → `{ binary: true, hunks: [] }`.
- `\ No newline at end of file` markers: attached as part of the preceding line's
  representation or skipped — pick "skip, keep line text without the marker" and cover
  in a fixture (spec §20 test 3).
- Hunk header funcname kept on `Hunk.header` (used by M4's chunker tuning).
- `diffDigest = sha256(normalizedDiffText)` — normalize = the raw diff text with no
  trailing-whitespace-per-line changes (v1: just sha256 of the text as produced; "normalized"
  means deterministic command output — ensure flags guarantee determinism).

### `src/chunker.ts` (new) — spec §8, M1 = basic size splitting

```ts
export interface ReviewConfig { targetLines: number; maxLines: number }   // from .sky-watch/config.json, default {75, 200}
export function chunk(files: FileDiff[], config: ReviewConfig = { targetLines: 75, maxLines: 200 }): Chapter[]
```

M1 implements rules 1–3 + 5; the funcname/keep-together refinements (rules 4, funcname
context) are task 005 — structure the loop so a "shouldSplit(prevHunk, nextHunk)"
predicate is the single place they hook in:

```ts
// per file (alphabetical path order), per hunk (positional order):
//   start chapter if: new file, or changedLines(chapter) + changedLines(hunk) > targetLines
//   (single hunk > maxLines stays one chapter — never split a hunk, spec §8.3)
// chapter id = sha256(`${file}:${oldStart},${oldLines}->${newStart},${newLines}`).slice(0, 12)
//   of the chapter's FIRST hunk (spec §8.5; unique even for pure deletions: oldStart/oldLines present)
// attention: [] for now (M5 fills it)
// narrative: "unanalyzed" for now (M7 fills it)
```

- `loadConfig(root)` reads `.sky-watch/config.json`, picks the `review` block, defaults
  on missing/invalid — lives in `store.ts` or `chunker.ts`, used only by session creation.

### `src/store.ts` (new) — spec §9

```ts
export const VALID_SESSION_ID = /^[0-9a-zA-Z][0-9a-zA-Z+-]*\.\.[0-9a-zA-Z][0-9a-zA-Z+-]*$/;
// validate every session id from URL/body/import before fs or CLI use (traversal + flag-injection guard)
const dir = (root: string) => path.join(root, ".sky-watch");
```

- `save(root, session)`: bump `lastWriteAt` + `updatedAt`, write
  `<id>.json.tmp` → `fs.rename` (atomic, spec §9.2). Ensure dir exists on first save.
- `load(root, id)`: `JSON.parse` of the file; 404 if absent.
- `list(root)`: read each `*.json`, extract `{ id, aliases, label, updatedAt,
  openComments (comments where !resolved), reviewed }`; cache parsed headers by
  `(path, mtime)` in a module-level Map so repeat `GET /api/sessions` doesn't reparse
  everything (spec §9.2).
- **Session creation pipeline** (`POST /api/sessions { base, head, baseLabel?, headLabel? }`):
  1. `validateRef(base)`, `validateRef(head)`; resolve both to stable ids per §9.1:
     git → `rev-parse` (40-char SHA); jj → if the arg is `@`/change-id-like mutable →
     change id, bookmark/immutable → commit id (reuse refs.ts resolution helpers).
  2. `id = \`${baseId}..${headId}\``; validate against `VALID_SESSION_ID`.
  3. Existing session file → **200 with stored session** (spec §10/U§1.5).
  4. Else: `buildDiff` → `parseUnifiedDiff` → `chunk` → build `Session` (base/head,
     baseRef/headRef from the labels passed in, `diffDigest`, `aliases: [labels…]`,
     `meta.repo: root`, timestamps, `chapters`, `comments: []`) → save → **201**.
- `PATCH /api/sessions/:id`: body carries `lastWriteAt`; mismatch with stored →
  **409 with current session JSON** (spec §9.4). Else apply `label` / `reviewed` /
  `narrative` (find chapter by id, set `narrative` + `narrativeEdited: true`) → save →
  return session.
- `GET /api/sessions/:id` returns the stored session as-is (no `stale` computation —
  that's M3; add the field when it lands).

---

## 5. Slice 4 — frontend (all files in `src/public/`, no build step)

### `public/index.html` (new)

Single shell: `<div id="app"></div>`, `<link rel="stylesheet" href="/style.css">`,
`<script type="module" src="/app.js">`. All rendering is JS-driven (hash routing).

### `public/api.js` (new)

```ts
export const api = {
  get: (path) => fetch(path).then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(j))),
  mut: (method, path, body) => fetch(path, { method, headers: { "content-type": "application/json", "x-sky-eye": "1" }, body: JSON.stringify(body) }).then(handle),
};
```

- Propagates `{ error }` and 409s to callers for the conflict warning.

### `public/app.js` (new) — hash router + three views (spec §18)

Routes (hash, no leading slash scheme):
- `""` → first screen
- `#<sessionId>` → session view
- `#<sessionId>/explorer[?...]` → explorer (path/side encoded in the hash)

Views re-render from fetched JSON; no client state worth syncing (spec §18).

**First screen** (U§1.5): fetch `/api/refs` → header (repo root + kind badge) →
"Review **[head]** against **[base dropdown]**" — dropdown groups: default base /
bookmarks / branches / recent commits, default preselected, option value = the ref
id (stable id, so POST sends canonical values directly) → "Create review" button →
`POST /api/sessions` → navigate to `#<id>`. Existing-sessions list from
`GET /api/sessions` (label/aliases, `updatedAt`, open-comment count, reviewed chip),
click → open. `defaultBase === null` and no candidates → informative message
(spec §5). Empty diff sessions are fine.

**Session view** (U§3.1–3.2):
- Header: editable label (click → input → `PATCH`), aliases, open-comment count
  placeholder (0 until M2), reviewed toggle, repo path + kind badge. Refresh/re-run/
  export actions appear in M3/M6 — leave header space, don't render dead buttons.
- Stale/orphan banners: M3 — leave layout room only.
- Chapters as accordion, **expanded by default** (U§3.2). Per chapter: file heading,
  narrative as plain editable `<textarea>` (save on blur/change → `PATCH` with
  `narrative: {chapterId, text}`), then `diffview.js` rendering of the chapter hunks.
- Empty diff → "nothing to review for this comparison".
- No gutter click wiring yet — but render each line as a table row with data-line
  attributes so M2's composer has its click targets (U§4 note).

### `public/diffview.js` (new) — two-column renderer

```ts
// renderChapter(chapter, fileDiff) → <table class="diff">
//   old side left / new side right, GitHub-style (U§3.2, D§3 row 1)
// pair ctx lines side-by-side; add/del unpaired sides render as blank cells
// hunk headers as separator rows with line numbers
// each code cell: escapeHtml(text) → highlight(lineText, langFromExt(file)) → innerHTML
```

- M1 renders a full session's chapters (render chapters lazily only if >50 chapters —
  spec §18; ship the check, defer the virtualization decision to M4).
- Escaping before highlighting is the XSS-relevant order (highlighter gets raw text,
  returns escaped HTML with spans — see below).

### `public/highlight.js` (new) — spec §19

Zero-dependency line tokenizer for **JS/TS, Python, Rust, Go, JSON**:

```ts
// highlight(line, lang) → escaped HTML string with <span class="tok-kw|str|com|num|type|fn">…
// tokenizer: regex-ordered alternatives per language (keywords, strings incl. template/
//   triple-quoted, line comments, numbers, type-ish capitalized idents)
// multi-line state: module-level class TokenizerState { inBlockComment, inString }
//   carried across contiguous lines of one file/hunk so block comments and
//   template strings survive line breaks (spec §19) — diff hunks get fresh state per hunk
// unknown extension → escape-only passthrough
```

- Language detection by file extension (`.js .jsx .ts .tsx` / `.py` / `.rs` / `.go` /
  `.json`); shared keyword tables as plain arrays.
- Keep it genuinely small (~150–200 lines); it's an upgrade point, not a feature (D§6b).

### `public/explorer.js` (new) — spec §11/U§2

- Breadcrumb tree nav: `GET /api/tree?ref=<ref>&dir=<dir>`, dirs clickable, breadcrumb
  row of path segments. Side toggle (head/base of the open session). Files open
  read-only via `GET /api/file?ref=&path=`, rendered with `highlight.js`. Changed
  files in chapters link here. Back links to the session view.
- The explorer needs the session's base/head refs — the hash route is `#<sid>/explorer`,
  and the view fetches the session to know its refs.

### `public/style.css` (new) — CSS custom properties from day one (task notes)

```css
:root { --bg, --fg, --accent, --add-bg, --del-bg, --gutter-bg, --banner-bg, --font-mono, … }
```

- Two-column diff table styling, chapter accordion, banner layout slots, token classes
  (`.tok-kw` etc.). No dark mode in v1; nothing user-facing hard-coded (foundations).

---

## 6. Tests (spec §20; `node:test`, dev-dep-free)

1. **`tests/diffparse.test.ts`** — parse fixtures: normal hunk, hunk without funcname,
   `+++ /dev/null` deleted file (path fallback), added file, `\ No newline at EOF`,
   `Binary files … differ`, multi-file diff, running line counters across hunks.
2. **`tests/chunker.test.ts`** — size splits at target, oversized single hunk stays
   whole, per-file separation, chapter-id determinism + uniqueness (incl. pure-deletion
   chapter), empty diff → `[]`.
3. **`tests/integration.test.ts`** — real temp git repo (`git init` in `os.tmpdir()`,
   commit base + head): `GET /api/refs` (head, default base, branches, commits);
   `GET /api/tree` + `/api/file` (incl. a file deleted in head, readable on base side);
   `POST /api/sessions` (201 → re-POST → 200 same id); `PATCH` label/narrative +
   reload persists; 409 on stale `lastWriteAt`; 403 on non-GET without `X-Sky-Eye`;
   403 on wrong `Host`; static 404 on unknown asset. Handlers run against the real
   server on an ephemeral port (loopback). jj-mode integration: manual recipe only for
   M1 acceptance (jj CLI in CI-less local test is fine too — recipe below).
4. **Manual acceptance recipe** (M1 accept, spec §21): run `npx sky-eye` in this jj
   repo → create review of `@` vs `trunk` → chapters + highlighting visible; then in a
   scratch git repo same flow; check `.sky-watch/` ignored, no `.dockerignore` created;
   edit narrative + label, reload → persisted; curl a non-GET without the header → 403.

---

## 7. Considerations & trade-offs

- **Hand-rolled router over a framework** — decided in spec §2; ~13 routes total means
  ~100 lines. Router is a `method + regex` match list so later routes are one-liners.
- **Types live in `src/types.ts`, not spread across modules** — process.md foundations:
  strict TS is the single schema source. Frontend mirrors only what it reads
  (loose `any`-ish shapes in JS, no `checkJs`).
- **Chunker loop structured around a `shouldSplit` predicate** so task 005 only edits
  the predicate + adds funcname/keep-together rules, not the loop.
- **Static + tree/file containment share one `validatePath`** — spec explicitly reuses
  the §11 rule for static serving (§4.3).
- **No `stale` field in M1** — M3 adds computation without changing the stored schema.
- **jj template strings are the riskiest unknown** (spec §22.1 previews this for M4):
  template output for bookmarks/log must be verified against the installed jj; each
  template is a named constant so fixing is local. Plan a quick spike run before
  writing `refs.ts` for real.
- **`openBrowser` on win32**: out of scope (spec §22.9) — just prints the URL.
- **Port 4800 configurability**: none in M1 (spec §22.4 undecided); scan-upward only.

## 8. Dependencies

- devDependency `typescript` (`tsc --noEmit` only). No runtime deps, no migrations.
- Requires `git` (and for jj repos `jj`) on PATH, Node ≥ 22.6 with type stripping.

## 8a. Spike findings (jj 0.46.0, Node 26.13, git 2.56 — verified)

- `jj diff` has **no `--no-color`**; use `--color never`.
- `normal_target.present()` doesn't exist in 0.46 — use plain
  `name ++ "\0" ++ normal_target.commit_id() ++ "\n"`; on error (absent
  target) catch → empty branches list (graceful per empty-data rule).
- `if(immutable, commit_id, change_id) ++ "\0" ++ commit_id ++ "\0" ++
  description.first_line() ++ "\n"` works; each record ends with a trailing
  NUL before the newline — strip trailing NUL when parsing.
- `jj log -r @ -T change_id` → bare id, no newline (trim).
- `jj file list -r <ref> -- <dir>` lists file paths only — synthesize dir
  entries client-side (next path segment, dedupe).
- Node 26: type stripping is stable and on by default; `node --test tests/`
  discovers `.ts` test files.

## 9. Order of work within the task

1. package.json / tsconfig / types.ts / cli.ts
2. main.ts + ignore upkeep + server.ts (security + static + router) — curl-checkable
3. refs.ts (spike jj templates first) + tree.ts → `/api/refs`, `/api/tree`, `/api/file` usable
4. diff.ts + chunker.ts + store.ts + session routes → full API usable via curl
5. frontend slices: api.js → app.js first screen → diffview + highlight → session view → explorer → style.css polish
6. tests: diffparse + chunker fixtures, integration; jj manual recipe
7. jj-commit at task boundary; update `.implementation/tasks/001-m1-spine.md` notes if decisions emerged

## Todo

### Phase A — Scaffolding
- [x] package.json, tsconfig.json, bin/sky-eye.js, install typescript dev dep
- [x] src/types.ts — all shared types once
- [x] src/cli.ts — run(), ApiError, VALID_REF, validateRef

### Phase B — Server core
- [x] src/ignore.ts — upsertIgnoreFile (.gitignore create, .dockerignore only-if-exists)
- [x] src/server.ts — listen w/ port scan, Host check, X-Sky-Eye check, router, static w/ containment, JSON errors
- [x] src/main.ts — startup sequence + openBrowser

### Phase C — refs + tree
- [x] src/refs.ts — git mode + jj mode discovery, stable-id resolution helpers
- [x] src/tree.ts — /api/tree (dir synthesis from jj file list), /api/file, validatePath, binary detect
- [x] Wire routes into server

### Phase D — diff, chunker, store, session API
- [x] src/diff.ts — buildDiff (git/jj), parseUnifiedDiff, diffDigest
- [x] src/chunker.ts — loadConfig + chunk() with shouldSplit predicate, chapter ids
- [x] src/store.ts — VALID_SESSION_ID, save/load/list (header cache), create pipeline, PATCH w/ 409
- [x] Wire session routes; resolve base/head to stable ids on POST

### Phase E — Frontend
- [x] public/index.html + public/api.js
- [x] public/highlight.js — line tokenizer w/ multi-line state, JS/TS/Py/Rust/Go/JSON
- [x] public/diffview.js — two-column table, escaping before highlight
- [x] public/app.js — hash router, first screen, session view (label/narrative/reviewed)
- [x] public/explorer.js — tree nav, side toggle, file view, chapter file links
- [x] public/style.css — CSS custom properties, diff/accordion/banner styles

### Phase F — Tests + acceptance
- [x] tests/diffparse.test.ts
- [x] tests/chunker.test.ts
- [x] tests/integration.test.ts (temp git repo)
- [x] tsc --noEmit clean; manual jj + git recipes; CSRF/dockerignore checks


## Implementation notes (deviations from plan)

- `ApiError` gained a `payload` field so 409 bodies carry the current session (spec §9.4) — cleaner than JSON-in-error-message.
- Node type stripping rejects TS parameter properties (`readonly` ctor args) — `ApiError` uses explicit fields.
- npm bins can't exec `.ts`; `bin/sky-eye.js` is a 2-line wrapper importing `src/main.ts`.
- Installed `typescript@5` (v7 native preview mis-resolves `@types/node`), plus `@types/node` dev dep for `tsc`.
- Binary diffs have no `---`/`+++` lines — parser now creates the FileDiff from the `diff --git a/… b/…` header and refines on `---`/`+++`.
- Fixed mid-implementation: `upsertIgnoreFile` missing trailing newline.
- Verified live: jj refs/tree/file, session create 201→200, PATCH label/narrative/reviewed persist, 409 conflict, 403 CSRF, 400 path traversal, static 404s; all 22 tests pass; `tsc --noEmit` clean.
