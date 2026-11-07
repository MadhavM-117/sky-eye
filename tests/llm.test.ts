import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CustomAdapterError,
  anthropicAdapter,
  customAdapter,
  loadLlmConfig,
  openaiAdapter,
  resolveTask,
} from "../src/llm.ts";
import type { LlmConfig, LlmTaskConfig } from "../src/types.ts";

// temp repo with a .sky-watch/config.json
const withConfig = (body: unknown): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-"));
  fs.mkdirSync(path.join(dir, ".sky-watch"), { recursive: true });
  if (body !== null)
    fs.writeFileSync(path.join(dir, ".sky-watch", "config.json"), JSON.stringify(body));
  return dir;
};

const fetchJson = (status: number, body: unknown) =>
  (async (_url: string | URL, init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

test("loadLlmConfig: missing/invalid file → undefined", () => {
  const root = withConfig(null);
  const root2 = withConfig("not json");
  assert.equal(loadLlmConfig(path.join(root, "nope")), undefined);
  assert.equal(loadLlmConfig(root2), undefined);
});

// resolveTask is exercised through the adapters it builds — identity strings
// prove which provider/config won
test("resolveTask: defaults merge with task override; missing → undefined", () => {
  const cfg: LlmConfig = {
    defaults: { apiKey: "k", model: "gpt-default", baseUrl: "https://x/v1" },
    tasks: { narrate: { model: "gpt-strong" }, classify: {} },
  };
  const root = withConfig(cfg);
  const narrate = resolveTask(root, "narrate");
  const classify = resolveTask(root, "classify");
  assert.ok(narrate);
  assert.match(narrate.id, /openai:https:\/\/x\/v1\/chat\/completions:gpt-strong$/);
  assert.ok(classify);
  assert.match(classify.id, /gpt-default$/); // defaults fill the task
  const empty = withConfig({ defaults: { apiKey: "k" } });
  assert.equal(resolveTask(empty, "narrate"), undefined); // no model → skipped
  assert.equal(resolveTask(withConfig(null), "classify"), undefined);
});

test("resolveTask: anthropic provider and custom command select their adapters", () => {
  const root = withConfig({
    tasks: {
      narrate: { provider: "anthropic", apiKey: "k", model: "claude" },
      classify: { command: "echo-hello", model: "m" },
    },
  });
  assert.match(resolveTask(root, "narrate")!.id, /^anthropic:/);
  assert.match(resolveTask(root, "classify")!.id, /^custom:echo-hello$/);
});

test("openai adapter: chat completions request shape, content extracted", async () => {
  let captured: RequestInit | undefined;
  let url = "";
  const fetchImpl = (async (u: string | URL, init?: RequestInit) => {
    url = String(u);
    captured = init;
    return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const cfg: LlmTaskConfig = { apiKey: "k", model: "gpt", baseUrl: "https://api/v1" };
  const text = await openaiAdapter(cfg, fetchImpl).call({
    task: "narrate",
    system: "sys",
    prompt: "usr",
  });
  assert.equal(text, "hi");
  assert.equal(url, "https://api/v1/chat/completions");
  const body = JSON.parse(String(captured!.body));
  assert.deepEqual(body.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "usr" },
  ]);
  assert.equal(body.model, "gpt");
  assert.equal((captured!.headers as Record<string, string>).authorization, "Bearer k");
});

test("anthropic adapter: /v1/messages shape, first text block extracted", async () => {
  let captured: RequestInit | undefined;
  let url = "";
  const fetchImpl = (async (u: string | URL, init?: RequestInit) => {
    url = String(u);
    captured = init;
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: "para" }] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const cfg: LlmTaskConfig = { provider: "anthropic", apiKey: "k", model: "claude" };
  const text = await anthropicAdapter(cfg, fetchImpl).call({
    task: "narrate",
    system: "sys",
    prompt: "usr",
  });
  assert.equal(text, "para");
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  const body = JSON.parse(String(captured!.body));
  assert.equal(body.system, "sys");
  assert.equal(body.model, "claude");
  assert.equal((captured!.headers as Record<string, string>)["x-api-key"], "k");
});

test("http adapters throw on non-2xx (caller degrades)", async () => {
  const bad = fetchJson(500, { error: "boom" }) as unknown as typeof fetch;
  await assert.rejects(
    openaiAdapter({ model: "m" }, bad).call({ task: "narrate", system: "", prompt: "" }),
  );
  await assert.rejects(
    anthropicAdapter({ model: "m" }, bad).call({ task: "narrate", system: "", prompt: "" }),
  );
});

test("custom adapter: exec speaks stdin/stdout JSON", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmc-"));
  const script = path.join(root, "adapter.sh");
  fs.writeFileSync(
    script,
    `#!/bin/sh\nnode -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify({text:r.system+":"+r.prompt+":"+r.task}))})'`,
  );
  fs.chmodSync(script, 0o755);
  const text = await customAdapter({ command: script }, root).call({
    task: "classify",
    system: "S",
    prompt: "P",
  });
  assert.equal(text, "S:P:classify");
});

test("custom adapter: failure and malformed output throw (caller degrades)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmc-"));
  await assert.rejects(
    customAdapter({ command: "exit 3" }, root).call({ task: "narrate", system: "", prompt: "" }),
    CustomAdapterError,
  );
  await assert.rejects(
    customAdapter({ command: "echo no-json" }, root).call({ task: "narrate", system: "", prompt: "" }),
  );
  await assert.rejects(
    customAdapter({ command: "echo '{}'" }, root).call({ task: "narrate", system: "", prompt: "" }),
    CustomAdapterError,
  );
});
