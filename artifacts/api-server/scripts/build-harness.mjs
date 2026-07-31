// Bundles a dev-only script the same way the server itself is bundled, so
// harnesses can import server modules without a separate TS runner.
//
//   node scripts/build-harness.mjs scripts/render-invoice.ts /tmp/harness.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const artifactDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [entry, outfile] = process.argv.slice(2);

await esbuild({
  entryPoints: [path.resolve(artifactDir, entry)],
  platform: "node",
  bundle: true,
  format: "esm",
  outfile,
  logLevel: "warning",
  external: ["*.node", "sharp", "pg-native", "bcrypt", "argon2", "fsevents"],
  banner: {
    js: `import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);`,
  },
});
