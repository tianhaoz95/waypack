// Public Mac app downloads: DMGs are GitHub release assets (apps/mobile/tool/release_mac.sh).
import type { Env } from "../env.js";

/** Repo whose latest release carries `Waypack.dmg`; override with the MAC_RELEASES_REPO var. */
export const DEFAULT_MAC_RELEASES_REPO = "tianhaoz95/waypack";

/** /download/mac → the newest release's DMG on GitHub (a stable link for the site's buttons). */
export function handleMacDownload(_req: Request, env: Env, path: string): Response {
  if (path !== "/download/mac" && path !== "/download/mac/") return Response.json({ error: "not found" }, { status: 404 });
  const repo = env.MAC_RELEASES_REPO || DEFAULT_MAC_RELEASES_REPO;
  return new Response(null, {
    status: 302,
    headers: { Location: `https://github.com/${repo}/releases/latest/download/Waypack.dmg`, "Cache-Control": "no-store" },
  });
}
