// HTTP server: security checks, routing, static serving (spec §4.2–4.3).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError } from "./cli.ts";

export interface Ctx {
  root: string;
  kind: "git" | "jj";
  params: Record<string, string>;
  url: URL;
  body: unknown;
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
type Route = { method: string; pattern: RegExp; names: string[]; handler: Handler };

const routes: Route[] = [];

export function route(
  method: string,
  pattern: string,
  handler: Handler,
) {
  const names: string[] = [];
  const regex = new RegExp(
    "^" +
      pattern.replace(/:(\w+)/g, (_, name: string) => {
        names.push(name);
        return "([^/]+)";
      }) +
      "$",
  );
  routes.push({ method, pattern: regex, names, handler });
}

const publicDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "public",
);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) text += chunk;
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid JSON body");
  }
}

async function serveStatic(res: http.ServerResponse, pathname: string) {
  // same containment rule as §11: normalized path must stay inside public/
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const normalized = path.normalize(rel);
  const full = path.join(publicDir, normalized);
  if (!full.startsWith(publicDir + path.sep) && full !== publicDir)
    throw new ApiError(404, "not found");
  let data: Buffer;
  try {
    data = fs.readFileSync(full);
  } catch {
    throw new ApiError(404, "not found");
  }
  const ext = path.extname(full);
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    // heuristic caching served a stale app.js bundle after a rebuild —
    // no-cache revalidates every load so the UI is never older than the repo
    "cache-control": "no-cache",
  });
  res.end(data);
}

function sendJson(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

export function handle(
  root: string,
  kind: "git" | "jj",
  req: http.IncomingMessage,
  res: http.ServerResponse,
  port: number,
): Promise<void> {
  return (async () => {
    const url = new URL(req.url ?? "/", "http://localhost:" + port);
    // 1. Host check — kills DNS-rebinding (spec §4.2)
    const host = req.headers.host ?? "";
    if (
      host !== `localhost:${port}` &&
      host !== `127.0.0.1:${port}`
    ) {
      return sendJson(res, 403, { error: "forbidden" });
    }
    // 2. CSRF check on mutations — browsers can't set custom headers cross-origin
    if (req.method !== "GET" && req.headers["x-sky-eye"] !== "1") {
      return sendJson(res, 403, { error: "forbidden" });
    }
    // 3. No CORS headers are ever emitted.

    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET")
        return sendJson(res, 405, { error: "method not allowed" });
      return serveStatic(res, url.pathname);
    }

    const body = await readBody(req);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      const result = await r.handler({ root, kind, params, url, body });
      if (res.headersSent) return;
      // handlers return a value or { status, value }
      const s = result as {
        status?: number;
        value?: unknown;
        raw?: string;
        headers?: Record<string, string>;
      };
      // raw body (export route): verbatim bytes + extra headers (e.g. the
      // Content-Disposition download affordance) instead of re-serialization
      if (s && typeof s === "object" && "raw" in s && typeof s.raw === "string") {
        res.writeHead(s.status ?? 200, {
          "content-type": "application/json",
          ...s.headers,
        });
        res.end(s.raw);
        return;
      }
      if (s && typeof s === "object" && "status" in s && "value" in s)
        return sendJson(res, s.status ?? 200, s.value);
      return sendJson(res, 200, result);
    }
    throw new ApiError(404, "not found");
  })().catch((e: unknown) => {
    if (res.headersSent) return;
    const err = e as ApiError;
    sendJson(res, err.status ?? 500, err.payload ?? { error: err.message });
  });
}

// serve() binds 4800, scanning upward on EADDRINUSE (spec §4.1)
export function serve(
  root: string,
  kind: "git" | "jj",
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    let port = 4800;
    const tryPort = () => {
      const server = http.createServer((req, res) => {
        const addr = server.address();
        const p = typeof addr === "object" && addr ? addr.port : port;
        void handle(root, kind, req, res, p);
      });
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE") {
          tryPortOn(++port);
          return;
        }
        reject(e);
      });
      server.listen(port, "127.0.0.1");
      server.once("listening", () => resolve({ server, port }));
    };
    const tryPortOn = (p: number) => {
      port = p;
      tryPort();
    };
    tryPort();
  });
}
