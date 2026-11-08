import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CustomAdapterError,
  anthropicAdapter,
  claudeSdkAdapter,
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

test("resolveTask: claude provider selects the sdk adapter; no credentials → skipped", () => {
  const root = withConfig({
    tasks: { narrate: { provider: "claude", apiKey: "k", model: "claude-x" } },
  });
  const adapter = resolveTask(root, "narrate");
  assert.ok(adapter);
  assert.match(adapter!.id, /^claude:https:\/\/api.anthropic.com:claude-x$/);

  // no apiKey/authToken anywhere → task skipped (§16.1); save/restore env
  const saved = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]
    .map((k) => [k, process.env[k]] as const);
  for (const [k] of saved) delete process.env[k];
  try {
    const none = withConfig({ tasks: { narrate: { provider: "claude", model: "claude-x" } } });
    assert.equal(resolveTask(none, "narrate"), undefined);
    // subscription path: OAuth token via env alone
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-tok";
    assert.ok(resolveTask(none, "narrate"));
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// the sdk accepts an injected fetch (same stub surface as the fetch adapters);
// headers are read through Headers because the sdk builds them itself
const sdkStub = (status: number, body: unknown) => {
  let url = "";
  let captured: RequestInit | undefined;
  const fetchImpl = (async (u: string | URL, init?: RequestInit) => {
    url = String(u);
    captured = init;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    url: () => url,
    header: (name: string) => new Headers(captured?.headers as HeadersInit).get(name),
    body: () => {
      const raw = captured?.body;
      return JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw));
    },
  };
};

test("claude sdk adapter: messages request shape, apiKey → x-api-key, text extracted", async () => {
  const s = sdkStub(200, { content: [{ type: "text", text: "para" }] });
  const cfg: LlmTaskConfig = { provider: "claude", apiKey: "k", model: "claude-x" };
  const text = await claudeSdkAdapter(cfg, s.fetchImpl).call({ task: "narrate", system: "sys", prompt: "usr" });
  assert.equal(text, "para");
  assert.equal(s.url(), "https://api.anthropic.com/v1/messages");
  const body = s.body();
  assert.equal(body.model, "claude-x");
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.system, "sys");
  assert.deepEqual(body.messages, [{ role: "user", content: "usr" }]);
  // sdk 1.6 sends the key as authorization: Bearer (no x-api-key anymore)
  assert.equal(s.header("authorization"), "Bearer k");
});

test("claude sdk adapter: authToken (subscriptions) → Bearer; empty text → empty string", async () => {
  const s = sdkStub(200, { content: [{ type: "tool_use", id: "x" }] });
  const cfg: LlmTaskConfig = { provider: "claude", authToken: "oauth-tok", model: "claude-x" };
  const text = await claudeSdkAdapter(cfg, s.fetchImpl).call({ task: "narrate", system: "s", prompt: "p" });
  assert.equal(text, "");
  assert.equal(s.header("authorization"), "Bearer oauth-tok");
});

test("claude sdk adapter: errors propagate (caller degrades)", async () => {
  const s = sdkStub(401, { error: { message: "bad key" } });
  await assert.rejects(
    claudeSdkAdapter({ provider: "claude", apiKey: "k", model: "m" }, s.fetchImpl)
      .call({ task: "narrate", system: "", prompt: "" }),
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
