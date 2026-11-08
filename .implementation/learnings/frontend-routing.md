# Frontend routing

- Explorer hash separator is `§` (`#<sid>/explorer/<encPath>§<side>`, percent-encoded by URL bars as `%C2%A7` — parseHash accepts both). Links built with `/<side>` instead (`/head`, `/base`) leak the side into the path: server 400s `bad path: /head`, and `scrollToPath` on the mangled path crashes the tree with `can't access property "endsWith"`.
- Deep links resolve to the owning chapter in `renderSession` before render
  (line → `route.chapterId`, comment → `comment.chapterId`, chapter →
  itself); `activeChapterId` is module-level so it survives re-renders and
  is reset when the session id changes. State that must survive a full
  re-render (pending orphan-triage re-pin) lives at module scope too —
  closure locals die with the old `wireSession` call.
- Task 020 also fixed a stale bug: chapter-target deep links used the old
  single-key `diffs.get(chapterId)` (broken since 006's `chapterId\u0000file`
  keys); they now scroll the `.chapter[data-chapter=…]` section.
- UI smoke test without a browser driver: `chromium --headless --dump-dom
  --virtual-time-budget=10000 'http://…/#<hash>'` against the dev server —
  fragments are honored, pierre renders, output greppable for markers.
