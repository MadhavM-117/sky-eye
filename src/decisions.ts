// Built-in decision-model classifier backends (spec §16.5): one blocking
// HTTP request per rebuild to OpenRouter's decision API
// (`POST {baseUrl}/alpha/decisions`) or OpenAI's Decisions API
// (`POST {baseUrl}/decisions`). Every changed line becomes one
// `choice` question whose criteria are the configured mark map — keys are
// the mark NAMES, values their criteria (§16.1). Question keys are
// generated (q0, q1, …) with a side map back to the line coordinate, so odd
// file names never round-trip through question keys. Same degradation
// contract as the exec hook: a failed run never blocks the session — rules
// marks survive (or clear with `fallback: false`).
//
// shortcut: one request per rebuild carries every changed line as a
// question — if a vendor rejects large question counts (OpenAI caps at
// 400), chunk per chapter.
import { expectedCoordinates, type ClassifierRun } from "./custom-classifier.ts";
import { loadLlmConfig } from "./llm.ts";
import type { ClassifierConfig, LineMark } from "./types.ts";

export const DECISIONS_DEFAULT_BASE = "https://openrouter.ai/api";
export const OPENAI_DECISIONS_DEFAULT_BASE = "https://api.openai.com/v1";

// full endpoint per backend — the one place vendor paths live
export function decisionsUrl(cfg: ClassifierConfig): string {
  return cfg.builtin === "openai"
    ? `${cfg.baseUrl ?? OPENAI_DECISIONS_DEFAULT_BASE}/decisions`
    : `${cfg.baseUrl ?? DECISIONS_DEFAULT_BASE}/alpha/decisions`;
}

// §16.4 buckets — the default vocabulary when `criteria` is not configured
export const DEFAULT_CRITERIA: Record<string, string> = {
  safe: "Tests, lockfiles, docs, generated code — no attention needed",
  glance: "Ordinary code — a quick skim is enough",
  focus: "Security, money, credentials, async/error flow — read carefully",
};

const DEFAULT_INSTRUCTIONS =
  "Which attention mark does this changed line of a code review diff deserve?";

// apiKey resolution (§16.1): classifier key, then the vendor's env var
// (OPENROUTER_API_KEY / OPENAI_API_KEY), then the chapter analyser's
// `defaults` — one key serves both the analyser and the classifier
export function resolveApiKey(cfg: ClassifierConfig, root: string): string | undefined {
  if (cfg.apiKey?.trim()) return cfg.apiKey.trim();
  const env = cfg.builtin === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY";
  return process.env[env]?.trim() || loadLlmConfig(root)?.defaults?.apiKey?.trim() || undefined;
}

// ---- request building (pure) ----------------------------------------------

interface ProtocolLine {
  type: string;
  side: string;
  line: number;
  text: string;
}
interface ProtocolRequest {
  chapters: { id: string; title?: string; files: { file: string; status: string; hunks: { lines: ProtocolLine[] }[] }[] }[];
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
  const questions: Record<string, object> = {};
  const keyMap = new Map<string, { file: string; side: "old" | "new"; line: number }>();
  let n = 0;
  for (const chapter of parsed.chapters) {
    // semantic chapter title (§8a) rides along as context — in the state
    // block and in each of the chapter's question instructions
    const context = chapter.title ? `Chapter context: "${chapter.title}"
` : "";
    const parts: string[] = [];
    if (chapter.title) parts.push(`## "${chapter.title}"`);
    for (const f of chapter.files) {
      parts.push(`${f.file} (${f.status})`);
      for (const hunk of f.hunks)
        for (const l of hunk.lines) {
          const key = `q${n++}`;
          const where = l.side === "new" ? `new line ${l.line}` : `removed line ${l.line}`;
          parts.push(`${l.type === "add" ? "+" : "-"} ${l.text}`);
          const q = {
            type: "choice" as const,
            instructions: `${context}${instructions}\nLine ${f.file} (${where}): "${l.text}"`,
          };
          // openai takes the vocabulary as {value, description} parts,
          // openrouter as a plain criteria map
          questions[key] = cfg.builtin === "openai"
            ? { ...q, choices: Object.entries(criteria).map(([value, description]) => ({ value, description })) }
            : { ...q, criteria };
          keyMap.set(key, { file: f.file, side: l.side as "old" | "new", line: l.line });
        }
    }
    state.push(parts.join("\n"));
  }
  if (cfg.builtin === "openai")
    return {
      body: JSON.stringify({
        model: cfg.model,
        input: state.join("\n\n"),
        questions: Object.entries(questions).map(([name, q]) => ({ name, ...q })),
      }),
      keyMap,
    };
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
  const rawAnswers = (parsed as { answers?: unknown })?.answers;
  if (!rawAnswers || typeof rawAnswers !== "object") throw new DecisionsError("response has no answers object");
  // envelope normalization: OpenAI returns an ARRAY of answers keyed by
  // `name`, OpenRouter an OBJECT keyed by question key — one lookup after
  const answers: Record<string, unknown> = Array.isArray(rawAnswers)
    ? Object.fromEntries(
        rawAnswers
          .filter((a): a is { name: string } => !!a && typeof a === "object" && typeof (a as { name?: unknown }).name === "string")
          .map((a) => [a.name, a]),
      )
    : (rawAnswers as Record<string, unknown>);
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
    const env = cfg.builtin === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY";
    run.error = `no api key (classifier.apiKey / ${env} / llm defaults)`;
    run.durationMs = Date.now() - started;
    return run;
  }
  try {
    const { body, keyMap } = decisionsRequestBody(request, cfg);
    const res = await fetchImpl(decisionsUrl(cfg), {
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
