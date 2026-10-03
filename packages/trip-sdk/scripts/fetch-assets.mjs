// Downloads the Protomaps glyphs (fonts) and sprites so maps render labels offline.
// Output: assets/fonts/<fontstack>/<range>.pbf, assets/sprites/v4/{light,dark}[@2x].{json,png}
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "assets");
const REF = process.env.BASEMAPS_ASSETS_REF ?? "main";

if (existsSync(join(out, "fonts/Noto Sans Regular/0-255.pbf")) && !process.argv.includes("--force")) {
  console.log("assets present (use --force to refetch)");
  process.exit(0);
}
const tmp = mkdtempSync(join(tmpdir(), "waypack-assets-"));
console.log(`fetching protomaps/basemaps-assets@${REF} …`);
execSync(`curl -fsSL https://github.com/protomaps/basemaps-assets/archive/${REF}.tar.gz | tar xz -C "${tmp}"`, { stdio: "inherit" });
const src = join(tmp, `basemaps-assets-${REF}`);
mkdirSync(join(out, "sprites/v4"), { recursive: true });
// Upstream stores some fontstacks as relative symlinks; -L copies real files.
execSync(`cp -RL "${join(src, "fonts")}" "${out}/"`);
for (const f of ["light", "dark"]) {
  for (const s of ["", "@2x"]) for (const ext of ["json", "png"]) cpSync(join(src, `sprites/v4/${f}${s}.${ext}`), join(out, `sprites/v4/${f}${s}.${ext}`));
}
rmSync(tmp, { recursive: true, force: true });
console.log("assets ready in", out);
