#!/usr/bin/env node
// wrapper: npm bins can't exec .ts directly, hand off to node's type stripping
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const main = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts");
await import(main);
