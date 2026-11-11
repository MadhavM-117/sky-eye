import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkConfig } from "../src/check-config.ts";

// temp repo with a .sky-eye/config.json (same pattern as
// custom-classifier.test.ts); null → empty dir, no config at all
const withConfig = (body: unknown): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-"));
  if (body !== null) {
    fs.mkdirSync(path.join(dir, ".sky-eye"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".sky-eye", "config.json"), JSON.stringify(body));
  }
  return dir;
};

const okJson = { choices: [{ message: { content: "OK" } }] };

test("no config file: everything skips, static keys report defaults", async () => {
  const results = await checkConfig(withConfig(null));
  assert.deepEqual(
    results.map((r) => [r.name, r.status]),
    [
      ["narrate", "skip"],
      ["classify", "skip"],
      ["chunk", "skip"],
      ["classifier", "skip"],
      ["classifyRules", "ok"],
      ["review", "ok"],
    ],
  );
  assert.match(results[0].detail, /not configured/);
  assert.equal(results[4].detail, "defaults");
  assert.equal(results[5].detail, "target 75 / max 200 lines");
});

test("openai provider pings once; classify shares the adapter; static overrides reported", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(okJson), { status: 200 });
  }) as unknown as typeof fetch;
  const results = await checkConfig(
    withConfig({
      defaults: { provider: "openai", model: "m-1", apiKey: "k" },
      review: { targetLines: 10, maxLines: 20 },
      classifyRules: { safePaths: ["a*"], focusPaths: ["b/c*"] },
    }),
    fetchImpl,
  );
  const byName = new Map(results.map((r) => [r.name, r]));
  assert.equal(byName.get("narrate")!.status, "ok");
  assert.match(byName.get("narrate")!.detail, /^openai:https:\/\/api\.openai\.com\/v1\/chat\/completions:m-1 \(\d+\.\ds\)$/);
  assert.equal(byName.get("classify")!.status, "ok");
  assert.match(byName.get("classify")!.detail, /^shared adapter with narrate$/);
  assert.equal(byName.get("chunk")!.status, "ok");
  assert.match(byName.get("chunk")!.detail, /^shared adapter with narrate$/); // defaults configure every task
  assert.equal(calls.length, 1); // shared adapter (§16.3) pinged once
  assert.match(JSON.stringify(calls[0].init.headers), /Bearer k/);
  assert.equal(byName.get("review")!.detail, "target 10 / max 20 lines");
  assert.equal(byName.get("classifyRules")!.detail, "1 safe / 1 focus globs");
});

test("claude provider without credentials fails with the env-var pointers", async () => {
  const vars = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];
  const saved = vars.map((v) => [v, process.env[v]] as const);
  for (const v of vars) delete process.env[v];
  try {
    const results = await checkConfig(
      withConfig({ defaults: { provider: "claude", model: "claude-haiku-5-5" } }),
    );
    const narrate = results.find((r) => r.name === "narrate")!;
    assert.equal(narrate.status, "fail");
    assert.match(narrate.detail, /no credentials/);
    assert.match(narrate.detail, /CLAUDE_CODE_OAUTH_TOKEN/);
  } finally {
    for (const [v, value] of saved) if (value !== undefined) process.env[v] = value;
  }
});

test("classifier exec hook round-trips the synthetic request", async () => {
  const results = await checkConfig(
    withConfig({ classifier: { command: `echo '{"marks":[]}'` } }),
  );
  const cls = results.find((r) => r.name === "classifier")!;
  assert.equal(cls.status, "ok");
  assert.match(cls.detail, /echo '{"marks":\[\]}' \(\d+\.\ds, 0 marks\)/);
});

test("failed adapter call is reported with the flattened error", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  const results = await checkConfig(
    withConfig({ tasks: { chunk: { provider: "openai", model: "m", apiKey: "k" } } }),
    fetchImpl,
  );
  const chunk = results.find((r) => r.name === "chunk")!;
  assert.equal(chunk.status, "fail");
  assert.match(chunk.detail, /openai 401/);
});
