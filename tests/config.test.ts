import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globalConfigPath, loadConfigObject } from "../src/config.ts";
import { loadConfig as loadReviewConfig } from "../src/chunker.ts";
import { loadClassifierConfig, loadClassifyRules } from "../src/custom-classifier.ts";
import { loadLlmConfig, resolveTaskConfig } from "../src/llm.ts";

// temp dir serving as XDG_CONFIG_HOME with an optional global config
const withGlobal = (body: unknown): string => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-global-"));
  if (body !== null) {
    fs.mkdirSync(path.join(home, "sky-eye"), { recursive: true });
    fs.writeFileSync(path.join(home, "sky-eye", "config.json"), JSON.stringify(body));
  }
  return home;
};

// temp repo with a .sky-eye/config.json (same pattern as the other tests)
const withRepo = (body: unknown): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-repo-"));
  if (body !== null) {
    fs.mkdirSync(path.join(dir, ".sky-eye"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".sky-eye", "config.json"), JSON.stringify(body));
  }
  return dir;
};

// point the global layer at a temp home for the duration of a test
const withXdg = (home: string, fn: () => void): void => {
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
};

test("globalConfigPath: XDG_CONFIG_HOME, falling back to ~/.config", () => {
  withXdg("/xdg-is-here", () => {
    assert.equal(globalConfigPath(), path.join("/xdg-is-here", "sky-eye", "config.json"));
  });
  const saved = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    assert.equal(globalConfigPath(), path.join(os.homedir(), ".config", "sky-eye", "config.json"));
  } finally {
    if (saved !== undefined) process.env.XDG_CONFIG_HOME = saved;
  }
});

test("loadConfigObject: no files → undefined; malformed layers ignored", () => {
  withXdg(withGlobal(null), () => {
    assert.equal(loadConfigObject(withRepo(null)), undefined);
    assert.deepEqual(loadConfigObject(withRepo({ review: { maxLines: 5 } })), { review: { maxLines: 5 } });
  });
  withXdg(withGlobal("not json"), () => {
    assert.equal(loadConfigObject(withRepo(null)), undefined); // malformed global, no repo
    assert.deepEqual(loadConfigObject(withRepo({ review: { maxLines: 5 } })), { review: { maxLines: 5 } });
  });
  withXdg(withGlobal({ review: { maxLines: 7 } }), () => {
    assert.deepEqual(loadConfigObject(withRepo("not json")), { review: { maxLines: 7 } });
  });
});

test("global alone configures every concern", () => {
  const home = withGlobal({
    defaults: { provider: "openai", model: "m-1", apiKey: "k" },
    tasks: { narrate: { model: "m-n" } },
    review: { targetLines: 10, maxLines: 20 },
    classifier: { builtin: "openai" },
    classifyRules: { safePaths: ["vendor/*"] },
  });
  withXdg(home, () => {
    const root = withRepo(null);
    assert.deepEqual(resolveTaskConfig(loadLlmConfig(root), "narrate"), { provider: "openai", model: "m-n", apiKey: "k" });
    assert.deepEqual(loadReviewConfig(root), { targetLines: 10, maxLines: 20 });
    // sharedBuiltin fills unset fields with undefined — assert them explicitly
    assert.deepEqual(loadClassifierConfig(root), {
      builtin: "openai",
      model: "gpt-6-luna",
      apiKey: undefined,
      baseUrl: undefined,
      instructions: undefined,
      criteria: undefined,
      timeoutMs: 30000,
      fallback: true,
      debug: false,
    });
    assert.deepEqual(loadClassifyRules(root), { safePaths: ["vendor/*"] });
  });
});

test("repo wins per field; global fills the gaps", () => {
  const home = withGlobal({
    defaults: { apiKey: "global-key", model: "global-model" },
    tasks: { narrate: { model: "global-narrate" } },
    review: { targetLines: 10, maxLines: 20 },
    classifyRules: { safePaths: ["vendor/*"], focusPaths: ["docs/*"] },
  });
  withXdg(home, () => {
    const root = withRepo({
      tasks: { narrate: { model: "repo-narrate" } },
      review: { maxLines: 50 },
      classifyRules: { safePaths: ["generated/*"] },
    });
    // global defaults.apiKey survives under the repo's task override
    assert.deepEqual(resolveTaskConfig(loadLlmConfig(root), "narrate"), {
      apiKey: "global-key",
      model: "repo-narrate", // repo task key beats global default and global task key
    });
    assert.deepEqual(loadReviewConfig(root), { targetLines: 10, maxLines: 50 });
    // arrays are replaced, not concatenated (repo layer wins wholesale)
    assert.deepEqual(loadClassifyRules(root), { safePaths: ["generated/*"], focusPaths: ["docs/*"] });
  });
});
