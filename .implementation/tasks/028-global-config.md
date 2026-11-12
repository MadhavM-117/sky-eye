# 028 — Global config (XDG)

**Goal:** an optional machine-wide config at
`$XDG_CONFIG_HOME/sky-eye/config.json` (default `~/.config/sky-eye/config.json`),
layered under the per-repo `.sky-eye/config.json` — repo wins per field, deep
merged; arrays and scalars are replaced. Motivation: `apiKey` and machine-wide
LLM/classifier defaults stop needing per-repo duplication.

**Status:** **done** — `src/config.ts` owns path resolution + merge;
the four per-concern loaders delegate to `loadConfigObject(root)` and keep
their validation. Read-side only: sky-eye never creates the global file.
`check-config` reports which config files were layered. Spec §16.1,
design D§6a, README, config.sample, process.md updated.
