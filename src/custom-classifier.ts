// Classifier pass (spec §16.5): runs at every chapter rebuild. Two backends
// share one merge/fallback/log path — the exec hook (`classifier.command`:
// JSON request on stdin, sparse marks JSON on stdout) and built-in backends
// (`classifier.builtin`, first: OpenRouter's decision-model API via
// src/decisions.ts, model e.g. typesafe/jev-1.14). Marks are
// merged per line coordinate over the built-in rules pass — unmarked lines
// keep their rules marks. A failed run (non-zero exit, timeout, HTTP error,
// malformed output) keeps rules marks unless `fallback: false`, in which
// case marks are cleared (visible, honest failure).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { decisionsClassify } from "./decisions.ts";
import type { Chapter, ClassifierConfig, ClassifyRules, LineMark } from "./types.ts";

export const DEFAULT_TIMEOUT_MS = 30_000;

const configPath = (root: string) => path.join(root, ".sky-watch", "config.json");

// missing/invalid config → undefined: the custom pass is a no-op, sessions
// never block on it (§16.1 rule)
export function loadClassifierConfig(root: string): ClassifierConfig | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(root), "utf8"));
    const c = parsed.classifier;
    // exec hook wins over built-in backends (documented in §16.1)
    if (typeof c?.command === "string" && c.command.trim()) {
      return {
        command: c.command,
        timeoutMs: typeof c.timeoutMs === "number" ? c.timeoutMs : DEFAULT_TIMEOUT_MS,
        fallback: c.fallback !== false,
        debug: c.debug === true,
      };
    }
    // built-in backends; the OpenRouter backend needs a model — anything else → no pass (rules only)
    if (c?.builtin === "openrouter" && typeof c.model === "string" && c.model.trim()) {
      return {
        builtin: "openrouter",
        model: c.model,
        apiKey: typeof c.apiKey === "string" ? c.apiKey : undefined,
        baseUrl: typeof c.baseUrl === "string" ? c.baseUrl : undefined,
        instructions: typeof c.instructions === "string" ? c.instructions : undefined,
        criteria: validCriteria(c.criteria),
        timeoutMs: typeof c.timeoutMs === "number" ? c.timeoutMs : DEFAULT_TIMEOUT_MS,
        fallback: c.fallback !== false,
        debug: c.debug === true,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// mark NAME → criteria description; keys must be valid mark names (same
// regex the exec protocol enforces) with non-empty descriptions — invalid
// entries are dropped, none left → defaults (decisions.ts DEFAULT_CRITERIA)
function validCriteria(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [name, description] of Object.entries(raw as Record<string, unknown>)) {
    if (MARK_NAME.test(name) && typeof description === "string" && description.trim())
      out[name] = description.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

// config globs extending the built-in rule buckets (§16.4) — same
// config.json, key `classifyRules`; kept out of chunker's loadConfig so the
// chunker stays about chunking
export function loadClassifyRules(root: string): ClassifyRules | undefined {
  try {
    const r = (JSON.parse(fs.readFileSync(configPath(root), "utf8")) as {
      classifyRules?: { safePaths?: unknown; focusPaths?: unknown };
    }).classifyRules;
    if (!r || typeof r !== "object") return undefined;
    const rules: ClassifyRules = {};
    if (Array.isArray(r.safePaths)) rules.safePaths = r.safePaths.filter((g): g is string => typeof g === "string");
    if (Array.isArray(r.focusPaths)) rules.focusPaths = r.focusPaths.filter((g): g is string => typeof g === "string");
    return rules.safePaths?.length || rules.focusPaths?.length ? rules : undefined;
  } catch {
    return undefined;
  }
}

// ---- protocol v1 ---------------------------------------------------------

export const PROTOCOL = 1;

// stdin payload: only changed lines (`add`/`del`) — context lines never carry
// marks, and `side` is redundant with `type` but makes output mapping trivial
export function classifierRequest(
  repo: string,
  base: string,
  head: string,
  chapters: Chapter[],
): string {
  return JSON.stringify({
    protocol: PROTOCOL,
    repo,
    base,
    head,
    chapters: chapters.map((c) => ({
      id: c.id,
      files: c.files.map((f) => ({
        file: f.file,
        status: f.status,
        hunks: f.hunks.map((h) => ({
          lines: h.lines
            .filter((l) => l.type !== "ctx")
            .map((l) => ({
              type: l.type,
              side: l.type === "add" ? "new" : "old",
              line: l.type === "add" ? l.newLine : l.oldLine,
              text: l.text,
            })),
        })),
      })),
    })),
  });
}

export class ClassifierError extends Error {}

const MARK_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const keyOf = (m: LineMark) => `${m.file}\u0000${m.side}:${m.line}`;

// Structurally invalid output (unparseable, no marks array) throws; invalid
// *entries* (unknown coordinate, bad mark name) are dropped individually.
// `expected` holds the coordinates this run sent — the classifier cannot
// invent marks for lines sky-eye didn't show it.
export function parseClassifierResponse(raw: string, expected: Set<string>): LineMark[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ClassifierError("stdout is not valid JSON");
  }
  const marks = (parsed as { marks?: unknown })?.marks;
  if (!Array.isArray(marks)) throw new ClassifierError("response has no marks array");
  const out: LineMark[] = [];
  for (const m of marks) {
    const e = m as Partial<LineMark>;
    if (
      typeof e?.file !== "string" ||
      (e.side !== "old" && e.side !== "new") ||
      typeof e?.line !== "number" ||
      typeof e?.mark !== "string" ||
      !MARK_NAME.test(e.mark) ||
      !expected.has(`${e.file}\u0000${e.side}:${e.line}`)
    )
      continue;
    out.push({ file: e.file, side: e.side, line: e.line, mark: e.mark, markSource: "custom" });
  }
  return out;
}

// coordinates of every changed line in the request we sent — parsed back
// out of the request JSON so spawnClassifier doesn't need chapters threaded
// through (shared with the built-in OpenRouter backend)
export function expectedCoordinates(request: string): Set<string> {
  const parsed = JSON.parse(request) as {
    chapters: { files: { file: string; hunks: { lines: { side: string; line: number }[] }[] }[] }[];
  };
  const expected = new Set<string>();
  for (const c of parsed.chapters)
    for (const f of c.files)
      for (const h of f.hunks)
        for (const l of h.lines) expected.add(`${f.file}\u0000${l.side}:${l.line}`);
  return expected;
}

// ---- spawn + merge (the one boundary where a process runs) ---------------

export interface ClassifierRun {
  failed: boolean;
  error?: string;
  durationMs: number;
  exitCode: number | null;
  stderr: string;
  request: string;
  response: string;
  marks: LineMark[];
}

export async function spawnClassifier(
  config: ClassifierConfig,
  cwd: string,
  request: string,
): Promise<ClassifierRun> {
  const started = Date.now();
  // callers only invoke the exec path when `command` is set (config loader
  // guarantees it); the `!` encodes that contract
  const res = await shRun(config.command!, cwd, config.timeoutMs ?? DEFAULT_TIMEOUT_MS, request);
  const durationMs = Date.now() - started;
  const run: ClassifierRun = {
    failed: true,
    durationMs,
    exitCode: res.code,
    stderr: res.stderr,
    request,
    response: res.stdout,
    marks: [],
  };
  if (res.code !== 0) {
    run.error = `exit ${res.code}${res.killed ? " (timeout)" : ""}`;
    return run;
  }
  try {
    run.marks = parseClassifierResponse(res.stdout, expectedCoordinates(request));
  } catch (e) {
    run.error = (e as Error).message;
    return run;
  }
  run.failed = false;
  return run;
}

// single string command via /bin/sh -c: `~/bin/my-classifier | jq` pipelines
// work; trust level equals the config file the user already owns (§16.1)
function shRun(
  command: string,
  cwd: string,
  timeoutMs: number,
  input: string,
): Promise<{ code: number | null; killed: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: null, killed: false, stdout, stderr: stderr + String(e) }));
    child.on("close", (code, signal) =>
      resolve({ code, killed: signal === "SIGTERM", stdout, stderr }));
    child.stdin.on("error", () => {}); // classifier may close stdin early
    child.stdin.end(input);
  });
}

// One-run rotation (user decision, plan 008): `classifier.log.1` ← rename the
// previous log, then write fresh — two files total, always bounded.
function writeLog(root: string, config: ClassifierConfig, run: ClassifierRun): void {
  try {
    const dir = path.join(root, ".sky-watch");
    fs.mkdirSync(dir, { recursive: true });
    const log = path.join(dir, "classifier.log");
    if (fs.existsSync(log)) fs.renameSync(log, log + ".1");
    const tail = (s: string, n: number) => (s.length > n ? "…" + s.slice(-n) : s);
    fs.writeFileSync(
      log,
      JSON.stringify(
        {
          time: new Date().toISOString(),
          command: config.command ?? `openrouter:${config.model}`, // backend label
          durationMs: run.durationMs,
          exitCode: run.exitCode,
          failed: run.failed,
          error: run.error,
          stderrTail: tail(run.stderr, 2000),
          marksOut: run.marks.length,
          // full transcript only with classifier.debug (§16.1)
          ...(config.debug ? { request: run.request, response: run.response, stderr: run.stderr } : {}),
        },
        null,
        2,
      ) + "\n",
    );
  } catch {
    // logging must never break a session
  }
}

// Mutates the freshly-built chapters' attention in place per the merge
// semantics. No-op without config; rules marks are the fallback layer.
// Backend selection: exec hook (`command`) wins, else built-in (OpenRouter).
export async function applyClassifier(
  root: string,
  base: string,
  head: string,
  chapters: Chapter[],
): Promise<void> {
  const config = loadClassifierConfig(root);
  if (!config) return;
  const request = classifierRequest(root, base, head, chapters);
  const run = config.command
    ? await spawnClassifier(config, root, request)
    : await decisionsClassify(config, root, request);
  writeLog(root, config, run);
  if (run.failed) {
    if (config.fallback) return; // keep the rules marks
    for (const c of chapters) c.attention = []; // custom classifier is authoritative
    return;
  }
  const byKey = new Map(run.marks.map((m) => [keyOf(m), m]));
  for (const c of chapters)
    c.attention = c.attention.map((m) => byKey.get(keyOf(m)) ?? m);
}
