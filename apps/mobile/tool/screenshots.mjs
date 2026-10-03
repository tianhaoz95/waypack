// Runs integration_test/screenshots_test.dart and captures the simulator at each SHOT marker.
//   node tool/screenshots.mjs <simulator-udid> <out-dir> [--fake-now 2026-12-25T10:05:00-08:00]
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [udid, out] = process.argv.slice(2);
const fakeNow = process.argv.includes("--fake-now") ? process.argv[process.argv.indexOf("--fake-now") + 1] : "";
mkdirSync(out, { recursive: true });
const args = ["test", "integration_test/screenshots_test.dart", "-d", udid, "--dart-define=NO_PERMISSION_PROMPTS=true", "--dart-define=DEV_SIGN_IN=true"];
if (fakeNow) args.push(`--dart-define=FAKE_NOW=${fakeNow}`);
const p = spawn("flutter", args, { cwd: new URL("..", import.meta.url).pathname });
let buf = "";
p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const m = line.match(/SHOT:([\w-]+)/);
    if (m) {
      setTimeout(() => {
        execFileSync("xcrun", ["simctl", "io", udid, "screenshot", join(out, `${m[1]}.png`)], { stdio: "ignore" });
        console.log("captured", m[1]);
      }, 600);
    } else if (/passed|failed|Error/.test(line)) console.log(line.trim());
  }
});
p.stderr.on("data", (d) => process.stderr.write(d));
p.on("exit", (c) => process.exit(c ?? 1));
