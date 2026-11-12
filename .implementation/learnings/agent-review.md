# Agent review loop (task 030)

- CLI subprocess + in-process server = deadlock: `execFileSync` blocks the
  parent's event loop, so a server started via `serve()` in the test process
  can never answer the child. Spawn the server as its own process when a
  test drives it with a CLI subprocess.
- The integration harness's `mut()` resolves `{status, body}` — assert
  409s with `assert.equal(res.status, 409)`, never `assert.rejects`.
- npm bins can't exec .ts: spawn detached servers through `bin/sky-eye.js`
  (the wrapper handles type-stripping), passing `process.execArgv` through.
- This dev machine keeps long-lived sky-eye servers (tmp/demo et al.) in the
  4800–4899 range — any probe must check `refs.root`, not just "something
  answered".
