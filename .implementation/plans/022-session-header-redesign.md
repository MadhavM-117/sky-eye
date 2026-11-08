# Plan — 022 Session header redesign

## What changes

Rewrite the session `<header>` in `renderSession` (`src/public/app.js`) from
one crowded flex row into three stacked rows (ux §3.1, spec §18):

1. **Title row** — sky-eye home link, editable label (`#session-label`, ✎
   button — both keep existing handlers), repo badge, aliases, open-comment
   count.
2. **Context row** — full repo path (`meta.repo`, display only), head →
   base branch labels.
3. **Actions row** — primary buttons: **mark reviewed** (button, not a
   checkbox; toggles `PATCH reviewed`, shows `✓ reviewed` marked state),
   **files** (explorer link), **export** (existing download link); then a
   native `<details class="more-menu">` "more ▾" holding regenerate all,
   re-group, archive, delete — same ids as today so all existing handlers
   (rerun confirm/disable/banner, rechunk confirm, archive/delete confirms)
   keep working untouched.

Every action gets a `title` with side effects spelled out (delete →
"permanently", archive → "leaves the list, restorable from the first
screen", regenerate → mentions overwriting edited narratives, re-group →
chapter ids may move). Menu closes after an action is clicked.

## Files

- `src/public/app.js` — header HTML in `renderSession`; replace the
  `#reviewed` checkbox `onchange` in `wireSession` with a click handler on
  `#mark-reviewed` (PATCH `reviewed: !current.reviewed`, then
  `renderSession(current)` so the marked state shows).
- `src/public/style.css` — scope new rules under `header.session-header`
  (display: block + three `.h-row` flex rows) so the first-screen header
  keeps its current single-row layout; overflow menu styles; `.marked`
  state for the reviewed button.

## What could break

- Banners (stale/orphan/regenerate progress) insert after `header` via
  `insertAdjacentElement("afterend", ...)` — still one `<header>` element,
  so they still land directly below it. No change needed.
- `rerun-all` / `rechunk` handlers reference their buttons by id and set
  `textContent`/`disabled` — ids unchanged. The button is invisible while
  the menu is closed; the progress banner carries the feedback.
- First screen header uses the same `<header>` tag — new styles are
  class-scoped to avoid touching it.

## Test

No API/schema change; UI has no unit tests. Manual recipe:

1. `npm run dev` (or however the server starts) against `tmp/demo`; open a
   session.
2. Three rows visible; context row shows repo path + both branches.
3. "mark reviewed" toggles the session (button shows ✓ reviewed, first
   screen chip updates on back-navigation).
4. more ▾ opens; regenerate shows banner + disabled button; archive/delete
   still confirm and navigate home.
5. Hover any action → tooltip with side effects.
