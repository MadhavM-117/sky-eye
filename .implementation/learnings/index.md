# Learnings

One file per topic, `<topic>.md`. Written **while implementing** — the moment
a lesson is learnt, not later. Each entry is 1–3 lines. If a learning
contradicts the specs or process.md, update those instead and delete the entry.

Format inside a file: a bullet list, newest entries at the bottom, optionally
grouped under a heading. No narratives, no dates unless a decision is
time-sensitive.

Only consult these files when the topic is relevant to the current task —
the index is the lookup table, files are read on demand.

- chapter-model.md — Chapter shape (multi-file slices), session load/create
  paths, frontend diff-instance keys
- config.md — config.json loaders are per-concern (module owns its keys)
- openrouter-decisions.md — OpenRouter decision-model API envelope, endpoint path, apiKey resolution chain
- server-protocol.md — route result shapes ({status,value}, {raw,headers}), security checks order
- pierre-packages.md — gotcha (task 015): pierre `File` renders nothing when
  the file's language isn't preloaded; preload via `getSharedHighlighter` before render
