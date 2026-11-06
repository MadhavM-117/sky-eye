// Identity fall-through fixtures (spec §15, §20): jj config first, git
// fallback, both required, else anonymous.
import assert from "node:assert/strict";
import { test } from "node:test";
import { authorFrom } from "../src/identity.ts";

test("authorFrom: jj wins over git", () => {
  assert.deepEqual(
    authorFrom("jj user", "jj@x", "git user", "git@x"),
    { name: "jj user", email: "jj@x" },
  );
});

test("authorFrom: git fall-through when jj unset (nulls from tryRun)", () => {
  assert.deepEqual(authorFrom(null, null, "git user", "git@x"), {
    name: "git user",
    email: "git@x",
  });
});

test("authorFrom: mixed jj/git values compose", () => {
  assert.deepEqual(authorFrom("jj user", null, null, "git@x"), {
    name: "jj user",
    email: "git@x",
  });
});

test("authorFrom: either field missing → null → anonymous", () => {
  assert.equal(authorFrom("jj user", null, null, null), null);
  assert.equal(authorFrom(null, null, null, "git@x"), null);
  assert.equal(authorFrom(null, null, null, null), null);
});

test("authorFrom: whitespace and multi-line CLI output trimmed", () => {
  assert.deepEqual(authorFrom("  jj user\n", "jj@x\n", null, null), {
    name: "jj user",
    email: "jj@x",
  });
  assert.equal(authorFrom("\n", "jj@x", null, null), null);
});
