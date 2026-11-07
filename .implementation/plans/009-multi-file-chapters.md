# Plan 010 — Multi-file chapters

## What changes

1. **`src/types.ts`** — new `FileSlice { file, status, hunks }`;
   `Chapter.files: FileSlice[]` replaces `file`/`status`/`hunks`;
   `LineMark` gains `file: string`.
2. **`src/chunker.ts`** — remove the file-boundary split rule. Split only on:
   funcname change *within a file*, >30-line distance, or size > target.
   Keep-together keyed on `(file, funcname)` up to `maxLines`. Output chapters
   carry `files[]` slices in path order (a file appears at most once per
   chapter since hunks are path-ordered). Chapter id = sha256 over all
   slices joined by `|` (spec §8.5).
3. **`src/store.ts`** — no legacy migration (decided): a session JSON whose
   chapters lack `files[]` fails validation and is treated as absent on
   load. `.sky-watch/` is derived cache; losing old sessions/comments is
   accepted (user decision, recorded in task 009).
4. **Consumers of `chapter.file` / `chapter.hunks`** — grep callers:
   `src/routes.ts` (comment capture, orphan triage), `src/remap.ts`
   (§13.3 step 4: visibility check per `anchor.file` slice, chapterId
   re-derived from the owning chapter), `src/anchors.ts`,
   `src/main.ts`/rule classification (mark generation gains `file`),
   frontend (`src/public/app.js`, `comments.js`, `explorer.js`,
   `pierre-adapter.js`): render one chapter as stacked per-file diff blocks,
   gutter click passes the block's file, chapter header lists files.
5. **Deep links** — unchanged (`chapterId` + `file` + `line` already in the
   fragment).

## What could break

- Remap: `chapterId` no longer implies file — every lookup must go
  chapter → slice containing `anchor.file` + line. Old-side comments still
  orphan immediately (unchanged).
- Session schema: old `.sky-watch/*.json` need not load (no migration,
  decided).
- Chapter-id stability: ids differ from pre-010 sessions on the same diff
  (accepted — comments ride content anchors, not chapter ids, §13.4).
- Narrative/attention per chapter: unchanged placement, but the LLM prompt
  (M7) will receive a multi-file diff — noted for 012.

## Testing

- `tests/chunker.test.ts`: multi-file merge cases (small files join, big
  file slices alone, keep-together per (file, funcname), id stability,
  one-slice-per-file invariant).
- Store: legacy-shape session JSON is rejected/ignored on load (assert, no
  crash).
- `tests/remap.test.ts`: re-pin into a multi-file chapter sets the right
  `chapterId`; orphan when line leaves all slices of the file.
- Integration test untouched except where fixtures assert chapter shapes.
