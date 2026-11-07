# Plan 015 — Full-file renderer fix

## Investigation result (reproduced headlessly with CDP against tmp/demo)

- `createFileView` (pierre-adapter.js) builds `new File({ theme, disableFileHeader: true })`
  and renders `{ file: { name, contents }, containerWrapper }`.
- Observed: `render()` returns `true`, the `<diffs-container>` exists, but the
  shadow root contains only the SVG sprite — no header, no code rows. No
  console errors.
- Isolation: chapter diffs (`FileDiff`) render fine in the same session, so
  it's not the server, bundle, or environment.
- Pierre internals (`@pierre/diffs` 1.6.4): `FileRenderer.renderFile` skips the
  synchronous paint when the file's language isn't loaded
  (`hasLangs === false`) and defers to `asyncHighlight`. When the highlight
  result arrives, `applyHighlightResult → onRenderUpdate → rerender` fires,
  but `File.render`'s early return (`nothing changed`: same file, no
  annotation/theme change, no forceRender) swallows the re-render —
  `applyCachedThemeState` returns true and the code rows are never painted.
  The initial plain paint never happened either, so nothing is on screen.
- Proof: preloading the language (`getSharedHighlighter` with
  `langs: [getFiletypeFromFileName(path)]`) before `File.render` paints the
  rows immediately (verified in a debug bundle, `preLen` > 0 on first render).

## Change

1. `src/public/pierre-adapter.js` — `createFileView` becomes async: after
   `initPierre()`, load the file's language into the shared highlighter
   (`langs: [lang ?? "text"]` — "text" for unknown extensions), then render.
   Comment explains the pierre short-circuit why.
2. `src/public/explorer.js` — `renderFilePane` awaits `createFileView`.
3. Rebuild the bundle (`npm run build`).
4. Clean up the debug artifacts (`src/public/debug.html`, dist debug chunk,
   `tmp/plans/debug/`).

## What could break

- Chapter diffs must keep lazy-loading grammars — don't touch `initPierre`'s
  `langs: []` call (FileDiff's own lazy path works; only `File` is broken).
- `createFileView` callers: only `explorer.js` (grep-verified).

## Verification

- Headless CDP: open `#<sid>/explorer/<file>§head`, assert the shadow root's
  `<pre>` has non-empty text within ~5 s.
- `npm test` (no pure-logic change → existing suites stay green).
