# 002 — M2 Comments

**Goal:** click a diff line, comment, resolve, copy/open deep links, persist —
with author identity from jj/git config and server-side content anchors
captured on creation and re-pin.

**Deliverable/acceptance** (spec §21 M2): comment → resolve → deep link →
reload, all persists with correct author (or "anonymous"); anchors stored on
the server with 3-line before/after context from the VCS file even at hunk
boundaries.

Spec: §12 (comments & anchors), §15 (identity), §17 (deep links), composer UX
is designed here (U§4 deferred block) — check in with the user on the composer
design before building it.

Pierre notes (after 008): comments render through `@pierre/diffs`' line-
annotation framework, not hand-built DOM overlays — extend the adapter to
project stored `Comment`s (side, line, text, resolved) onto FileDiff
annotations and translate gutter clicks to the composer via the selection
API. Resolved comments collapse to a one-line summary — that collapse is our
UI around the annotation, not a pierre feature. Deep-link scroll/flash targets
the annotation's DOM node (`scrollToPath`-style helpers or manual scroll).
See `.implementation/docs/pierre-packages.md` before starting.
