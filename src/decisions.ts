// Built-in OpenRouter decision-model classifier backend (spec §16.5): one
// blocking HTTP request per rebuild to OpenRouter's decision API
// (`POST {baseUrl}/alpha/decisions`). Every changed line becomes one
// `choice` question whose criteria are the configured mark map — keys are
// the mark NAMES, values their criteria (§16.1). Question keys are
// generated (q0, q1, …) with a side map back to the line coordinate, so odd
// file names never round-trip through question keys. Same degradation
// contract as the exec hook: a failed run never blocks the session — rules
// marks survive (or clear with `fallback: false`).
//
// shortcut: one request per rebuild carries every changed line as a
// question — if OpenRouter rejects large question counts, chunk per chapter.
import { expectedCoordinates, type ClassifierRun } from "./custom-classifier.ts";
import { loadLlmConfig } from "./llm.ts";
import type { ClassifierConfig, LineMark } from "./types.ts";

export const DECISIONS_DEFAULT_BASE = "https://openrouter.ai/api";

// §16.4 buckets — the default vocabulary when `criteria` is not configured
export const DEFAULT_CRITERIA: Record<string, string> = {
  safe: "Tests, lockfiles, docs, generated code — no attention needed",
  glance: "Ordinary code — a quick skim is enough",
  focus: "Security, money, credentials, async/error flow — read carefully",
};

const DEFAULT_INSTRUCTIONS =
  "Which attention mark does this changed line of a code review diff deserve?";

// apiKey resolution (§16.1): classifier key, then OPENROUTER_API_KEY env,
// then the chapter analyser's `defaults` — one OpenRouter key serves both
export function resolveApiKey(cfg: ClassifierConfig, root: string): string | undefined {
  if (cfg.apiKey?.trim()) return cfg.apiKey.trim();
  return process.env.OPENROUTER_API_KEY?.trim() || loadLlmConfig(root)?.defaults?.apiKey?.trim() || undefined;
}

// ---- request building (pure) ----------------------------------------------

interface ProtocolLine {
  type: string;
  side: string;
  line: number;
  text: string;
}
interface ProtocolRequest {
  chapters: { id: string; files: { file: string; status: string; hunks: { lines: ProtocolLine[] }[] }[] }[];
}

// classifier protocol request → decision-API body + the q<N>→coordinate map
export function decisionsRequestBody(
  request: string,
  cfg: ClassifierConfig,
): { body: string; keyMap: Map<string, { file: string; side: "old" | "new"; line: number }> } {
  const parsed = JSON.parse(request) as ProtocolRequest;
  const criteria = cfg.criteria ?? DEFAULT_CRITERIA;
  const instructions = cfg.instructions ?? DEFAULT_INSTRUCTIONS;
  const state: string[] = [];
  const questions: Record<string, unknown> = {};
  const keyMap = new Map<string, { file: string; side: "old" | "new"; line: number }>();
  let n = 0;
  for (const chapter of parsed.chapters) {
    const parts: string[] = [];
    for (const f of chapter.files) {
      parts.push(`${f.file} (${f.status})`);
      for (const hunk of f.hunks)
        for (const l of hunk.lines) {
          const key = `q${n++}`;
          const where = l.side === "new" ? `new line ${l.line}` : `removed line ${l.line}`;
          parts.push(`${l.type === "add" ? "+" : "-"} ${l.text}`);
          questions[key] = {
            type: "choice",
            instructions: `${instructions}\nLine ${f.file} (${where}): "${l.text}"`,
            criteria,
          };
          keyMap.set(key, { file: f.file, side: l.side as "old" | "new", line: l.line });
        }
    }
    state.push(parts.join("\n"));
  }
  return { body: JSON.stringify({ model: cfg.model, state, questions }), keyMap };
}

// ---- response parsing ------------------------------------------------------

export class DecisionsError extends Error {}

// envelope (probed 2025: `{ answers: { <qKey>: { choice: "<criteriaKey>", … } } }`).
// The chosen criteria key must be in the configured vocabulary and the
// coordinate must be one the request actually carried — anything else is
// skipped; a missing/malformed envelope throws (caller marks the run failed).
export function parseDecisionsResponse(
  raw: string,
  criteria: Record<string, string>,
  expected: Set<string>,
  keyMap: Map<string, { file: string; side: "old" | "new"; line: number }>,
): LineMark[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DecisionsError("response is not valid JSON");
  }
  const answers = (parsed as { answers?: Record<string, unknown> })?.answers;
  if (!answers || typeof answers !== "object") throw new DecisionsError("response has no answers object");
  const out: LineMark[] = [];
  for (const [key, answer] of Object.entries(answers)) {
    const coord = keyMap.get(key);
    const choice = (answer as { choice?: unknown })?.choice;
    if (!coord || typeof choice !== "string" || !(choice in criteria)) continue;
    if (!expected.has(`${coord.file}\u0000${coord.side}:${coord.line}`)) continue;
    out.push({ file: coord.file, side: coord.side, line: coord.line, mark: choice, markSource: "custom" });
  }
  return out;
}

// ---- the one boundary where HTTP runs --------------------------------------

export async function decisionsClassify(
  cfg: ClassifierConfig,
  root: string,
  request: string,
  fetchImpl = fetch,
): Promise<ClassifierRun> {
  const started = Date.now();
  const run: ClassifierRun = {
    failed: true,
    durationMs: 0,
    exitCode: null,
    stderr: "",
    request,
    response: "",
    marks: [],
  };
  const apiKey = resolveApiKey(cfg, root);
  if (!apiKey) {
    run.error = "no api key (classifier.apiKey / OPENROUTER_API_KEY / llm defaults)";
    run.durationMs = Date.now() - started;
    return run;
  }
  try {
    const { body, keyMap } = decisionsRequestBody(request, cfg);
    const res = await fetchImpl(`${cfg.baseUrl ?? DECISIONS_DEFAULT_BASE}/alpha/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body,
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
    });
    run.response = await res.text();
    if (!res.ok) run.error = `HTTP ${res.status}`;
    else
      run.marks = parseDecisionsResponse(
        run.response,
        cfg.criteria ?? DEFAULT_CRITERIA,
        expectedCoordinates(request),
        keyMap,
      );
  } catch (e) {
    run.error = (e as Error).message;
  }
  run.durationMs = Date.now() - started;
  if (!run.error) run.failed = false;
  return run;
}
