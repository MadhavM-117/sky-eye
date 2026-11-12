// Agent review loop CLI (spec §16a): `sky-eye review start|narrate|wait`.
// The agent session authors narratives + marks from its own task context,
// then blocks in `wait` until the human submits the review in the browser.
// JSON in/out on stdout — any agent harness that can run a shell can drive
// this; no MCP server (decision record, spec §16a).
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PORT_BASE, PORT_SCAN_MAX } from "./server.ts";
import type { Session } from "./types.ts";

const HDR = { "content-type": "application/json", "x-sky-eye": "1" };

const usage = () => {
  console.error(
    "usage: sky-eye review start [--base <ref>]\n" +
      "       sky-eye review narrate <sessionId> --from <file|->\n" +
      "       sky-eye review wait <sessionId> [--timeout N] [--json]",
  );
  process.exit(1);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A live server only counts when it serves THIS repo — another repo's
// sky-eye on a lower port must be skipped (§16a.2), else the agent reviews
// the wrong diff. fetch() never throws for connection-refused? It does —
// caught per port.
async function findServer(root: string): Promise<number | null> {
  for (let port = PORT_BASE; port <= PORT_SCAN_MAX; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/refs`);
      if (!res.ok) continue;
      const refs = (await res.json()) as { root?: string };
      if (refs.root === root) return port;
    } catch {
      // nothing listening (or hostile junk) — next port
    }
  }
  return null;
}

async function ensureServer(root: string, kind: "git" | "jj"): Promise<number> {
  const live = await findServer(root);
  if (live) return live;
  // detached child through the bin wrapper (how users run sky-eye), with
  // execArgv passed through so the type-stripping flag survives on Node 22.6
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "sky-eye.js");
  const child = spawn(
    process.execPath,
    [...process.execArgv, bin, "serve", "--no-open"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(200);
    const port = await findServer(root);
    if (port) return port;
  }
  console.error(`sky-eye: spawned server did not come up within 5s (pid ${child.pid})`);
  process.exit(1);
}

// ---- start -----------------------------------------------------------------

function chapterToc(s: Session) {
  return s.chapters.map((c) => ({
    id: c.id,
    title: c.title,
    files: c.files.map((sl) => `${sl.file} (${sl.status})`),
    hunks: c.files.reduce((n, sl) => n + sl.hunks.length, 0),
    changedLines: c.files.reduce(
      (n, sl) =>
        n + sl.hunks.reduce((k, h) => k + h.lines.filter((l) => l.type !== "ctx").length, 0),
      0,
    ),
  }));
}

async function start(args: string[], root: string, kind: "git" | "jj"): Promise<void> {
  const baseArg = args.includes("--base") ? args[args.indexOf("--base") + 1] : undefined;
  const port = await ensureServer(root, kind);
  const api = `http://127.0.0.1:${port}`;
  const refs = (await (await fetch(`${api}/api/refs`)).json()) as {
    head: { id: string; label: string | null };
    defaultBase: { id: string; label: string } | null;
  };
  const base = baseArg ?? refs.defaultBase?.id;
  if (!base) {
    console.error("sky-eye: no default base found — pass --base <ref>");
    process.exit(1);
  }
  const res = await fetch(`${api}/api/sessions`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({
      base,
      head: refs.head.id,
      baseLabel: refs.defaultBase?.label,
      headLabel: refs.head.label ?? undefined,
      analysis: "skip",
    }),
  });
  if (!res.ok) {
    console.error(`sky-eye: ${((await res.json()) as { error?: string }).error ?? res.status}`);
    process.exit(1);
  }
  const session = (await res.json()) as Session;
  if (res.status === 200) {
    // existing session for the same base..head (guaranteed in git mode where
    // head is a branch ref) — clear round-one state so wait can't return a
    // stale snapshot (§16a.3)
    await fetch(`${api}/api/sessions/${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      headers: HDR,
      body: JSON.stringify({ lastWriteAt: session.lastWriteAt, review: null }),
    });
  }
  console.log(
    JSON.stringify(
      {
        sessionId: session.id,
        url: `${api}/#${session.id}`,
        port,
        chapters: chapterToc(session),
      },
      null,
      2,
    ),
  );
}

// ---- narrate ---------------------------------------------------------------

async function narrate(args: string[], root: string, kind: "git" | "jj"): Promise<void> {
  const [id, flag, from] = args;
  if (!id || flag !== "--from" || !from) usage();
  const raw =
    from === "-"
      ? await new Promise<string>((resolve, reject) => {
          let data = "";
          process.stdin.on("data", (c) => (data += c));
          process.stdin.on("end", () => resolve(data));
          process.stdin.on("error", reject);
        })
      : fs.readFileSync(from, "utf8");
  let input: {
    narratives?: { chapterId: string; text: string }[];
    marks?: { chapterId: string; marks: { file: string; side: string; line: number; mark: string }[] }[];
  };
  try {
    input = JSON.parse(raw);
  } catch (e) {
    console.error(`sky-eye: --from is not valid JSON: ${(e as Error).message}`);
    process.exit(1);
  }
  const port = await ensureServer(root, kind);
  const api = `http://127.0.0.1:${port}`;
  const sid = encodeURIComponent(id);
  const sRes = await fetch(`${api}/api/sessions/${sid}`);
  if (!sRes.ok) {
    console.error(`sky-eye: cannot load session ${id} (${sRes.status})`);
    process.exit(1);
  }
  const session = (await sRes.json()) as Session;
  // lastWriteAt goes with the write (§9.4): a concurrent browser edit 409s
  // instead of being silently clobbered
  const res = await fetch(`${api}/api/sessions/${sid}`, {
    method: "PATCH",
    headers: HDR,
    body: JSON.stringify({
      lastWriteAt: session.lastWriteAt,
      narratives: input.narratives ?? [],
      ...(input.marks ? { marks: input.marks } : {}),
    }),
  });
  if (!res.ok) {
    const body = (await res.json()) as { error?: string };
    console.error(
      res.status === 409
        ? "sky-eye: session changed elsewhere (edited in the browser meanwhile) — re-run review start"
        : `sky-eye: ${body.error ?? res.status}`,
    );
    process.exit(1);
  }
  const n = (input.narratives ?? []).length;
  const m = (input.marks ?? []).reduce((k, x) => k + x.marks.length, 0);
  console.log(`${n} narratives, ${m} marks written → ${api}/#${id}`);
}

// ---- wait ------------------------------------------------------------------

function printReview(review: NonNullable<Session["review"]>, json: boolean): void {
  if (json) {
    // anchors are rebase-matching blobs — dead weight in an agent's context
    const comments = review.comments.map(({ anchor: _a, orphaned: _o, ...rest }) => rest);
    console.log(JSON.stringify({ submittedAt: review.submittedAt, comments }, null, 2));
    return;
  }
  console.log(`review received — ${review.comments.length} comment${review.comments.length === 1 ? "" : "s"}`);
  for (const c of review.comments) {
    console.log(
      `\n${c.file}:${c.line} (${c.side})${c.priority ? ` [priority: ${c.priority}]` : ""}`,
    );
    console.log(`  ${c.text}`);
  }
}

async function wait(args: string[], root: string, kind: "git" | "jj"): Promise<void> {
  const id = args[0];
  if (!id) usage();
  const timeoutIdx = args.indexOf("--timeout");
  const timeout = timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) : 0;
  const json = args.includes("--json");
  const port = await ensureServer(root, kind);
  const api = `http://127.0.0.1:${port}`;
  const url = `${api}/#${id}`;
  console.log(`sky-eye: waiting for your review\n→ ${url}`);
  const deadline = timeout > 0 ? Date.now() + timeout * 1000 : Infinity;
  let lastReprint = Date.now();
  const sid = encodeURIComponent(id);
  for (;;) {
    const res = await fetch(`${api}/api/sessions/${sid}`).catch(() => null);
    if (res?.ok) {
      const s = (await res.json()) as Session;
      if (s.review) {
        process.stdout.write("\n");
        printReview(s.review, json);
        return;
      }
    } else if (res?.status === 404) {
      console.error(`sky-eye: unknown session: ${id}`);
      process.exit(1);
    }
    if (Date.now() - lastReprint >= 30_000) {
      // one rewritten line — a user returning to the terminal always sees
      // the URL on the last line (§16a.1)
      process.stdout.write(`\r  still waiting → ${url}   `);
      lastReprint = Date.now();
    }
    if (Date.now() > deadline) {
      console.error(`sky-eye: no review received within ${timeout}s`);
      process.exit(2);
    }
    await sleep(2000);
  }
}

export async function reviewCommand(args: string[], root: string, kind: "git" | "jj"): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "start") return start(rest, root, kind);
  if (sub === "narrate") return narrate(rest, root, kind);
  if (sub === "wait") return wait(rest, root, kind);
  usage();
}
