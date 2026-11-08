# 022 — Session header redesign (three-line layout, grouped actions)

**Goal:** the session header stops being one crowded row (ux §3.1, spec
§18). Three lines: **title row** (editable label, repo-kind badge, aliases,
open-comment count), **context row** (full repo path `meta.repo`, head
branch, base branch), **actions row** grouped primary-first — primary
buttons: **mark reviewed** (a button, not a checkbox; shows marked state
when reviewed, clicking toggles), files (explorer), export; a collapsible
"more ▾" menu holds regenerate all, re-group, archive, delete. Every action
shows hover help text explaining what it does, side effects included.
Refresh stays in the stale banner.

**Acceptance criteria:**
- Header renders the three rows; context row shows the full repo path and
  both branch names (aliases keep their place in the title row).
- `reviewed` is a button wired to the existing `PATCH reviewed` toggle — no
  checkbox input anywhere in the header; the first screen's reviewed chip
  is unchanged.
- Primary actions visible; regenerate / re-group / archive / delete live in
  the overflow menu (delete still confirms; regenerate still disables with
  the progress banner while running).
- All actions have hover help text (native `title` is fine — a custom
  tooltip is not required).
- No API or schema change; stale/orphan banners still render directly below
  the header.

Plan: `.implementation/plans/022-session-header-redesign.md` (to write at
task start)
