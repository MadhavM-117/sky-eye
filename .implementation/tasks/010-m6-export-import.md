# 010 — M6 Export/import

**Goal:** export a session as a single JSON download; import + merge
(match by comment id, newer `updatedAt` wins, nothing deleted) + digest
re-verification + remap on mismatch.

**Deliverable/acceptance** (spec §21 M6): export from repo A, resolve/edit
comments in repo B, re-import into A or a rebased clone B → edits/resolutions
kept, comments re-anchor or orphan correctly, nothing lost.

Spec: §14, §10 (export/import routes). Multi-file chapters (006) ride along
in the session JSON — no export-format change beyond the schema.

Pierre notes (after 002): none — export/import moves server JSON only; the
session file is pierre-agnostic by design (the adapter projects it fresh on
every render). No changes needed here; this line exists so the reviewer knows
the omission is deliberate.

**Status: done** — `GET /api/sessions/:id/export` sends the raw file
byte-for-byte (`{ raw, headers }` download result in `server.ts`);
`POST /api/import` → pure `mergeSessions` (newer `updatedAt` wins, older
`createdAt` breaks ties, nothing deleted; imported narrative only onto
locally unedited chapters) + remap pass on digest mismatch. Spec §14
narrative rule simplified to the implementable half (chapters carry no
timestamp — documented there). Verified live against tmp/demo: export
download, cross-machine comment edit wins on import, stale re-import
keeps the newer edit, digest-mismatch import re-anchors without orphaning.
