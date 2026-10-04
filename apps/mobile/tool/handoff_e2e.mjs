// Offline handoff between two real app instances: the Mac app sends, an iOS simulator receives
// over this Mac's network address (like two phones on the same Wi-Fi).
//   node tool/handoff_e2e.mjs <simulator-udid> <out-dir>
// Needs the local stack, dev@waypack.test seeded with a trip (services/mcp/scripts/seed-dev.mjs).
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [udid, out] = process.argv.slice(2);
if (!udid || !out) throw new Error("usage: node tool/handoff_e2e.mjs <simulator-udid> <out-dir>");
mkdirSync(out, { recursive: true });
const cwd = new URL("..", import.meta.url).pathname;
const windowId = join(mkdtempSync(join(tmpdir(), "waypack-shots-")), "window_id");
execFileSync("swiftc", [new URL("window_id.swift", import.meta.url).pathname, "-o", windowId]);
const shotMac = (name) => {
  const id = execFileSync(windowId, ["Waypack"]).toString().trim();
  execFileSync("screencapture", ["-x", "-o", "-l", id, join(out, `${name}.png`)]);
};
const shotSim = (name) => execFileSync("xcrun", ["simctl", "io", udid, "screenshot", join(out, `${name}.png`)], { stdio: "ignore" });

function run(label, device, defines, onLine) {
  const args = ["test", "integration_test/handoff_test.dart", "-d", device, "--dart-define=DEV_SIGN_IN=true", "--dart-define=NO_PERMISSION_PROMPTS=true", ...defines.map((d) => `--dart-define=${d}`)];
  const p = spawn("flutter", args, { cwd });
  const log = createWriteStream(join(out, `${label}.log`));
  let buf = "";
  p.stdout.on("data", (d) => {
    log.write(d);
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      onLine(line);
      if (/All tests passed|Some tests failed/.test(line)) console.log(`[${label}] ${line}`);
    }
  });
  p.stderr.pipe(log);
  return new Promise((ok) => p.on("exit", (c) => ok(c ?? 1)));
}

// Start from a clean Mac app (no downloads, default window).
const data = join(process.env.HOME, "Library/Containers/com.hejitech.waypack/Data/Library");
for (const d of ["trips", "tiles"]) execFileSync("rm", ["-rf", join(data, "Application Support/com.hejitech.waypack", d)]);

let host = "", code = "", receiver = null;
const sender = run("sender", "macos", ["ROLE=send"], (line) => {
  let m;
  if ((m = line.match(/TICKET_HOST:(\S+)/))) host = m[1];
  if ((m = line.match(/TICKET_CODE:(\S+)/))) code = m[1];
  if ((m = line.match(/SHOT:([\w-]+)/))) setTimeout(() => { try { shotMac(m[1]); console.log("captured", m[1]); } catch { console.log("could not capture", m[1]); } }, 600);
  if (host && code && !receiver) {
    console.log(`sender ready at ${host} (code ${code}); starting the receiver`);
    receiver = run("receiver", udid, ["ROLE=receive", "TEST_EMAIL=companion@waypack.test", `TICKET_HOST=${host}`, `TICKET_CODE=${code}`], (l) => {
      const s = l.match(/SHOT:([\w-]+)/);
      if (s) setTimeout(() => { shotSim(s[1]); console.log("captured", s[1]); }, 600);
    });
  }
});
const [a, b] = [await sender, await (async () => { while (!receiver) await new Promise((r) => setTimeout(r, 1000)); return receiver; })()];
console.log(a === 0 && b === 0 ? "handoff e2e passed" : `handoff e2e failed (sender ${a}, receiver ${b}); see ${out}/*.log`);
process.exit(a === 0 && b === 0 ? 0 : 1);
