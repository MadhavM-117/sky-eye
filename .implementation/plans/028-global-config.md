# Plan: global config (XDG)

Add an optional machine-wide config at `$XDG_CONFIG_HOME/sky-eye/config.json`
(default `~/.config/sky-eye/config.json`), layered **under** the per-repo
`.sky-eye/config.json` (repo wins). Main motivation: secrets (`apiKey`) and
machine-wide defaults (LLM tasks, classifier) no longer need to be duplicated
into every repo.

> Repo-process note: this plan lives here per the `write-plan` skill; before
> implementing, copy it to `.implementation/plans/028-global-config.md` and
> create the matching task file (next free number is 028).

## Current state (read from code)

Four loaders, each opening `<root>/.sky-eye/config.json` independently
(per-concern loaders — a deliberate pattern, see learnings/config.md):

| Loader | File | Slice it owns |
|---|---|---|
| `loadLlmConfig(root)` | `src/llm.ts:15` | whole `LlmConfig` (`defaults`, `tasks.*`) |
| `loadConfig(root)` | `src/chunker.ts:11` | `review` (`targetLines`/`maxLines`) |
| `loadClassifierConfig(root)` | `src/custom-classifier.ts:22` | `classifier` |
| `loadClassifyRules(root)` | `src/custom-classifier.ts:74` | `classifyRules` |

Each does `JSON.parse(readFileSync(...))` in a try/catch → `undefined`/default
on any error. `check-config.ts` calls all four; it needs no signature changes.

## Approach

One tiny shared module, `src/config.ts`, owning the path resolution and the
merge. Loaders keep their signatures and validation; they only swap "read this
one file" for "read the merged object".

```ts
// src/config.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// global layer: $XDG_CONFIG_HOME/sky-eye/config.json (spec §16.1)
export const globalConfigPath = () =>
  path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "sky-eye", "config.json",
  );

const readJson = (p: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
};

// deep-merge plain objects, repo wins; arrays and scalars are replaced
const merge = (a: unknown, b: unknown): unknown =>
  a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)
    ? Object.fromEntries(
        [...new Set([...Object.keys(a), ...Object.keys(b)])]
          .map((k) => [k, merge((a as any)[k], (b as any)[k])]))
    : b ?? a;

/** Global config layered under the repo's .sky-eye/config.json (repo wins). */
export function loadConfigObject(root: string): Record<string, unknown> | undefined {
  const global = readJson(globalConfigPath());
  const repo = readJson(path.join(root, ".sky-eye", "config.json"));
  if (!global) return repo;
  if (!repo) return global;
  return merge(global, repo) as Record<string, unknown>;
}
```

### Loader changes (mechanical)

- **`src/llm.ts`** — delete `configPath`, `loadLlmConfig` becomes:
  ```ts
  export function loadLlmConfig(root: string): LlmConfig | undefined {
    return loadConfigObject(root) as LlmConfig | undefined;
  }
  ```
  The existing `defaults ← tasks.<name>` merge in `resolveTaskConfig` then
  works over already-merged layers: global `defaults` + repo `tasks.narrate`
  compose naturally (repo task key wins over global default, global default
  wins over nothing). No other change.
- **`src/chunker.ts`** — swap the inline read for:
  ```ts
  const parsed = loadConfigObject(root) as { review?: Partial<ReviewConfig> } | undefined;
  return { ...DEFAULT_CONFIG, ...parsed?.review };
  ```
- **`src/custom-classifier.ts`** — `loadClassifierConfig` and
  `loadClassifyRules` swap `JSON.parse(fs.readFileSync(configPath(root)))`
  for `loadConfigObject(root)`; all per-field validation stays untouched.
  Delete the now-unused `configPath` helpers.
- **`src/check-config.ts`** — works unchanged (it calls the loaders). Add one
  cheap diagnostic row so users can see the layering took effect:
  ```ts
  results.push({ name: "config", status: "ok",
    detail: [fs.existsSync(globalConfigPath()) && globalConfigPath(),
             path.join(root, ".sky-eye", "config.json")].filter(Boolean).join(" + ") });
  ```

## Merge semantics (decision embedded — confirm before coding)

- **Repo wins per field**, deep-merged: a repo file may override just
  `tasks.narrate.model` while `apiKey` comes from the global file.
- **Arrays are replaced, not concatenated** (applies to `classifyRules`
  globs and `criteria` maps'… no — `criteria` is an object, it merges).
  Replacement is predictable; concatenation of `classifyRules` globs across
  layers is the alternative and only matters if someone splits globs between
  global and repo — flagging it, defaulting to replace.
- No new file is created by sky-eye itself: if the global file doesn't
  exist, nothing changes (no mkdir, no write) — the feature is purely
  read-side.

## Files touched

| File | Change |
|---|---|
| `src/config.ts` | **new** — path resolution + merge (~30 lines) |
| `src/llm.ts` | `loadLlmConfig` delegates; drop local `configPath` |
| `src/chunker.ts` | `loadConfig` delegates |
| `src/custom-classifier.ts` | both loaders delegate; drop `configPath` |
| `src/check-config.ts` | one extra diagnostic row |
| `tests/llm.test.ts`, `tests/chunker.test.ts`, `tests/custom-classifier.test.ts` | merge cases (below) |
| `tests/check-config.test.ts` | adjust if row count is asserted |
| `docs/spec.md` | §16.1: document the global layer + precedence (binding spec change); also touch the path mentions in the repo map (line ~79) and the §8 chunk-knob (line ~270) |
| `docs/design.md` (~line 276, D§6a) | config file path → layered: global XDG under repo |
| `docs/README.md` (~line 47) | "all config lives in `<repo>/.sky-eye/config.json`" → mention the optional global layer |
| `docs/config.sample.jsonc` | note it can also live at `~/.config/sky-eye/config.json` (or add a global-sample section) |
| `process.md` foundations | `.sky-eye/config.json` → "repo config over `XDG_CONFIG_HOME/sky-eye/config.json`" |

## Tests (fixtures, no CLIs — spec §20)

Pattern used by existing loader tests: temp dir via `fs.mkdtempSync`,
`root` pointing at it. For the global layer, point `XDG_CONFIG_HOME` at a
second temp dir and restore it after (`process.env` save/restore in the test).

1. global only → loaders pick up global values (llm task, `review`, `classifier`, `classifyRules`)
2. repo only → unchanged behavior (already covered; keep one regression case)
3. both → repo field wins, global field fills gaps:
   - global `defaults.apiKey` + repo `tasks.narrate.model` → both present in `resolveTaskConfig`
   - repo `review.maxLines` only → global `review.targetLines` still applies
   - repo `classifyRules.safePaths` replaces global's (assert the chosen semantics)
4. malformed global file → silently ignored, repo still works (and vice versa)
5. `XDG_CONFIG_HOME` unset → falls back to `~/.config/sky-eye/config.json` (assert the path string via `globalConfigPath()`, don't touch the real home)

## Dependencies

None. `node:os`, `node:path`, `node:fs` only.

## Risks / what could break

- **Behavior change for existing users:** none if no global file exists —
  loaders return exactly what they returned before.
- **Secret-leak surface grows:** global `apiKey` applies to every repo,
  including ones where the user didn't intend it. Accepted (that's the
  point); documented in §16.1.
- **check-config outside a repo:** with a global config, `check-config` now
  reports configured tasks even where `.sky-eye/` doesn't exist — correct,
  but its output changes for such repos (new `config` row).

## Open questions (pause-and-confirm per process.md)

1. Merge semantics as above OK? (repo wins per field, arrays replaced)
2. Should `classifyRules` globs concatenate across layers instead of replace?
3. Task number 028 + spec update in the same change — fine?

## Todo

### Phase 1 — task setup
- [x] Copy plan to `.implementation/plans/028-global-config.md`, create `.implementation/tasks/028-global-config.md`, add to `000-index.md`

### Phase 2 — core
- [x] `src/config.ts`: `globalConfigPath()` + `loadConfigObject(root)` (deep merge, repo wins, arrays/scalars replaced)
- [x] `src/llm.ts`: `loadLlmConfig` delegates; drop `configPath`
- [x] `src/chunker.ts`: `loadConfig` delegates
- [x] `src/custom-classifier.ts`: both loaders delegate; drop `configPath`
- [x] `src/check-config.ts`: trailing `config` diagnostic row (paths that exist)

### Phase 3 — tests
- [x] `tests/config.test.ts`: global-only / repo-only / merged per-field / array-replaced / malformed-global / `globalConfigPath()` XDG fallback
- [x] Update `tests/check-config.test.ts` expected row list
- [x] `npm test` + `npm run check` green

### Phase 4 — docs & wrap-up
- [x] `docs/spec.md`: §16.1 global layer + precedence; repo-map (llm.ts line) and §8 chunk-knob mentions
- [x] `docs/design.md` D§6a (~line 276)
- [x] `README.md` configuration section
- [x] `docs/config.sample.json`: note global location
- [x] `process.md` foundations line
- [x] Learnings: `.implementation/learnings/config.md` bullet
- [x] jj commit (conventional)
