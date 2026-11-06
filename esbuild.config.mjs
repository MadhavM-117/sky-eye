// Bundles the frontend (spec §2): the @pierre/* dists are ESM with bare
// imports (`shiki`, `diff`, …) that a static file server cannot resolve, so
// public/app.js is bundled to public/dist/. The server keeps its no-build
// rule — this only ever touches src/public/dist/.
import { build } from "esbuild";

await build({
  entryPoints: ["src/public/app.js"],
  bundle: true,
  format: "esm",
  outdir: "src/public/dist",
  // shiki loads language grammars via dynamic import; chunks keep the
  // initial load small — the server serves the whole dist/ statically
  splitting: true,
  minify: true,
  logLevel: "info",
});
