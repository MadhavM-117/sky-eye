# 008 — Custom classifier hook

**Goal:** end users plug in their own classifier — an executable command
taking a JSON request on stdin and returning marks as JSON on stdout. It
*becomes* the classifier at every chapter rebuild (creation, refresh,
supersede); the built-in rule pass stays as the base/fallback layer. Marks
are customizable: the mark vocabulary is extensible (unknown names render
as a neutral chip) and `classifyRules` adds `safePaths`/`focusPaths` globs
to the built-in buckets.

**Deliverable/acceptance** (spec §21 M5.1): a scripted classifier in
`tmp/demo` → session creation shows `markSource: "custom"` marks; broken
classifier → rules fallback (or cleared with `fallback:false`); every run
logged to `.sky-watch/classifier.log`; `sky-eye debug-classify <sessionId>`
prints the transcript.

Spec: §16.5 (protocol), §16.1 (config keys), §16.4 (rules extension),
§9.3 (`markSource: "custom"`, extensible `mark`). Full implementation plan:
`tmp/plans/custom-classifier/plan.md`.

Notes:
- Merge semantics: sparse custom marks override rules marks per
  `(file, side, line)`; unmarked lines keep rules marks. LLM pass (010)
  overwrites only `markSource: "rules"` marks — custom marks are protected.
- Future built-in classifiers (LLM-backed, custom decision models such as
  Jev) speak the same protocol — separate task, out of scope for v1.

**Done** (`src/custom-classifier.ts`; rebuild pipeline unified in
`store.ts → chaptersFromDiff` used by create/refresh/supersede; demo
classifier + config in `tmp/demo`; verified: custom marks in session,
fallback/fallback:false paths, log rotation, `debug-classify` transcript).
