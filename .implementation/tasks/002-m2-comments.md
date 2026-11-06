# 002 — M2 Comments

**Goal:** click a diff line, comment, resolve, persist — with author identity
from jj/git config and content anchors captured on every write.

**Deliverable/acceptance** (spec §21 M2): comment → resolve → reload, all
persists with correct author (or "anonymous"); anchors stored with
before/after context.

Spec: §12 (comments & anchors), §15 (identity), composer UX is designed
here (U§4 deferred block) — check in with the user on the composer design
before building it.
