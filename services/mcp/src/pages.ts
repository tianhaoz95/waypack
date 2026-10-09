export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const GOOGLE_G = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;
const APPLE = `<svg width="16" height="18" viewBox="0 0 384 470" aria-hidden="true"><path fill="currentColor" d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/></svg>`;

/** "Continue with Google / Apple" buttons. `as: "submit"` posts provider=…; `as: "link"` links to /auth/start. */
export function providerButtons(mode: string, returnTo = "/account"): string {
  if (mode === "link") {
    const q = (p: string) => `/auth/start?provider=${p}&return=${encodeURIComponent(returnTo)}`;
    return `<a class="provider google" href="${q("google")}">${GOOGLE_G}<span>Continue with Google</span></a>
      <a class="provider apple" href="${q("apple")}">${APPLE}<span>Continue with Apple</span></a>`;
  }
  return `<input type="hidden" name="step" value="oauth">
      <button class="provider google" name="provider" value="google">${GOOGLE_G}<span>Continue with Google</span></button>
      <button class="provider apple" name="provider" value="apple">${APPLE}<span>Continue with Apple</span></button>`;
}

export const PROVIDER_CSS = `.provider{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:50px;margin-top:10px;border-radius:999px;box-shadow:none;font:600 1rem -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-decoration:none;cursor:pointer}
.provider.google{background:#fff;color:#1f1f1f;border:1px solid #747775}
.provider.apple{background:#000;color:#fff;border:1px solid #000}
@media (prefers-color-scheme:dark){.provider.apple{background:#fff;color:#000;border-color:#fff}}`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${esc(title)} · Waypack</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.png" type="image/png" sizes="32x32"><link rel="icon" href="/favicon.ico" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
@font-face{font-family:"Caveat";src:url("/fonts/caveat.woff2") format("woff2");font-weight:400 700;font-display:swap}
:root{--bg:#f3eadb;--card:#fffdf8;--text:#3d332b;--muted:#75685c;--line:#e3d6c3;--accent:#b4523a;--ink:#fff;--err:#b8402a;--warn:#a86d0c;--dots:rgba(120,90,60,.16);--hand:"Caveat","Bradley Hand",cursive}
@media (prefers-color-scheme:dark){:root{--bg:#231d18;--card:#2f2722;--text:#efe4d6;--muted:#ab9b8b;--line:#3f352d;--accent:#e88468;--ink:#2b1408;--err:#f08a70;--warn:#e6b04a;--dots:rgba(255,230,200,.06)}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg) radial-gradient(var(--dots) 1px,transparent 1.4px) 0 0/14px 14px;color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:16px}
main{width:100%;max-width:420px;background:var(--card);border-radius:8px;padding:24px;box-shadow:0 1px 2px rgba(60,40,20,.14),0 14px 28px -18px rgba(60,40,20,.55)}
.brand{display:flex;align-items:center;gap:10px;font:700 1.7rem/1 var(--hand);margin-bottom:14px}.brand img{display:block;width:30px;height:30px}
h1{font:700 2.1rem/1.1 var(--hand);margin:0 0 12px}label{display:block;font-weight:600;margin:12px 0 6px}
input{width:100%;min-height:48px;font:inherit;padding:10px 12px;border-radius:8px;border:1.5px solid var(--line);background:var(--card);color:var(--text)}input:focus{outline:none;border-color:var(--accent)}
button{display:block;width:100%;min-height:48px;margin-top:10px;border:0;border-radius:999px;background:var(--accent);color:var(--ink);font-family:inherit;font-size:1rem;font-weight:700;cursor:pointer;box-shadow:0 2px 0 color-mix(in srgb,var(--accent) 60%,#000)}
button.secondary{background:var(--card);color:var(--text);border:1px solid var(--line);box-shadow:0 1px 2px rgba(60,40,20,.12)}button.link{background:none;color:var(--accent);min-height:40px;box-shadow:none}
.muted{color:var(--muted)}.small{font-size:.875rem}.error{color:var(--err);font-weight:600}.warn{color:var(--warn)}
code{background:var(--bg);padding:2px 6px;border-radius:6px}
details.dev{margin-top:20px;border-top:1px dashed var(--line);padding-top:10px}details.dev summary{cursor:pointer;color:var(--muted);font-size:.875rem}
${PROVIDER_CSS}
</style></head><body><main><div class="brand"><img src="/img/logo.svg" alt="" width="28" height="28">Waypack</div><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

export function homePage(publicUrl: string): string {
  return page(
    "Waypack MCP server",
    `<p>Connect this server to your AI agent to plan trips that work offline in the Waypack app.</p>
     <p><b>MCP URL</b><br><code>${esc(publicUrl)}/mcp</code></p>
     <p class="muted small">Claude Code: <code>claude mcp add --transport http waypack ${esc(publicUrl)}/mcp</code></p>`,
  );
}
