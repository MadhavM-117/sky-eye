# server-protocol

- Route handlers return plain values (→ 200 JSON), `{ status, value }` for
  custom codes, or `{ raw, headers? }` for verbatim bodies — the export
  route uses `raw` so the session file is sent byte-for-byte with a
  `Content-Disposition` attachment header (server.ts `handle()`).
- Security checks run before routing: Host check (DNS-rebinding) →
  `x-sky-eye: 1` header on all non-GET (CSRF) → no CORS headers ever.
  `readBody` runs even for GET (empty body → `{}`).
- mergeSessions (store.ts) mutates the LOCAL session in place and returns
  it — imported chapters are never adopted wholesale, only narratives ride
  across, and only onto locally unedited chapters.
