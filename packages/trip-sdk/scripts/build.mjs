// Builds dist/waypack.js (IIFE exposing window.Waypack) and copies offline assets.
import { build } from "esbuild";
import { cpSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!existsSync(join(root, "assets/fonts"))) execSync("node scripts/fetch-assets.mjs", { cwd: root, stdio: "inherit" });

await build({
  entryPoints: [join(root, "src/index.ts")],
  bundle: true,
  format: "iife",
  minify: true,
  sourcemap: false,
  target: ["es2020", "safari15"],
  outfile: join(root, "dist/waypack.js"),
  loader: { ".css": "text" },
  define: { __SDK_VERSION__: JSON.stringify(pkg.version) },
  legalComments: "eof",
  logLevel: "info",
});
// MapLibre 6 runs its parser in a separate worker module; ship it as one self-contained file
// next to the SDK so it loads from the same (offline) origin.
await build({
  entryPoints: [join(root, "../../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs")],
  bundle: true,
  format: "iife",
  minify: true,
  target: ["es2020", "safari15"],
  outfile: join(root, "dist/waypack-worker.js"),
  legalComments: "eof",
  logLevel: "info",
});
rmSync(join(root, "dist/assets"), { recursive: true, force: true });
cpSync(join(root, "assets"), join(root, "dist/assets"), { recursive: true, dereference: true });
writeFileSync(join(root, "dist/version.json"), JSON.stringify({ version: pkg.version, major: 1 }) + "\n");
console.log("SDK built");
