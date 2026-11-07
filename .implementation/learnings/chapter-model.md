# Chapter model

- Legacy-schema sessions: the legacy guard must live in **both** load paths —
  `loadSession` (404) *and* `createSession`'s exists-branch, which bypasses
  `loadSession` and would silently return old-shape sessions for a reused
  `<base>..<head>` id.
- Frontend `diffs` map was keyed by chapterId alone; multi-file chapters need
  `chapterId\u0000file` (NUL is safe — filenames can't contain it). Deep-link
  scroll and triage scroll must use the same key.
