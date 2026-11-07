# 007 — M5 Attention marks — plan

Spec: §16.4 (rules), §9.3 (`LineMark`/`markSource`), §21 M5, §18 (marks ride
pierre's annotation framework). Task doc notes: `LineMark.file` from 006;
LLM marks (009) reuse the same projection with a different `markSource`.

## Scope

1. **`src/classify.ts` (new, pure)** — rule pass, one mark per *changed*
   line (add → side `new`/`newLine`, del → side `old`/`oldLine`; ctx lines
   are untouched, never marked):
   - precedence: path-safe → safe; comment-only line → safe; focus path or
     focus keyword → focus; else glance.
     (A comment line never warrants focus; a test file is safe even when it
     exercises auth.)
   - safe paths: basename contains `test`/`spec` or `__tests__/` segment;
     lockfiles (package-lock.json, Cargo.lock, uv.lock, pnpm-lock.yaml,
     yarn.lock, poetry.lock, go.sum); `*.md`; generated (`*.min.js|.min.css`,
     `dist/` segment).
   - focus paths: `auth/` segment, path contains `payment`/`token`/`secret`.
   - focus keywords per line: `\b(await|async|try|catch|throw)\b`;
     crypto/password/permission/SQL: password, passwd, secret, encrypt,
     decrypt, crypto, cipher, salt, hash, permission, grant, revoke,
     select, insert, update, delete, drop (`\b`, case-insensitive).
   - `classifyChapter(chapter)` fills `Chapter.attention` from all slices;
     called at every chapter-rebuild site so refresh/supersede re-classify.
2. **`src/store.ts`** — `createSession`: fill attention after `chunk(...)`.
3. **`src/remap.ts`** — same at both chunk sites (jj in-place refresh, git
   successor).
4. **`pierre-adapter.js`** — `commentAnnotations` grows a third param
   `marks = []`: marks join the same byLine map (side:line), stored in
   `metadata.marks`. One annotation row per line can then carry a mark,
   comments, and a composer together.
5. **`comments.js`** — `markNode(mark)`: small glyph+label span
   (`◆ focus` / `▲ glance` / `● safe`), class `sky-mark sky-mark-<mark>`.
6. **`app.js`** — `annotationsFor` passes the chapter's marks for that file;
   `annotationRow` renders mark nodes ahead of comment nodes.
7. **`style.css`** — CSS custom properties `--mark-focus` (deleted/red),
   `--mark-glance` (warning/amber), `--mark-safe` (added/green), mapped from
   the existing palette; rows are light-DOM so document styles reach them.

No schema change (`LineMark` already in types.ts from 006). No new
dependency. LLM marks (009) later overwrite only `markSource: "rules"` —
rules marks are always machine-owned, no UI to edit them in v1.

## Test plan

- `tests/classify.test.ts` — fixtures per rule bucket + precedence + side/
  line mapping + ctx skipped.
- `tests/adapter.test.ts` — mark projection: mark alone; mark + comment on
  same line grouped in one annotation.
- Integration smoke: created sessions carry non-empty attention (assert in
  existing integration create flow if cheap).
