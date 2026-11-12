# pierre-diffs

- pierre `overflow: 'wrap'` (BaseCodeOptions) disables line annotations:
  FileDiff/File set `disableAnnotations: overflow === 'wrap'` — comment rows
  and composer vanish while wrapped; gutter glyphs (onPostRender stamps)
  are unaffected. Toggle back to 'scroll' to restore comments.
- `FileDiff` options are only diffed between renders inside CodeView; our
  adapter builds a fresh FileDiff per render anyway — option changes mean
  dispose + rebuild (same pattern as full-file mode / restampMarks).
