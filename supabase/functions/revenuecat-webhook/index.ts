// Supabase Edge Function: RevenueCat → entitlements (design §11).
// Configure in RevenueCat: Webhook URL = <SUPABASE_URL>/functions/v1/revenuecat-webhook,
// Authorization header = "Bearer <REVENUECAT_WEBHOOK_SECRET>".
// Secrets: REVENUECAT_WEBHOOK_SECRET, optional REVENUECAT_API_KEY (v1 secret key) for authoritative refresh.
import { applyEvent, fromSubscriber, userIdOf, type Entitlement, type RcEvent } from "./logic.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("REVENUECAT_WEBHOOK_SECRET") ?? "";
const RC_KEY = Deno.env.get("REVENUECAT_API_KEY") ?? "";

const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

async function current(userId: string): Promise<Entitlement> {
  const r = await rest(`entitlements?select=tier,active,expires_at&user_id=eq.${userId}`);
  const rows = (await r.json()) as Entitlement[];
  return rows[0] ?? { tier: "free", active: true, expires_at: null };
}

async function save(userId: string, e: Entitlement) {
  const r = await rest("entitlements?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ user_id: userId, ...e, source: "revenuecat", updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`save entitlement: ${r.status} ${await r.text()}`);
}

async function refreshFromRevenueCat(userId: string): Promise<Entitlement | null> {
  if (!RC_KEY) return null;
  const r = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`, { headers: { Authorization: `Bearer ${RC_KEY}` } });
  if (!r.ok) return null;
  const j = (await r.json()) as { subscriber: Parameters<typeof fromSubscriber>[0] };
  return fromSubscriber(j.subscriber);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  if (!SECRET || req.headers.get("Authorization") !== `Bearer ${SECRET}`) return new Response("unauthorized", { status: 401 });
  const body = (await req.json()) as { event: RcEvent };
  const e = body.event;
  if (!e?.id) return new Response("bad payload", { status: 400 });

  // Idempotency: RevenueCat retries; each event id is processed once.
  const ins = await rest("billing_events", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ id: e.id, user_id: userIdOf(e), type: e.type, payload: body }),
  });
  const inserted = (await ins.json()) as unknown[];
  if (Array.isArray(inserted) && inserted.length === 0) return Response.json({ ok: true, duplicate: true });

  const users = e.type === "TRANSFER" ? [...(e.transferred_from ?? []), ...(e.transferred_to ?? [])] : [userIdOf(e)];
  for (const userId of users) {
    if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) continue;
    const next = (await refreshFromRevenueCat(userId)) ?? applyEvent(await current(userId), e);
    if (next) await save(userId, next);
  }
  return Response.json({ ok: true });
});
