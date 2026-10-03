// Packs packages/trip-sdk/dist into assets/sdk.zip (+ version) for the app's local server.
// Run after building the SDK:  npm run build -w @waypack/trip-sdk && node apps/mobile/tool/bundle_sdk.mjs
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "../../../packages/trip-sdk/dist");
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const files = {};
for (const p of walk(dist)) files[relative(dist, p)] = [new Uint8Array(readFileSync(p)), { level: /\.(png|pbf)$/.test(p) ? 0 : 6 }];
const zip = zipSync(files);
writeFileSync(join(here, "../assets/sdk.zip"), zip);
const v = JSON.parse(readFileSync(join(dist, "version.json"), "utf8"));
writeFileSync(join(here, "../assets/sdk_version.txt"), `${v.version}\n`);
console.log(`assets/sdk.zip: ${Object.keys(files).length} files, ${(zip.byteLength / 1048576).toFixed(1)} MB (SDK ${v.version})`);
