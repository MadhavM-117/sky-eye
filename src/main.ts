// Entry: repo detect → ignore upkeep → server start → browser open (spec §4.1).
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { upsertIgnoreFile } from "./ignore.ts";
import { checkConfig } from "./check-config.ts";
import { serve } from "./server.ts";
import { reviewCommand } from "./review-cli.ts";
import {
  classifierRequest,
  loadClassifierConfig,
  spawnClassifier,
} from "./custom-classifier.ts";
import { decisionsClassify, decisionsUrl } from "./decisions.ts";
import { loadSession } from "./store.ts";
import "./routes.ts";

function findRoot(dir: string): string | null {
  if (
    fs.existsSync(path.join(dir, ".jj")) ||
    fs.existsSync(path.join(dir, ".git"))
  )
    return dir;
  const parent = path.dirname(dir);
  return parent === dir ? null : findRoot(parent);
}

const root = findRoot(process.cwd());
if (!root) {
  console.error(
    `sky-eye: no git or .jj repo found in ${process.cwd()}\n` +
      `run sky-eye inside a repository.`,
  );
  process.exit(1);
}
const kind = fs.existsSync(path.join(root, ".jj")) ? "jj" : "git"; // jj wins for colocated

// `sky-eye debug-classify <sessionId>`: replay the classifier against a
// stored session — prints the transcript, never writes session or log (§16.5)
if (process.argv[2] === "debug-classify") {
  const id = process.argv[3];
  if (!id) {
    console.error("usage: sky-eye debug-classify <sessionId>");
    process.exit(1);
  }
  const session = loadSession(root, id);
  const config = loadClassifierConfig(root);
  if (!config) {
    console.error("sky-eye: no classifier configured (.sky-eye/config.json → classifier.command / classifier.builtin)");
    process.exit(1);
  }
  const request = classifierRequest(root, session.base, session.head, session.chapters);
  const run = config.command
    ? await spawnClassifier({ ...config, debug: true }, root, request)
    : await decisionsClassify(config, root, request);
  const overridden = run.failed ? 0 : session.chapters.reduce(
    (n, c) => n + c.attention.filter((m) => run.marks.some((k) =>
      k.file === m.file && k.side === m.side && k.line === m.line)).length,
    0,
  );
  const rulesMarks = session.chapters.reduce((n, c) => n + c.attention.length, 0);
  console.log(
    [
      `backend:  ${config.command ?? `${config.builtin}:${config.model} @ ${decisionsUrl(config)}`}`,
      `duration: ${run.durationMs}ms, exit: ${run.exitCode}${run.failed ? ` — FAILED: ${run.error}` : ""}`,
      `marks:    ${run.marks.length} custom applied, ${rulesMarks - overridden} rules kept`,
      run.stderr ? `--- stderr ---\n${run.stderr.trimEnd()}` : "",
      `--- request ---\n${request}`,
      `--- response ---\n${run.response.trimEnd()}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  process.exit(0);
}

// `sky-eye check-config`: live probe of every configured part of
// .sky-eye/config.json — LLM task pings, classifier backend round-trip,
// static keys as parsed (spec §16.1). Read-only: runs before ignore upkeep.
if (process.argv[2] === "check-config") {
  const results = await checkConfig(root);
  for (const r of results) {
    const name = (r.name + " ".repeat(16)).slice(0, 16);
    console.log(`${name}${r.status.padEnd(5)} ${r.detail}`);
  }
  const failed = results.filter((r) => r.status === "fail").length;
  if (failed) {
    console.error(`sky-eye: ${failed} configured part${failed > 1 ? "s" : ""} failed`);
    process.exit(1);
  }
  process.exit(0);
}

// `sky-eye review start|narrate|wait`: the agent review loop (§16a) —
// exits without touching the server lifecycle (it manages its own)
if (process.argv[2] === "review") {
  await reviewCommand(process.argv.slice(3), root, kind);
  process.exit(0);
}

upsertIgnoreFile(root, ".gitignore", true);
upsertIgnoreFile(
  root,
  ".dockerignore",
  fs.existsSync(path.join(root, ".dockerignore")),
);

// `sky-eye serve [--no-open]`: plain server, spawnable by the review CLI
const noOpen = process.argv[2] === "serve" && process.argv.includes("--no-open");

const { port } = await serve(root, kind);
console.log(
  `sky-eye serving ${root} (${kind} repo) → http://localhost:${port}`,
);

const url = `http://localhost:${port}`;
if (!noOpen) {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  execFile(opener, [url], (err) => {
    if (err) console.warn(`sky-eye: could not open browser — visit ${url}`);
  });
}
