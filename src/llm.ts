// LLM adapters (spec §16.1, §22.2): OpenAI-compatible chat completions,
// native Anthropic /v1/messages, and a custom exec adapter. Blocking calls
// only (streaming deferred). A task without a resolvable config is skipped
// by returning undefined — sessions never block on the LLM layer (§16.1).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { LlmAdapter, LlmConfig, LlmRequest, LlmTaskConfig } from "./types.ts";

export const DEFAULT_TIMEOUT_MS = 120_000;

const configPath = (root: string) => path.join(root, ".sky-watch", "config.json");

export function loadLlmConfig(root: string): LlmConfig | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(root), "utf8")) as LlmConfig;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

// defaults ← task override merge; `command` wins over provider
function resolveTaskConfig(config: LlmConfig | undefined, task: "narrate" | "classify"): LlmTaskConfig | undefined {
  const merged: LlmTaskConfig = { ...config?.defaults, ...config?.tasks?.[task] };
  if (merged.command?.trim()) return { ...merged, command: merged.command.trim() };
  if (merged.model?.trim()) return { ...merged, model: merged.model.trim() };
  return undefined; // missing key for the task → task skipped (§16.1)
}

// OpenAI-compatible chat completions (default provider)
export function openaiAdapter(cfg: LlmTaskConfig, fetchImpl = fetch): LlmAdapter {
  const url = `${cfg.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`;
  return {
    id: `openai:${url}:${cfg.model}`,
    call: async (req: LlmRequest) => {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: req.model ?? cfg.model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.prompt },
          ],
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`openai ${res.status}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return body.choices?.[0]?.message?.content ?? "";
    },
  };
}

// native Anthropic messages API
export function anthropicAdapter(cfg: LlmTaskConfig, fetchImpl = fetch): LlmAdapter {
  const url = `${cfg.baseUrl ?? "https://api.anthropic.com"}/v1/messages`;
  return {
    id: `anthropic:${url}:${cfg.model}`,
    call: async (req: LlmRequest) => {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...(cfg.apiKey ? { "x-api-key": cfg.apiKey } : {}),
        },
        body: JSON.stringify({
          model: req.model ?? cfg.model,
          max_tokens: 1024,
          system: req.system,
          messages: [{ role: "user", content: req.prompt }],
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}`);
      const body = (await res.json()) as { content?: { type: string; text?: string }[] };
      return body.content?.find((b) => b.type === "text")?.text ?? "";
    },
  };
}

// custom adapter: same exec spirit as the classifier hook (§16.5) — a
// single string command via /bin/sh, request JSON on stdin, `{ text }` out
export class CustomAdapterError extends Error {}

export function customAdapter(cfg: LlmTaskConfig, cwd: string): LlmAdapter {
  return {
    id: `custom:${cfg.command}`,
    call: (req: LlmRequest) =>
      shRun(cfg.command!, cwd, cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        JSON.stringify({ protocol: 1, task: req.task, model: req.model ?? cfg.model, system: req.system, prompt: req.prompt }),
      ).then((res) => {
        if (res.code !== 0) throw new CustomAdapterError(`exit ${res.code}${res.killed ? " (timeout)" : ""}`);
        const text = (JSON.parse(res.stdout) as { text?: unknown }).text;
        if (typeof text !== "string") throw new CustomAdapterError("response has no text");
        return text;
      }),
  };
}

// shared shRun shape with the classifier's — single command line, timeout,
// stdout/stderr capture; resolves instead of rejecting so callers degrade
function shRun(command: string, cwd: string, timeoutMs: number, input: string): Promise<{ code: number | null; killed: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: null, killed: false, stdout, stderr: stderr + String(e) }));
    child.on("close", (code, signal) => resolve({ code, killed: signal === "SIGTERM", stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// The one entry point narrate.ts uses: resolve a task's adapter or undefined
// (task skipped). Throws only on programmer error (unknown task name).
export function resolveTask(root: string, task: "narrate" | "classify"): LlmAdapter | undefined {
  const cfg = resolveTaskConfig(loadLlmConfig(root), task);
  if (!cfg) return undefined;
  if (cfg.command) return customAdapter(cfg, root);
  if (cfg.provider === "anthropic") return anthropicAdapter(cfg);
  return openaiAdapter(cfg);
}
