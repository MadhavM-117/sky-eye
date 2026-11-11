import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CustomAdapterError,
  anthropicAdapter,
  claudeCodeAdapter,
  customAdapter,
  loadLlmConfig,
  openaiAdapter,
  resolveTask,
} from "../src/llm.ts";
import type { LlmConfig, LlmTaskConfig } from "../src/types.ts";

// temp repo with a .sky-eye/config.json
const withConfig = (body: unknown): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-"));
  fs.mkdirSync(path.join(dir, ".sky-eye"), { recursive: true });
  if (body !== null)
    fs.writeFileSync(path.join(dir, ".sky-eye", "config.json"), JSON.stringify(body));
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

test("resolveTask: chunk task resolves like the others (task 019)", () => {
  const cfg: LlmConfig = {
    defaults: { apiKey: "k", model: "gpt-x" },
    tasks: { chunk: { model: "gpt-chunk" } },
  };
  const chunk = resolveTask(withConfig(cfg), "chunk");
  assert.ok(chunk);
  assert.match(chunk!.id, /gpt-chunk$/);
  // not configured → skipped
  assert.equal(resolveTask(withConfig({ defaults: { apiKey: "k" } }), "chunk"), undefined);
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

test("openai-compatible routers (e.g. OpenRouter) work via baseUrl alone", async () => {
  const root = withConfig({
    tasks: {
      narrate: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-v1-…",
        model: "anthropic/claude-sonnet-4",
      },
    },
  });
  const adapter = resolveTask(root, "narrate");
  assert.ok(adapter);
  assert.match(adapter.id, /^openai:https:\/\/openrouter\.ai\/api\/v1\/chat\/completions:/);
  let url = "";
  const fetchImpl = (async (u: string | URL) => {
    url = String(u);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  // the adapter built from config carries its baseUrl — call through it
  const cfg = { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "anthropic/claude-sonnet-4" };
  const text = await openaiAdapter(cfg, fetchImpl).call({ task: "narrate", system: "s", prompt: "p" });
  assert.equal(text, "ok");
  assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
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

test("resolveTask: claude-code provider selects the cli adapter", () => {
  const root = withConfig({
    tasks: { narrate: { provider: "claude-code", model: "claude-haiku-4-5" } },
  });
  assert.match(resolveTask(root, "narrate")!.id, /^claude-code:claude-haiku-4-5$/);
});

test("resolveTask: removed 'claude' provider is unknown — task skipped, not silently openai", () => {
  const root = withConfig({
    tasks: { narrate: { provider: "claude", model: "claude-haiku-4-5", apiKey: "x" } },
  });
  assert.equal(resolveTask(root, "narrate"), undefined);
});

// fake `claude` binary: the adapter's spawn boundary, so no fetch stub
const claudeFake = (stdout: string, code = 0) => (dir: string) => {
  const bin = path.join(dir, "claude");
  fs.writeFileSync(
    bin,
    `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${stdout.replace(/'/g, "'\\''")}'\nexit ${code}`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
};

test("claude-code adapter: parses the json result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmc-"));
  const bin = claudeFake('{"result":"hello from claude","is_error":false}')(dir);
  const text = await claudeCodeAdapter({ provider: "claude-code", model: "claude-haiku-4-5", claudePath: bin }, dir)
    .call({ task: "narrate", system: "sys", prompt: "usr" });
  assert.equal(text, "hello from claude");
});

test("claude-code adapter: quota errors throw with the CLI's text (caller degrades)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmc-"));
  const bin = claudeFake('{"result":"You\'ve hit your usage limit…","is_error":true,"subtype":"error_during_execution"}')(dir);
  await assert.rejects(
    claudeCodeAdapter({ provider: "claude-code", model: "m", claudePath: bin }, dir)
      .call({ task: "narrate", system: "", prompt: "" }),
    /usage limit/,
  );
});

test("claude-code adapter: non-json output and spawn failure throw with stderr tail", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmc-"));
  const bin = claudeFake("plain text, not json", 1)(dir);
  await assert.rejects(
    claudeCodeAdapter({ provider: "claude-code", model: "m", claudePath: bin }, dir)
      .call({ task: "narrate", system: "", prompt: "" }),
    /exit 1/,
  );
  const missing = claudeCodeAdapter({ provider: "claude-code", model: "m", claudePath: path.join(dir, "absent") }, dir);
  await assert.rejects(missing.call({ task: "narrate", system: "", prompt: "" }), /absent|ENOENT|exit null/);
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
