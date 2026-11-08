# Plan: Semantic chunking (LLM-assisted chapter grouping)

Feature dir: `./tmp/plans/semantic-chunking/` — this file is the working plan.
It also includes, as its first execution step, creating the repo's own
implementation-plan + task files under `.implementation/` (per `process.md`)
and updating `docs/`.

## Goal

Chapter splitting stops being purely mechanical (funcname/size/distance rules
in `src/chunker.ts`) and becomes **semantic**: an LLM/decision model groups the
diff's hunks into chapters that each represent one conceptual change. The
analysis (grouping + per-chapter title) happens in the same pass. The decision
model classifier then receives each chapter **with its title** as context.
Slow is acceptable — the user gets a loader.

Non-goals: streaming, changing narrative/classify flows beyond reusing the
titles, a UI config editor for chunk settings.

## Current behavior (verified in code)

- `chunk()` in `src/chunker.ts`: greedy, pure. Split rules in `shouldSplit()`:
  same `(file, funcname)` keeps together up to `maxLines` (200); different
  funcnames in one file always split; no-context fallback splits on
  `targetLines` (75) or >30 unchanged lines distance; cross-file never splits
  by itself. Chapter id = 12-hex sha256 over all slices' first-hunk ranges
  (§8.5).
- The one rebuild pipeline is `chaptersFromDiff()` in `src/store.ts:163`:
  `parseUnifiedDiff → chunk → withAttention (rules marks) → applyClassifier`.
  Called from `createSession` (store.ts:212), jj refresh (remap.ts:191) and
  git supersede (remap.ts:235). Already `async`.
- LLM layer `src/llm.ts`: `resolveTask(root, task)` for `"narrate" | "classify"`,
  three adapters (openai / anthropic / custom exec), degrade-don't-block.
- Classifier pass `src/custom-classifier.ts` (`classifierRequest` builds the
  stdin payload: chapters with id + files + changed lines; protocol 1) and
  `src/decisions.ts` (OpenRouter decision API; per-line `q<N>` questions, a
  per-chapter `state` string and per-question `instructions`).
- Narration `src/narrate.ts`: `chapterTitle()` = file list; feeds
  `otherTitles` in prompts; accordion header shows it.
- Loader precedents: narrative spinner (`analyzing…` in `src/public/app.js:321`),
  rerun-all banner (`regenerating marks + narratives…`, app.js ~591).
- Frontend session creation: `POST /api/sessions` in `src/public/app.js:151`.

## Approach

Add a third LLM task **`chunk`**. When `.sky-watch/config.json` resolves a
`tasks.chunk` adapter, the rebuild pipeline makes one blocking LLM call that
gets a compact hunk inventory and returns a grouping of hunks into titled
chapters. Everything else (rules marks, classifier pass, chapter ids, anchors,
remap) runs unchanged on top of the semantic grouping. Any failure or missing
config falls back to today's pure chunker — the session is never blocked
(§16.1 rule extended to chunking).

Chapter ids keep the §8.5 hash-of-slices formula, so anchors, deep links and
comment remapping need no changes. Determinism note (goes to spec §22): the
grouping comes from a model, so re-running the chunker on an identical diff
is no longer guaranteed to reproduce ids — but nothing re-chunks the same
diff within a session's life (rerun-all explicitly doesn't re-chunk), so this
matches the existing "ids break when the diff changes" contract.

### Why this shape (trade-offs)

- **One blocking call for the whole diff** (not per-chapter): the model needs
  the whole picture to make semantic groups, and grouping + titles + analysis
  in one response is exactly the "same step" the user asked for.
- **Blocking creation instead of async re-chunk**: alternative considered —
  create the session immediately with rule-based chapters, upgrade in the
  background, poll. Rejected: replacing chapters after comments exist would
  force running the §13.3 remap pass against fallback chapters, poll
  machinery in the UI, and a second LLM round trip — much more code for a
  wait the user explicitly accepts. Creation stays blocking; the frontend
  shows a spinner for it (it already awaits the POST).
- **`title` only, no `summary` field on `Chapter`**: the one-line title is the
  analysis that feeds accordion, classifier context and `otherTitles`. A
  longer summary would collide with the narrate flow (narrative is the
  summary, lazily generated, user-editable).
- **maxLines guardrail survives**: the LLM may group too greedily; any
  semantic chapter over `maxLines` is re-split with the pure chunker on its
  own hunks. This preserves the renderer's virtualization guarantee
  (spec §22 open question 5: no chapter render exceeds 200 changed lines).
- **New file `src/semantic-chunk.ts`**, not extending `chunker.ts`: the pure
  chunker stays pure/dependency-free (design D§3 note), and the semantic
  path needs the LLM layer.

## Detailed changes

### 1. `src/types.ts` — type additions

```ts
// Chapter: add optional title (semantic chunking; absent = file-list title)
export interface Chapter {
  id: string;
  files: FileSlice[];
  narrative: string;
  narrativeEdited?: boolean;
  title?: string; // one-line semantic description, set by the chunk task
  attention: LineMark[];
}

// LlmConfig.tasks gains chunk
tasks?: { narrate?: LlmTaskConfig; classify?: LlmTaskConfig; chunk?: LlmTaskConfig };

// LlmRequest.task union: "narrate" | "classify" | "chunk"
```

Additive schema change; the session store serializes whatever is there and
import-merge tolerates missing fields. Note the schema change per
`process.md` ("pause and ask" triggers) — this plan IS the check-in.

### 2. `src/llm.ts` — allow the `chunk` task

Widen the task union in `resolveTask` and `resolveTaskConfig`:

```ts
function resolveTaskConfig(config: LlmConfig | undefined, task: "narrate" | "classify" | "chunk") ...
export function resolveTask(root: string, task: "narrate" | "classify" | "chunk"): LlmAdapter | undefined
```

No adapter changes — all three backends already take `{ task, system, prompt }`.

### 3. New `src/semantic-chunk.ts` — the semantic pass

```ts
// Semantic chapter grouping (spec §8a): one LLM call over a compact hunk
// inventory → titled chapters. Degrade contract (§16.1): no adapter, a
// failed/malformed call, or an oversized inventory falls back to the pure
// chunker — the session never blocks on the LLM layer.
import { chunk, chapterId } from "./chunker.ts";
import { call } from ... // or local copy of the degrade wrapper (see below)
```

Exported pieces (each pure except the adapter call, all fixture-testable):

- `hunkInventory(files: FileDiff[]): { id: string; file: string; status: string; funcname: string | null; oldStart; oldLines; newStart; newLines; changed: number; text: string }[]`
  — hunk ids `h0…hN-1` in path-then-position order; `funcname` via the same
  header regex as `funcOf`; `text` = the hunk's changed lines joined,
  **capped at 40 lines per hunk** with an elision marker (prompt-size guard
  for huge hunks).
- `chunkSystemPrompt()` — constant, in the house style of
  `narrateSystemPrompt()`: "You group the hunks of a code review diff into
  chapters, each covering one semantic change… order chapters the way a
  reviewer should read them… aim for ~50–100 changed lines per chapter, never
  over 200… Reply with ONLY JSON:
  `{"chapters":[{"title": "...", "hunks": ["h0","h3"]}]}` — every hunk id
  exactly once."
- `chunkUserPrompt(inventory, config: ReviewConfig)` — the inventory as a
  compact table plus the size targets.
- `parseChunkResponse(raw, inventory)` — JSON.parse; keep entries whose hunk
  ids exist and appear exactly once; a hunk id used twice is dropped from the
  later group (first wins); unknown ids ignored. Titles: trim, cap 80 chars,
  empty → undefined. Malformed JSON → throw (caller degrades).
- `buildChapters(groups, files: FileDiff[], config: ReviewConfig): Chapter[]`:
  1. For each group: collect its hunks, per file in path order → `FileSlice`s
     (hunks stay in position order); skip empty groups.
  2. Guardrail: if a group's changed-line count > `config.maxLines`, re-split
     that group with `chunk(fileDiffsOf(group), config)` — its slices become
     their own chapters (title applies only to the first; the rest get no
     title). Never split an individual hunk.
  3. Chapter id via the existing `chapterId(slices)` — unchanged formula.
  4. Chapters carry `title` from the group (undefined for guardrail splits).
  5. Leftover hunks (model missed them, or no valid groups at all): run the
     pure `chunk()` over them and append those chapters at the end.
- `semanticChunk(adapter: LlmAdapter, root: string, files: FileDiff[], config: ReviewConfig): Promise<Chapter[] | undefined>`
  — inventory → one `adapter.call({ task: "chunk", ... })` through a
  `call()` wrapper identical to narrate.ts's (catch → console one-liner →
  undefined). Returns undefined on any failure → caller uses the pure chunker.

Chapter **order** = the model's returned order (semantic reading order),
replacing the current alphabetical-file order. A no-config session keeps
path order — fine, they're different modes; `ux.md` notes it.

### 4. `src/store.ts` — pipeline change

```ts
export async function chaptersFromDiff(root, diffText, ids) {
  const rules = loadClassifyRules(root);
  const fileDiffs = parseUnifiedDiff(diffText);
  const config = loadConfig(root);
  const adapter = resolveTask(root, "chunk");
  const semantic = adapter ? await semanticChunk(adapter, root, fileDiffs, config) : undefined;
  const chapters = (semantic ?? chunk(fileDiffs, config)).map((c) => withAttention(c, rules));
  await applyClassifier(root, ids.base, ids.head, chapters);
  return chapters;
}
```

Same call sites (creation, jj refresh, git supersede) get semantic grouping
for free. Prompt-size circuit breaker (in `semanticChunk`): if the inventory
exceeds a sane budget (e.g. > 2000 hunks or > 400 KB of text) return
undefined before calling the model — chunking a monster diff semantically is
worse than the heuristic. Tunable constant at the top of the module.

### 5. Classifier gets chapter context (the user's explicit requirement)

- `src/custom-classifier.ts` — `classifierRequest()` adds `title: c.title`
  to each chapter object in the payload (undefined → omit the key). Additive:
  exec hooks that ignore it keep working, so **protocol stays 1**; document
  the new optional field in spec §16.5 for hook authors.
- `src/decisions.ts` — the decision API carries context via `instructions`
  and `state`. Change: prefix each chapter's block in `state` with its title
  (`## "title" — files`) and append the title to that chapter's questions'
  `instructions` (`Chapter context: "<title>"`). Verify at implementation
  that OpenRouter tolerates per-question instruction variance (already does —
  instructions are currently built per line). Mark this as a
  **verify-at-implementation** point; if the API normalizes instructions,
  fall back to title-in-state only.

### 6. Narration reuses the titles

`src/narrate.ts` — `chapterTitle()` prefers the semantic title:

```ts
export const chapterTitle = (chapter: Chapter) =>
  chapter.title ?? `${chapter.files.map((f) => f.file).join(", ")}`;
```

No other narrate changes — `otherTitles` and the accordion both call it.
Same-adapter shared calls (`a.narrate.id === a.classify.id`) are untouched.

### 7. API: re-chunk endpoint

`src/routes.ts` + new `rechunkSession` in `src/remap.ts` (it already owns
rebuild + carry-over machinery):

```ts
// POST /api/sessions/:id/rechunk — rebuild chapters on the stored diff
// (semantic grouping when tasks.chunk is configured), carrying over
// narratives by chapter id and comments via the §13.3 remap pass. Chapter
// ids may move → same 409 needsConfirm gate as rerun for edited narratives.
export async function rechunkSession(root, kind, session: Session): Promise<Session> {
  if (session.chapters.some((c) => c.narrativeEdited))
    throw new ApiError(409, "narrative edited", { error: "narrative edited", needsConfirm: true });
  const diffText = await buildDiff(root, kind, session.base, session.head); // stored-diff rebuild
  const oldChapters = new Map(session.chapters.map((c) => [c.id, c]));
  session.chapters = carryNarratives(
    await chaptersFromDiff(root, diffText, { base: session.base, head: session.head }),
    oldChapters,
  );
  session.diffDigest = diffDigest(diffText);
  await remapComments(root, kind, session);
  return persistSession(root, session);
}
```

Export `carryNarratives` from `remap.ts` (currently module-private). Route:

```ts
route("POST", "/api/sessions/:id/rechunk", async ({ root, kind, params }) =>
  rechunkSession(root, kind, loadSession(root, sessionId(params.id))));
```

Note: `buildDiff(root, kind, base, head)` on the same refs reproduces the
stored diff (jj refresh does exactly this) — no new diff storage needed.

### 8. Frontend — loaders + title rendering (`src/public/app.js`, `style.css`)

- **Creation loader** (`app.js:151` POST handler): while the request is in
  flight, disable the submit button and show a banner
  `<div class="banner">analyzing diff into chapters…</div>` above the form —
  same pattern as the rerun-all banner. Reuse the existing `.spinner` class
  (style.css:150) inside the banner. On success/failure, remove it.
- **Accordion header** (chapter title, app.js ~332 area): render
  `chapter.title ?? chapterTitleFallback(chapter)` (the current file-list
  text). Narratives and deep links key on chapter ids — untouched.
- **Re-chunk control**: button next to `#rerun-all`, id `rechunk`, label
  `re-group`; handler mirrors rerun-all (disable + banner
  `re-grouping chapters…`, on `e?.needsConfirm` confirm-dialog → retry with
  the same call since the endpoint gates server-side via 409 → actually
  mirror rerunChapterUi's confirm flow: client asks first when
  `some(narrativeEdited)`, then sends; 409 still handled defensively).
  After success `renderSession(current)`.

### 9. Tests (per spec §20: pure logic as fixtures, CLIs only at boundaries)

New `tests/semantic-chunk.test.ts`:
- inventory: funcname extraction, 40-line cap, id ordering;
- `parseChunkResponse`: valid grouping; duplicate hunk id (first wins);
  unknown id; empty title; malformed JSON throws;
- `buildChapters`: slices built per file in path order; oversized group
  re-split (≤ maxLines per resulting chapter, no hunk split); leftovers
  appended via pure chunker; chapter ids equal what `chapterId` computes for
  the same slices; title set/preserving.

Existing files:
- `tests/chunker.test.ts` — unchanged (pure path must stay green).
- `tests/llm.test.ts` — `resolveTask(root, "chunk")` resolves/skips per config.
- `tests/custom-classifier.test.ts` — payload carries `title`; absent title
  omitted.
- `tests/decisions.test.ts` — title appears in state + question instructions.
- `tests/narrate.test.ts` — `chapterTitle` prefers `title`.
- `tests/integration.test.ts` — POST `/api/sessions/:id/rechunk`: 409 on
  edited narrative; carries narratives/comments when grouping changes; and a
  config-less session creation still produces rule-chunked chapters
  (fallback path end-to-end).

## Dependencies

None. Uses the existing adapter layer (openai/anthropic/custom exec). No new
packages; tests stay on the existing runner (`node --test` style per repo).

## Execution steps (in order)

1. **Bookkeeping first** (required by `process.md` step 2):
   - Create `.implementation/tasks/019-semantic-chunking.md` (short task
     description, acceptance criteria: semantic grouping when configured,
     fallback everywhere on failure, classifier sees titles, loader visible,
     docs updated).
   - Copy this plan to `.implementation/plans/019-semantic-chunking.md`.
   - Update `.implementation/tasks/000-index.md` with task 019.
2. **Docs** (source of truth before code, per AGENTS.md — details below).
3. `src/types.ts` → `src/llm.ts` (task plumbing).
4. `src/semantic-chunk.ts` + `tests/semantic-chunk.test.ts`.
5. `src/store.ts` pipeline change.
6. Classifier context (custom-classifier.ts + decisions.ts) + their tests.
7. `src/narrate.ts` title preference + test.
8. `src/remap.ts` (`carryNarratives` export, `rechunkSession`) + `src/routes.ts`.
9. Frontend (app.js, style.css) — loader, titles, re-chunk button.
10. Full test run; manual recipe below; jj commit (conventional, per repo).

## Docs updates (explicit, section by section)

### `docs/spec.md`
- **§8** — add subsection **"8a. Semantic chunking (`tasks.chunk`)"**:
  algorithm (inventory → one LLM call → grouping), validation rules (every
  hunk exactly once, leftovers to the pure chunker), maxLines guardrail
  (re-split oversized groups with §8 rules, never split a hunk), chapter
  ordering = model order, chapter-id formula unchanged (§8.5), degradation =
  pure chunker (§16.1 rule), config knob = `tasks.chunk` (`LlmTaskConfig`,
  same adapter model as narrate/classify), prompt-size circuit breaker.
- **§9.3 / data model** — `Chapter.title?: string` (source: chunk task;
  omitted by the pure chunker).
- **§10 route table** — add `POST /api/sessions/:id/rechunk` row (request
  `{}`; 409 `needsConfirm` when any narrative is edited; response = updated
  session).
- **§16.1** — task list becomes narrate/classify/**chunk**; chunk inherits
  the degradation contract; note `timeoutMs` should be generous for big
  diffs (recommend 180_000 in the example config).
- **§16.5** — classifier protocol: chapters in the request payload carry the
  optional `title` field (additive, protocol stays 1); decisions backend
  gets the title in `state` + question instructions.
- **§16.2/§16.3** — `otherTitles` now uses semantic titles when present.
- **§16.6** — note rechunk as the explicit "regenerate grouping" counterpart
  (rerun-all still does NOT re-chunk; unchanged contract).
- **§20** — testing additions for the new module.
- **§22 Open questions** — record the determinism decision: semantic
  grouping is model-derived, so §8.5's "stable under re-running on an
  identical diff" holds only for the pure chunker; accepted because nothing
  re-chunks an unchanged diff within a session (refresh/rerun-all own the
  other paths). Also note creation is now as slow as the chunk call when
  configured — accepted (loader shown).

### `docs/design.md`
- §3 feature-map row 2 (chapters): mention semantic mode with pure fallback.
- D§4 data model: `Chapter.title`.
- D§6a narrative: `otherTitles` context now semantic titles.
- D§8 testing: new fixtures.

### `docs/ux.md`
- Session creation: spinner + "analyzing diff into chapters…" banner while
  the create call runs (may take a while when semantic chunking is on).
- Chapter accordion: title line = semantic title when present, else file
  list; semantic chapters appear in model-proposed reading order (not path
  order).
- New `re-group` control next to regenerate; same confirm/banners pattern.

### Bookkeeping (step 1) files
- `.implementation/tasks/019-semantic-chunking.md` (new)
- `.implementation/plans/019-semantic-chunking.md` (copy of this plan)
- `.implementation/tasks/000-index.md` (append task 019 entry)

## Todo

### Bookkeeping
- [x] Create `.implementation/tasks/019-semantic-chunking.md` + update `.implementation/tasks/000-index.md`
- [x] Copy plan to `.implementation/plans/019-semantic-chunking.md`

### Docs
- [x] spec.md: §8a semantic chunking, Chapter.title (§9.3), rechunk route (§10), §16.1/2/3/5/6, §20, §22
- [x] design.md: §3 row 2, D§4, D§6a, D§8
- [x] ux.md: creation loader, accordion title, re-group control

### Code
- [x] types.ts: Chapter.title, tasks.chunk, LlmRequest.task
- [x] llm.ts: widen task union
- [x] semantic-chunk.ts: inventory, prompts, parse, buildChapters, semanticChunk
- [x] store.ts: chaptersFromDiff pipeline change
- [x] custom-classifier.ts: title in classifierRequest
- [x] decisions.ts: title in state + instructions
- [x] narrate.ts: chapterTitle prefers title
- [x] remap.ts: export carryNarratives, rechunkSession
- [x] routes.ts: POST /api/sessions/:id/rechunk
- [x] app.js + style.css: creation loader, accordion title, re-group button

### Tests
- [x] tests/semantic-chunk.test.ts (new)
- [x] tests/llm.test.ts, custom-classifier.test.ts, decisions.test.ts, narrate.test.ts, integration.test.ts updates

### Verify
- [x] Full test run green
- [x] Manual recipe note + jj commit

## Risks / verify at implementation

- **OpenRouter decision API** tolerance for title-augmented
  `state`/`instructions` — verify live; fallback documented (§5).
- **Prompt size on huge diffs** — circuit breaker in `semanticChunk`
  (constant, fixture-tested as a threshold check).
- **Model output quality** — validation + guardrails make bad output merely
  suboptimal, never broken (fallback chunker, maxLines re-split, missing
  hunks appended).
- **Create-request duration** — LLM timeouts default 120s; failed chunk =
  instant fallback, so worst case is the old behavior plus one timeout.
  Server has no request timeout at the route layer (verified: routes are
  plain async handlers) — the adapter's `timeoutMs` is the bound.
