#!/usr/bin/env node
import { parseArgs } from "node:util";
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatResult, validateFiles, validateZip, zipBundle, type ValidationResult } from "@waypack/bundle-schema";
import { isDir, readBundleDir } from "./files.js";
import { startPreview } from "./preview.js";
import { DEFAULT_SECTIONS, takeScreenshots } from "./screenshot.js";

const HELP = `waypack — build offline trip bundles

Usage:
  waypack validate <dir|bundle.zip> [--json]   Check a bundle against the v1 contract
  waypack zip <dir> [-o bundle.zip]             Validate and zip a bundle for upload
  waypack preview <dir> [--port 4173] [--tiles extract.pmtiles] [--no-online] [--host 127.0.0.1]
                                                Serve the bundle like the app does (CSP, SDK, tiles)
  waypack screenshot <dir> [--sections today,plan,places,guide] [--manifest]
                                                Phone screenshots for the portal listing (into <dir>/listing/);
                                                --manifest records them in manifest.listing.screenshots
  waypack init <dir> [--title "My Trip"]        Start a bundle from the base template
  waypack skill install [--dir ~/.claude/skills] Install the Waypack Agent Skill (SKILL.md + references + template)

Docs: https://waypack.app/docs  ·  Schema: packages/bundle-schema/manifest.v1.schema.json`;

function validatePath(p: string): ValidationResult & { files?: { path: string; data: Uint8Array }[] } {
  if (isDir(p)) {
    const { files, symlinks } = readBundleDir(p);
    const r = validateFiles(files);
    for (const s of symlinks) r.errors.push({ path: s, message: "symlinks are not allowed" });
    r.ok = r.errors.length === 0;
    return { ...r, files };
  }
  if (!existsSync(p)) throw new Error(`${p} not found`);
  return validateZip(new Uint8Array(readFileSync(p)));
}

function skillDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, "../skill"), join(here, "../../../skill")]) if (existsSync(join(c, "SKILL.md"))) return c;
  throw new Error("skill files not found");
}

const templateDir = () => join(skillDir(), "templates/base");

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") { console.log(HELP); return 0; }
  if (cmd === "-v" || cmd === "--version") {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"));
    console.log(pkg.version);
    return 0;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      out: { type: "string", short: "o" },
      port: { type: "string", default: "4173" },
      host: { type: "string", default: "127.0.0.1" },
      tiles: { type: "string" },
      "no-online": { type: "boolean" },
      online: { type: "string" },
      title: { type: "string" },
      dir: { type: "string" },
      force: { type: "boolean" },
      sections: { type: "string" },
      manifest: { type: "boolean" },
      wait: { type: "string" },
    },
  });
  const target = positionals[0];

  switch (cmd) {
    case "validate": {
      if (!target) throw new Error("usage: waypack validate <dir|bundle.zip>");
      const r = validatePath(target);
      delete r.files;
      if (values.json) console.log(JSON.stringify({ ok: r.ok, errors: r.errors, warnings: r.warnings, stats: r.stats }, null, 2));
      else console.log(formatResult(r));
      return r.ok ? 0 : 1;
    }
    case "zip": {
      if (!target || !isDir(target)) throw new Error("usage: waypack zip <dir> [-o bundle.zip]");
      const r = validatePath(target);
      console.log(formatResult(r));
      if (!r.ok) return 1;
      const out = values.out ?? `${basename(resolve(target))}.zip`;
      const zip = zipBundle(r.files!);
      writeFileSync(out, zip);
      const check = validateZip(zip);
      if (!check.ok) { console.error(formatResult(check)); return 1; }
      console.log(`wrote ${out} (${(zip.byteLength / 1024).toFixed(0)} KB, ${zip.byteLength} bytes)`);
      return 0;
    }
    case "preview": {
      if (!target || !isDir(target)) throw new Error("usage: waypack preview <dir>");
      const p = await startPreview({
        dir: target,
        port: Number(values.port),
        host: values.host!,
        tiles: values.tiles,
        online: values["no-online"] ? false : values.online,
      });
      console.log(`Previewing ${target}\n  → ${p.url}\nOpen on your phone (same Wi-Fi) with --host 0.0.0.0. Ctrl+C to stop.`);
      await new Promise(() => undefined);
      return 0;
    }
    case "screenshot": {
      if (!target || !isDir(target)) throw new Error("usage: waypack screenshot <dir> [--sections today,plan,places,guide] [--manifest]");
      const sections = values.sections ? values.sections.split(",").map((x) => x.trim()).filter(Boolean) : DEFAULT_SECTIONS;
      console.log(`Capturing ${sections.join(", ")} at 390×844…`);
      await takeScreenshots({ dir: target, sections, manifest: values.manifest, wait: values.wait ? Number(values.wait) : undefined });
      if (!values.manifest) console.log("Add them to manifest.listing.screenshots (or rerun with --manifest).");
      return 0;
    }
    case "init": {
      if (!target) throw new Error("usage: waypack init <dir>");
      if (existsSync(target) && !values.force && readBundleDir(target).files.length) throw new Error(`${target} is not empty (use --force)`);
      mkdirSync(target, { recursive: true });
      cpSync(templateDir(), target, { recursive: true });
      if (values.title) {
        const mp = join(target, "manifest.json");
        const m = JSON.parse(readFileSync(mp, "utf8"));
        m.title = values.title;
        writeFileSync(mp, JSON.stringify(m, null, 2) + "\n");
      }
      console.log(`Created ${target} from the base template. Next: edit manifest.json, then \`waypack preview ${target}\`.`);
      return 0;
    }
    case "skill": {
      if (target !== "install") throw new Error("usage: waypack skill install [--dir ~/.claude/skills]");
      const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
      const base = (values.dir ?? join(home, ".claude/skills")).replace(/^~(?=$|\/)/, home);
      const dest = join(base, "waypack");
      mkdirSync(dest, { recursive: true });
      cpSync(skillDir(), dest, { recursive: true });
      console.log(`Installed the Waypack skill to ${dest}\nRestart your agent, then ask it to "plan a trip with Waypack".`);
      return 0;
    }
    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => { if (code !== 0) process.exitCode = code; },
  (e) => { console.error(`error: ${(e as Error).message}`); process.exitCode = 2; },
);
