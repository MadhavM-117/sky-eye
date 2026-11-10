# 001 — M1 Spine

**Goal:** run `sky-eye` in a git or colocated jj repo, pick a base, see a
chaptered two-column diff with syntax highlighting, edit session labels and
chapter narratives, and browse repository files at base/head in the explorer.

Rough slices (detailed plan written when the task starts):

1. `main.ts` startup (`127.0.0.1` bind) + security checks + ignore-file upkeep (spec §4, §6)
2. `refs.ts` repo detection & ref discovery, git + jj (spec §5) + `tree.ts` VCS file explorer (`/api/tree`, `/api/file`, spec §11)
3. `diff.ts` + `chunker.ts` (basic size splitting) + `store.ts` + session API (`GET/POST/PATCH /api/sessions`, spec §7–10)
4. Frontend: first screen + session view with chaptered diff + file explorer (`explorer.js`) + syntax highlighter (`highlight.js`) (spec §18–19)

**Deliverable/acceptance** (spec §21 M1): highlighted chapters and file
explorer visible in both repo kinds; label/narrative edits and reload persist;
CSRF mutations rejected; `.sky-eye/` ignored without creating `.dockerignore`
in non-Docker repos.

Notes: `style.css` defines all theme values as CSS custom properties from
day one. Node ≥ 22.6, type stripping. **Update:** shipped with the
hand-rolled `diffview.js`/`highlight.js` before the dependency policy was
revised (spec §2); slice 4 is superseded by task `002` — delete those files
in favor of `@pierre/*`.
