// Public Mac app downloads, written to R2 by apps/mobile/tool/release_mac.sh.
import type { Env } from "../env.js";
import { serveR2 } from "./storage.js";

/** R2 layout written by the release script: releases/mac/latest.json + releases/mac/Waypack-<version>.dmg. */
export const MAC_RELEASES = "releases/mac/";

export async function handleMacDownload(req: Request, env: Env, path: string): Promise<Response> {
  if (path === "/download/mac" || path === "/download/mac/") {
    const latest = await env.BUCKET.get(`${MAC_RELEASES}latest.json`);
    if (!latest) return new Response("The Mac app isn't available yet. Check back soon.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const { file } = (await latest.json()) as { file: string };
    // Versioned URL, so the browser saves "Waypack-1.2.0.dmg" and caches can't serve a stale build.
    return new Response(null, { status: 302, headers: { Location: `/download/mac/${encodeURIComponent(file)}`, "Cache-Control": "no-store" } });
  }
  if (path === "/download/mac/latest.json") return serveR2(env, `${MAC_RELEASES}latest.json`, req, { "Cache-Control": "no-cache" });
  const m = path.match(/^\/download\/mac\/(Waypack-[0-9][0-9A-Za-z.+-]{0,40}\.dmg)$/);
  if (!m) return Response.json({ error: "not found" }, { status: 404 });
  return serveR2(env, MAC_RELEASES + m[1], req, {
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Disposition": `attachment; filename="${m[1]}"`,
  });
}

