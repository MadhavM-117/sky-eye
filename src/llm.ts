// LLM adapters (spec §16.1, §22.2): OpenAI-compatible chat completions,
// native Anthropic /v1/messages, the `claude` CLI (subscription auth), and a
// custom exec adapter. Blocking calls only (streaming deferred). A task
// without a resolvable config is skipped by returning undefined — sessions
// never block on the LLM layer (§16.1).
import { spawn } from "node:child_process";
import { loadConfigObject } from "./config.ts";
import type { LlmAdapter, LlmConfig, LlmRequest, LlmTaskConfig } from "./types.ts";

export const DEFAULT_TIMEOUT_MS = 120_000;

export function loadLlmConfig(root: string): LlmConfig | undefined {
  return loadConfigObject(root) as LlmConfig | undefined;
}

// defaults ← task override merge; `command` wins over provider.
// Exported for check-config's configured-but-unresolvable diagnostic.
export function resolveTaskConfig(config: LlmConfig | undefined, task: "narrate" | "classify" | "chunk"): LlmTaskConfig | undefined {
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

// Claude Code stamps these on its own children (or exports them from a parent
// CC session). When sky-eye runs inside Claude Code, a spawned `claude` would
// otherwise inherit that session's identity — the same fix as
// pi-claude-bridge's PARENT_SESSION_VARS (tmp/pi-claude-bridge/src/cc-child.ts);
// update both lists together.
const CLAUDE_PARENT_SESSION_VARS = [
  "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID", "CLAUDE_EFFORT", "TRACEPARENT", "CLAUDE_CODE_INVOKED_SKILLS", "CLAUDE_ENV_FILE",
  "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
];

// `claude -p` adapter: auth fully delegated to the Claude Code CLI
// (`claude auth login` credentials — subscriptions included). The CLI owns
// OAuth refresh and API retries/rate limits; sky-eye sees only the final
// result. One-shot by design: no session files read or written by sky-eye.
export function claudeCodeAdapter(cfg: LlmTaskConfig, cwd: string): LlmAdapter {
  const bin = cfg.claudePath?.trim() || "claude";
  return {
    id: `claude-code:${cfg.model}`, // shared-call key (§16.3): same model → one shared call
    call: async (req: LlmRequest) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (env.CLAUDECODE) for (const name of CLAUDE_PARENT_SESSION_VARS) delete env[name];
      const args = [
        "-p", req.prompt,
        "--system-prompt", req.system, // replaces CC's default prompt — sky-eye owns the persona
        "--model", req.model ?? cfg.model!,
        "--output-format", "json",
        "--tools", "", // no tools: sky-eye supplies diff text, the CLI never acts on the repo
        "--no-session-persistence", // one-shot: leave no transcript in ~/.claude/projects
      ];
      const res = await spawnRun(bin, args, cwd, cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS, env);
      const detail = res.stderr.split("\n").filter(Boolean).slice(-3).join("; ");
      let parsed: { result?: unknown; is_error?: boolean } | undefined;
      try { parsed = JSON.parse(res.stdout); } catch { /* fall through to exit-code error */ }
      if (parsed?.is_error || (parsed === undefined && res.code !== 0)) {
        throw new Error(`claude-code: ${typeof parsed?.result === "string" ? parsed.result : `exit ${res.code}${detail ? ` — ${detail}` : ""}`}`);
      }
      if (typeof parsed?.result !== "string") throw new Error(`claude-code: unusable output${detail ? ` — ${detail}` : ""}`);
      return parsed.result;
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

// shared spawn shape with the classifier's — timeout, stdout/stderr capture;
// resolves instead of rejecting so callers degrade. `shRun` runs one command
// line via /bin/sh; the generic form takes an argv array (claude-code).
function spawnRun(bin: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<{ code: number | null; killed: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, timeout: timeoutMs, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: null, killed: false, stdout, stderr: stderr + String(e) }));
    child.on("close", (code, signal) => resolve({ code, killed: signal === "SIGTERM", stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end();
  });
}

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
export function resolveTask(root: string, task: "narrate" | "classify" | "chunk", fetchImpl = fetch): LlmAdapter | undefined {
  const cfg = resolveTaskConfig(loadLlmConfig(root), task);
  if (!cfg) return undefined;
  if (cfg.command) return customAdapter(cfg, root);
  if (cfg.provider === "anthropic") return anthropicAdapter(cfg, fetchImpl);
  if (cfg.provider === "claude-code") return claudeCodeAdapter(cfg, root);
  if (!cfg.provider || cfg.provider === "openai") return openaiAdapter(cfg, fetchImpl);
  // Unknown (or removed — e.g. task 024's "claude") provider: skip the task,
  // never silently route it to another adapter (§16.1).
  console.error(`sky-eye: unknown provider "${cfg.provider}" — task skipped`);
  return undefined;
}
