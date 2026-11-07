# 004 — M4 Chunker tuning

## What changes

`src/chunker.ts` only (plus tests and spec/task bookkeeping):

1. **Function boundaries (§8.2):** extract funcname from `Hunk.header`
   (`@@ -a,b +c,d @@ <context>`; both git and jj emit it — §22.1 verified).
   `shouldSplit` returns true when the funcname changes between consecutive
   hunks in the same file. When no header/context is available (hand-built
   hunks in tests), fall back to the simple distance rule: > 30 unchanged
   lines between hunks (new-file space: `next.newStart − (prev.newStart +
   prev.newLines)`) → split.
2. **Keep-together (§8.4):** same file + same funcname → stay in one chapter
   past `targetLines`, up to `maxLines`. So the split condition becomes:
   flush when *context differs* OR *projected size > maxLines*.
   `targetLines` therefore only governs the no-context fallback path — that
   is what §8.2+§8.4 combined imply.
3. **Size config knob:** already done in M1 (`loadConfig`, `"review"` in
   `.sky-watch/config.json`) — no change, just covered by tests.
4. **§22.5 large-diff decision:** decide "chaptering is the virtualization;
   no swap now, `FileDiff` → `VirtualizedFileDiff` is the upgrade path if a
   real diff crawls" — write back into spec §22.5 and fix §18's speculative
   lazy-render sentence to match.

Callers of `chunk()` (store.ts session creation, remap.ts re-chunking) keep
their shape; chapter ids may shift for existing sessions — accepted (§22.3).

## Could break

- `src/remap.ts` re-chunks with the new rules — remap tests must stay green.
- Pierre rendering: chapters are separate `FileDiff` instances; boundary
  changes only regroup hunks, no adapter change.

## Tests

`tests/chunker.test.ts` fixtures: funcname change splits small hunks; same
funcname keeps past targetLines up to maxLines; distance fallback splits;
oversized keep-together capped at maxLines; existing M1 fixtures stay green.
`node --test` + `tsc --noEmit`.

## Manual verification

Run `sky-eye` on a real multi-function diff; confirm chapters break at
funcname changes and render cleanly in pierre (hunk separators within a
chapter are pierre-internal; chapter boundaries are separate sections).
