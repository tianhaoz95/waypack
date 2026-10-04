// Copies the built trip SDK (packages/trip-sdk/dist) into the Worker's static assets at
// site/__waypack/sdk/v1/, so the preview origin can serve /__waypack/sdk/v1/waypack.js like the app does.
// Generated (gitignored); runs before `npm run dev` and `npm run deploy`.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "../../../packages/trip-sdk/dist");
const out = join(here, "../../../site/__waypack/sdk/v1");
if (!existsSync(join(dist, "waypack.js"))) {
  console.error("trip SDK not built: run `npm run build -w @waypack/trip-sdk` first");
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
cpSync(dist, out, { recursive: true });
console.log(`SDK → ${out}`);
