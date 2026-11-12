// Config layering (spec §16.1): an optional machine-wide config at
// $XDG_CONFIG_HOME/sky-eye/config.json (default ~/.config) sits under the
// per-repo .sky-eye/config.json — repo wins per field (deep-merged plain
// objects; arrays and scalars are replaced). Read-side only: sky-eye never
// creates or writes either file. The per-concern loaders (llm.ts,
// chunker.ts, custom-classifier.ts) call loadConfigObject and keep their own
// key validation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const globalConfigPath = () =>
  path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "sky-eye",
    "config.json",
  );

const readJson = (p: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const merge = (global: unknown, repo: unknown): unknown =>
  global && repo &&
  typeof global === "object" && typeof repo === "object" &&
  !Array.isArray(global) && !Array.isArray(repo)
    ? Object.fromEntries(
        [...new Set([...Object.keys(global), ...Object.keys(repo)])].map((k) => [
          k,
          merge(global[k as keyof typeof global], repo[k as keyof typeof repo]),
        ]),
      )
    : repo ?? global;

export function loadConfigObject(root: string): Record<string, unknown> | undefined {
  const global = readJson(globalConfigPath());
  const repo = readJson(path.join(root, ".sky-eye", "config.json"));
  if (!global) return repo;
  if (!repo) return global;
  return merge(global, repo) as Record<string, unknown>;
}
