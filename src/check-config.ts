// `sky-eye check-config` (spec §16.1): probe every configured part of
// .sky-eye/config.json with a live round-trip — LLM tasks resolve through
// the runtime's own entry point (`resolveTask`) and answer a tiny ping
// (shared adapters pinged once, §16.3), the classifier backend runs against
// a synthetic one-line request, static keys are reported as parsed.
// Read-only: no sessions, no logs (spawnClassifier/decisionsClassify only
// log via applyClassifier).
import fs from "node:fs";
import path from "node:path";
import { globalConfigPath } from "./config.ts";
import {
  PROTOCOL,
  loadClassifyRules,
  loadClassifierConfig,
  spawnClassifier,
} from "./custom-classifier.ts";
import { decisionsClassify, decisionsUrl } from "./decisions.ts";
import { loadConfig as loadReviewConfig } from "./chunker.ts";
import { loadLlmConfig, resolveTask, resolveTaskConfig } from "./llm.ts";
import type { LlmConfig } from "./types.ts";

export interface CheckResult {
  name: string;
  status: "ok" | "fail" | "skip";
  detail: string;
}

const PING_SYSTEM = "You are a connectivity probe for sky-eye. Reply with the single word OK.";
const PING_PROMPT = "Reply with OK.";

// one added line — enough to exercise request building, auth and parsing
const checkRequest = (repo: string) =>
  JSON.stringify({
    protocol: PROTOCOL,
    repo,
    base: "-",
    head: "-",
    chapters: [
      {
        id: "check-config",
        files: [
          {
            file: "check-config.txt",
            status: "added",
            hunks: [
              { lines: [{ type: "add", side: "new", line: 1, text: "check-config connectivity test" }] },
            ],
          },
        ],
      },
    ],
  });

const flatten = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, " ").trim();

export async function checkConfig(root: string, fetchImpl = fetch): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const llm: LlmConfig | undefined = loadLlmConfig(root);

  // LLM tasks — resolveTask is what narrate.ts calls, so what resolves here
  // is exactly what a session build would use. Shared adapters (equal id,
  // §16.3) ping once; later tasks inherit the ping's status.
  const firstTask = new Map<string, string>(); // adapter id → first task that pinged it
  const pings = new Map<string, { status: "ok" | "fail"; detail: string }>();
  for (const task of ["narrate", "classify", "chunk"] as const) {
    const cfg = resolveTaskConfig(llm, task);
    if (!cfg) {
      results.push({ name: task, status: "skip", detail: "not configured — task skipped at runtime" });
      continue;
    }
    const adapter = resolveTask(root, task, fetchImpl);
    if (!adapter) {
      // only reachable path: an unknown provider value (e.g. configs left on
      // task 024's removed "claude") — resolveTask already console.error'd the reason
      results.push({
        name: task,
        status: "fail",
        detail: `unresolved adapter — ${cfg.provider ? `unknown provider "${cfg.provider}"` : "no model"}`,
      });
      continue;
    }
    const first = firstTask.get(adapter.id);
    const ping = pings.get(adapter.id);
    if (first && ping) {
      results.push({
        name: task,
        status: ping.status,
        detail: ping.status === "ok" ? `shared adapter with ${first}` : `shared adapter with ${first} — ${ping.detail}`,
      });
      continue;
    }
    firstTask.set(adapter.id, task);
    const started = Date.now();
    try {
      await adapter.call({ task, system: PING_SYSTEM, prompt: PING_PROMPT });
      pings.set(adapter.id, { status: "ok", detail: `${adapter.id} (${((Date.now() - started) / 1000).toFixed(1)}s)` });
    } catch (e) {
      pings.set(adapter.id, { status: "fail", detail: `${adapter.id} — ${flatten(e)}` });
    }
    const result = pings.get(adapter.id)!;
    results.push({ name: task, status: result.status, detail: result.detail });
  }

  // classifier pass — exec hook or built-in decision API, synthetic request
  const cls = loadClassifierConfig(root);
  if (!cls) {
    results.push({ name: "classifier", status: "skip", detail: "not configured — rules marks only" });
  } else {
    const label = cls.command ?? `${cls.builtin}:${cls.model} @ ${decisionsUrl(cls)}`;
    const started = Date.now();
    const request = checkRequest(root);
    const run = cls.command
      ? await spawnClassifier(cls, root, request)
      : await decisionsClassify(cls, root, request, fetchImpl);
    results.push(
      run.failed
        ? { name: "classifier", status: "fail", detail: `${label} — ${flatten(run.error)}` }
        : { name: "classifier", status: "ok", detail: `${label} (${((Date.now() - started) / 1000).toFixed(1)}s, ${run.marks.length} marks)` },
    );
  }

  // static keys — reported as parsed; they can't fail at runtime
  const rules = loadClassifyRules(root);
  results.push({
    name: "classifyRules",
    status: "ok",
    detail: rules
      ? `${rules.safePaths?.length ?? 0} safe / ${rules.focusPaths?.length ?? 0} focus globs`
      : "defaults",
  });
  const review = loadReviewConfig(root);
  results.push({ name: "review", status: "ok", detail: `target ${review.targetLines} / max ${review.maxLines} lines` });

  // which config files were layered (global XDG under the repo's, §16.1)
  const repoConfigPath = path.join(root, ".sky-eye", "config.json");
  const sources = [fs.existsSync(globalConfigPath()) && globalConfigPath(), fs.existsSync(repoConfigPath) && repoConfigPath]
    .filter((p): p is string => !!p);
  results.push({ name: "config", status: "ok", detail: sources.length ? sources.join(" + ") : "no config file" });

  return results;
}
