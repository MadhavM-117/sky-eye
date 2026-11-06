# 001 — M1 Spine

**Goal:** run `sky-eye` in a git or colocated jj repo, pick a base, and see a
read-only chaptered two-column diff in the browser.

Rough slices (detailed plan written when the task starts):

1. `main.ts` startup + security checks + ignore-file upkeep (spec §4, §6)
2. `refs.ts` repo detection & ref discovery, git + jj (spec §5)
3. `diff.ts` + `chunker.ts` (basic size splitting) + `store.ts` + session API (spec §7–10)
4. Frontend: first screen + session view with chaptered diff (spec §18)

**Deliverable/acceptance** (spec §21 M1): chapters visible in both repo
kinds; reload persists; CSRF mutations rejected; `.sky-watch/` ignored.

Notes: `style.css` defines all theme values as CSS custom properties from
day one. Node ≥ 22.6, type stripping, no runtime deps (spec §2).
