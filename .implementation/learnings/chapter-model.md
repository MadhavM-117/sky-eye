# Chapter model

- Legacy-schema sessions: the legacy guard must live in **both** load paths —
  `loadSession` (404) *and* `createSession`'s exists-branch, which bypasses
  `loadSession` and would silently return old-shape sessions for a reused
  `<base>..<head>` id.
- Frontend `diffs` map was keyed by chapterId alone; multi-file chapters need
  `chapterId\u0000file` (NUL is safe — filenames can't contain it). Deep-link
  scroll and triage scroll must use the same key.
- Full-file mode (task 023): the adapter pads stored hunks into ONE hunk
  (`fullFileHunks`) — old-side total derives exactly as `newTotal − adds +
  dels`; no header is stored, patchText's default format renders `-0,0` for
  added files. Unchanged-line comments (§13.3.5) are pinned to the FIRST
  chapter carrying the file; they ride `annotationsFor` only when the block
  is in full-file mode (filtered by `lineInSlice` otherwise).
- Full-file toggle-off (task 023 feedback): the rebuild path is shared by
  toggle-off AND re-renders — any "rebuild the holder" helper must branch on
  the mode BEFORE fetching (off-by-one here made diff view re-pad forever).
- Default session title (feedback, ux §3.1): review order
  `<current branch> → <base branch>`, stored at creation when both labels
  exist; display falls back via `displayTitle()` for label-less sessions.
