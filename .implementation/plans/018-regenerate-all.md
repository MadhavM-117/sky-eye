# Plan 018 — Regenerate everything (rerun-all)

## Design decisions (spec §16.6 updated)

- Scope: rules marks (§16.4) + classifier pass (§16.5) + narrate/LLM marks
  for every chapter — in place, on the stored diff. The diff itself is NOT
  re-generated (refresh, §13, owns that).
- Reuse: extract the narration core of `rerunChapter` (head-contents fetch,
  shared/classify calls, mark application) into an internal
  `narrateOne(...)`; `rerunChapter` = find + 409 guard + `narrateOne` +
  persist (behavior unchanged); `rerunAll` = rules rebuild + classifier +
  one 409 guard + `narrateOne` loop + single persist.
- Order matters: rules → classifier → narrate, because `applyLlmMarks` only
  overwrites `markSource: "rules"` marks, so custom-classifier marks survive
  the narrate pass (§9.3, §16.5 semantics).
- 409 gate: if any chapter has `narrativeEdited` and `confirm !== true` →
  409 `needsConfirm` (one gate for all chapters, not per chapter). UI asks
  once via `confirm()`.

## Change

- `src/narrate.ts`: extract `narrateOne`, add `rerunAll(root, kind, session,
  confirm, adapters?)` (needs `loadClassifyRules` + `classifyChapter` +
  `applyClassifier` imports).
- `src/routes.ts`: `POST /api/sessions/:id/rerun-all`.
- `src/public/app.js`: "regenerate" button in the session header (next to
  export); confirm when any `narrativeEdited`, then `mut("POST", .../rerun-all,
  { confirm: true })` and re-render.
- `tests/narrate.test.ts`: fixture with two chapters + fake adapters —
  409 without confirm on edited narrative; with confirm both chapters
  narrated (adapter called twice), rules marks rebuilt before narrate,
  single persist.

## What could break

- `rerunChapter` behavior must not change (existing narrate tests guard it).
- No config → `rerunAll` is a no-op-ish: rules marks still rebuild (rules
  are config-free), classifier/narrate skip — document in the response path
  (returns the session).
