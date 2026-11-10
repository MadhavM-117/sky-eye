# 008 — Custom classifier hook (plan)

Full implementation plan with user-confirmed decisions:
`tmp/plans/custom-classifier/plan.md` (decision record a–d, protocol v1,
file-by-file changes, spec amendments — all already folded into
`docs/spec.md` §9.3/§16.1/§16.3/§16.5 and the task files).

Outline (see the full plan for details):

1. `src/types.ts` — `MarkName` extensible (`focus|glance|safe | (string & {})`),
   `markSource` + `"custom"`, `ClassifierConfig`.
2. `src/classify.ts` — `ClassifyRules { safePaths?, focusPaths? }` globs
   appended after built-in buckets; `globToRegExp` lives here (pure).
3. `src/custom-classifier.ts` (new) — config loader, request builder
   (changed lines only), response parser (per-coordinate validation, drop
   invalid), spawn via `/bin/sh -c` (timeout), merge/fallback semantics,
   one-run rotated `classifier.log`. No store import → no cycle.
4. `src/store.ts` — `chaptersFromDiff(root, diffText, { base, head })` is
   the single rebuild pipeline; used by `createSession` and both `remap.ts`
   sites (jj refresh, git successor).
5. `src/main.ts` — `sky-eye debug-classify <sessionId>` before the
   server-start branch; replay without writing session or log.
6. `public/comments.js` + `style.css` — unknown marks → neutral muted chip;
   class name sanitized.
7. Tests — `tests/custom-classifier.test.ts` (fixtures), `classify.test.ts`
   (glob precedence), `integration.test.ts` (happy + failure path via
   scripted classifier).
8. Demo — `tmp/demo/classifier.mjs` + `.sky-eye/config.json` for the
   M5.1 acceptance walkthrough.
