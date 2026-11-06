# 006 — M6 Export/import

**Goal:** export a session as a single JSON download; import + merge
(match by comment id, newer `updatedAt` wins, nothing deleted) + digest
re-verification + remap on mismatch.

**Deliverable/acceptance** (spec §21 M6): export from repo A, resolve/edit
comments in repo B, re-import into A or a rebased clone B → edits/resolutions
kept, comments re-anchor or orphan correctly, nothing lost.

Spec: §14, §10 (export/import routes).
