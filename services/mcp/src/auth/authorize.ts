import { AuthorizationError, CimdFetchError, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import type { Env, AuthProps } from "../env.js";
import { clearSessionCookie, makeSessionCookie, readSession } from "./session.js";
import { devSession, devSignInAllowed, isProvider, startOAuth } from "./oauth.js";
import { esc, page, providerButtons } from "../pages.js";

/**
 * OAuth 2.1 authorize endpoint (design §6.1). Identity: Sign in with Google or Apple
 * (Supabase Auth). A signed session cookie lets returning users approve with one tap.
 */
export async function handleAuthorize(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const secure = new URL(req.url).protocol === "https:";
  try {
    if (req.method === "GET") {
      const authReq = await oauth.parseAuthRequest(req);
      const details = await oauth.describeConsent(authReq);
      const consent = await oauth.beginConsent(authReq);
      const session = await readSession(env.SIGNING_SECRET, req);
      const html = session ? consentPage(details, consent.handle, session.email ?? "your account") : signInPage(env, details, consent.handle);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      consent.headers.set("X-Frame-Options", "DENY");
      return new Response(html, { headers: consent.headers });
    }

    const form = await req.formData();
    const handle = String(form.get("handle") ?? "");
    const step = String(form.get("step") ?? "");
    const details = parseDetails(String(form.get("details") ?? ""));

    if (step === "deny") {
      const denied = await oauth.denyConsent(req, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if (step === "switch") return html(signInPage(env, details, handle), { "Set-Cookie": clearSessionCookie() });

    if (step === "oauth") {
      const provider = form.get("provider");
      if (!isProvider(provider)) return html(errorPage("Unknown sign-in provider."), {}, 400);
      // Choosing a provider on this page (which names the client) is the approval; the grant
      // completes in /auth/callback once Google/Apple confirm who the user is.
      return startOAuth(env, req, { purpose: "mcp", provider, handle });
    }

    if (step === "approve") {
      const session = await readSession(env.SIGNING_SECRET, req);
      if (!session) return html(signInPage(env, details, handle, "Your session expired. Please sign in again."));
      return completeGrant(env, req, handle, session.uid, session.email);
    }

    if (step === "dev" && devSignInAllowed(env)) {
      const s = await devSession(env, String(form.get("email") ?? "").trim().toLowerCase());
      const h = new Headers({ "Set-Cookie": await makeSessionCookie(env.SIGNING_SECRET, s.userId, s.email, secure) });
      return completeGrant(env, req, handle, s.userId, s.email, h);
    }
    return html(errorPage("Unknown step."), {}, 400);
  } catch (error) {
    return authorizeError(error);
  }
}

/** Approves the pending consent `handle` for this user and redirects back to the client. */
export async function completeGrant(env: Env, req: Request, handle: string, userId: string, email: string | undefined, headers = new Headers()): Promise<Response> {
  try {
    const oauth = env.OAUTH_PROVIDER;
    const approved = await oauth.approveConsent(req, handle, { scope: ["mcp"] });
    const props: AuthProps = { userId, email, via: "oauth" };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId,
      metadata: { email },
      scope: approved.request.scope,
      props,
    });
    approved.headers.forEach((v, k) => headers.append(k, v));
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return authorizeError(error);
  }
}

function authorizeError(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
    return html(errorPage(`${message} Start the connection again from your AI agent.`), {}, 400);
  }
  throw error;
}

function html(body: string, headers: Record<string, string> = {}, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'", ...headers },
  });
}

// The consent facts are carried between steps in a hidden field purely for display;
// security decisions use the server-side request bound to `handle`.
type Shown = Pick<ConsentDescription, "clientName" | "clientDomain" | "redirectHost" | "redirectIsLoopback">;
function packDetails(d: Shown): string {
  return btoa(encodeURIComponent(JSON.stringify({ clientName: d.clientName, clientDomain: d.clientDomain, redirectHost: d.redirectHost, redirectIsLoopback: d.redirectIsLoopback })));
}
function parseDetails(s: string): Shown {
  try {
    return JSON.parse(decodeURIComponent(atob(s))) as Shown;
  } catch {
    return { clientName: "An app", clientDomain: undefined, redirectHost: "", redirectIsLoopback: false } as Shown;
  }
}

function clientBlurb(d: Shown): string {
  const origin = d.clientDomain ? `Published by <b>${esc(d.clientDomain)}</b>.` : "This app registered itself; its name isn't verified.";
  const loop = d.redirectIsLoopback
    ? `<p class="warn">Access will be sent to an app on this computer (<b>${esc(d.redirectHost)}</b>). Continue only if you just started connecting from your AI agent.</p>`
    : `<p class="muted">Access will be sent to <b>${esc(d.redirectHost)}</b>.</p>`;
  return `<p><b>${esc(d.clientName)}</b> wants to plan and publish trips to your Waypack account. ${origin}</p>${loop}`;
}

function hidden(handle: string, d: Shown) {
  return `<input type="hidden" name="handle" value="${esc(handle)}"><input type="hidden" name="details" value="${packDetails(d)}">`;
}

function signInPage(env: Env, d: Shown, handle: string, error?: string): string {
  const dev = devSignInAllowed(env)
    ? `<details class="dev"><summary>Dev sign-in (local only)</summary>
        <form method="post">${hidden(handle, d)}
          <input name="email" type="email" required placeholder="dev@waypack.test" value="dev@waypack.test">
          <button class="secondary" name="step" value="dev">Sign in as this user</button>
        </form></details>`
    : "";
  return page(
    "Connect your AI agent",
    `${clientBlurb(d)}
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <form method="post">${hidden(handle, d)}
      ${providerButtons("submit")}
    </form>
    <form method="post">${hidden(handle, d)}
      <button class="secondary" name="step" value="deny">Cancel</button>
    </form>
    <p class="muted small">Use the same account as the Waypack app so your trips show up there.</p>
    ${dev}`,
  );
}

function consentPage(d: ConsentDescription, handle: string, email: string): string {
  return page(
    "Connect your AI agent",
    `${clientBlurb(d)}
    <p>Signed in as <b>${esc(email)}</b>.</p>
    <form method="post">${hidden(handle, d)}
      <button name="step" value="approve">Allow</button>
      <button class="secondary" name="step" value="deny">Deny</button>
      <button class="link" name="step" value="switch">Use a different account</button>
    </form>`,
  );
}

export function errorPage(message: string): string {
  return page("Something went wrong", `<p class="error">${esc(message)}</p>`);
}
