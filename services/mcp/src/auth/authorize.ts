import { AuthorizationError, CimdFetchError, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import type { Env, AuthProps } from "../env.js";
import { clearSessionCookie, makeSessionCookie, readSession } from "./session.js";
import { sendOtp, verifyOtp } from "./supabase.js";
import { esc, page } from "../pages.js";

/**
 * OAuth 2.1 authorize endpoint (design §6.1). Identity comes from Supabase Auth via
 * an emailed 6-digit code, verified server-side; a signed session cookie lets
 * returning users approve with one tap.
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
      const html = session ? consentPage(details, consent.handle, session.email ?? "your account") : emailPage(details, consent.handle);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
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
    if (step === "switch") {
      return html(emailPage(details, handle), { "Set-Cookie": clearSessionCookie() });
    }
    if (step === "send_code") {
      const email = String(form.get("email") ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return html(emailPage(details, handle, "Enter a valid email address."));
      try {
        await sendOtp(env, email);
      } catch (e) {
        return html(emailPage(details, handle, `Couldn't send the code: ${(e as Error).message}`));
      }
      return html(codePage(details, handle, email));
    }

    let userId: string;
    let email: string | undefined;
    const headers = new Headers();
    if (step === "verify") {
      email = String(form.get("email") ?? "");
      const code = String(form.get("code") ?? "").replace(/\s+/g, "");
      try {
        const u = await verifyOtp(env, email, code);
        userId = u.id;
        email = u.email ?? email;
      } catch (e) {
        return html(codePage(details, handle, email, `That code didn't work (${(e as Error).message}). Check the latest email and try again.`));
      }
      headers.append("Set-Cookie", await makeSessionCookie(env.SIGNING_SECRET, userId, email, secure));
    } else if (step === "approve") {
      const session = await readSession(env.SIGNING_SECRET, req);
      if (!session) return html(emailPage(details, handle, "Your session expired — sign in again."));
      userId = session.uid;
      email = session.email;
    } else {
      return html(errorPage("Unknown step."), {}, 400);
    }

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
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
      return html(errorPage(`${message} Start the connection again from your AI agent.`), {}, 400);
    }
    throw error;
  }
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

function emailPage(d: Shown, handle: string, error?: string): string {
  return page(
    "Connect your AI agent",
    `${clientBlurb(d)}
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <form method="post">
      <input type="hidden" name="handle" value="${esc(handle)}">
      <input type="hidden" name="details" value="${packDetails(d)}">
      <label for="email">Sign in with your Waypack email</label>
      <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required autofocus placeholder="you@example.com">
      <button name="step" value="send_code">Email me a code</button>
      <button class="secondary" name="step" value="deny" formnovalidate>Cancel</button>
    </form>
    <p class="muted small">Use the same email as the Waypack app so your trips show up there.</p>`,
  );
}

function codePage(d: Shown, handle: string, email: string, error?: string): string {
  return page(
    "Enter your code",
    `<p>We sent a 6-digit code to <b>${esc(email)}</b>.</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <form method="post">
      <input type="hidden" name="handle" value="${esc(handle)}">
      <input type="hidden" name="details" value="${packDetails(d)}">
      <input type="hidden" name="email" value="${esc(email)}">
      <label for="code">Code</label>
      <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,8}" required autofocus placeholder="123456">
      <button name="step" value="verify">Allow ${esc(d.clientName)}</button>
      <button class="secondary" name="step" value="deny" formnovalidate>Deny</button>
    </form>
    ${clientBlurb(d)}`,
  );
}

function consentPage(d: ConsentDescription, handle: string, email: string): string {
  return page(
    "Connect your AI agent",
    `${clientBlurb(d)}
    <p>Signed in as <b>${esc(email)}</b>.</p>
    <form method="post">
      <input type="hidden" name="handle" value="${esc(handle)}">
      <input type="hidden" name="details" value="${packDetails(d)}">
      <button name="step" value="approve">Allow</button>
      <button class="secondary" name="step" value="deny">Deny</button>
      <button class="link" name="step" value="switch">Use a different email</button>
    </form>`,
  );
}

function errorPage(message: string): string {
  return page("Something went wrong", `<p class="error">${esc(message)}</p>`);
}
