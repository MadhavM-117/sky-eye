# 017 — Archive / delete a review

**Goal:** archive a review (file moves to `.sky-watch/archive/`, out of the
active list) or delete it permanently. UI + API.

**Status:** **pending** — `POST /api/sessions/:id/archive`,
`POST /api/sessions/:id/unarchive`, `DELETE /api/sessions/:id`,
`GET /api/sessions?archived=1` (spec §10, §9.2). Session header gains
archive + delete (confirm) buttons; first screen lists archived reviews
with restore + delete. Archived sessions are not openable until restored.
