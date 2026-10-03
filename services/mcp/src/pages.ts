export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${esc(title)} · Waypack</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#0f172a;--muted:#5b6577;--line:#dde2ea;--accent:#1d6fe0;--ink:#fff;--err:#c81e1e;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#141c2f;--text:#e8edf6;--muted:#9aa6bb;--line:#26314a;--accent:#5b9bff;--ink:#06122a;--err:#f87171;--warn:#fbbf24}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:16px}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;margin-bottom:16px}.brand span{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--accent);color:var(--ink)}
h1{font-size:1.3rem;margin:0 0 12px}label{display:block;font-weight:600;margin:12px 0 6px}
input{width:100%;min-height:48px;font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text)}
button{display:block;width:100%;min-height:48px;margin-top:10px;border:0;border-radius:10px;background:var(--accent);color:var(--ink);font:600 1rem inherit;cursor:pointer}
button.secondary{background:transparent;color:var(--text);border:1px solid var(--line)}button.link{background:none;color:var(--accent);min-height:40px}
.muted{color:var(--muted)}.small{font-size:.875rem}.error{color:var(--err);font-weight:600}.warn{color:var(--warn)}
code{background:var(--bg);padding:2px 6px;border-radius:6px}

</style></head><body><main><div class="brand"><span>◈</span>Waypack</div><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

export function homePage(publicUrl: string): string {
  return page(
    "Waypack MCP server",
    `<p>Connect this server to your AI agent to plan trips that work offline in the Waypack app.</p>
     <p><b>MCP URL</b><br><code>${esc(publicUrl)}/mcp</code></p>
     <p class="muted small">Claude Code: <code>claude mcp add --transport http waypack ${esc(publicUrl)}/mcp</code></p>`,
  );
}
