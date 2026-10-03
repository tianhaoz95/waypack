/**
 * Stripe billing for the web portal (subscriptions are sold on the web; the apps are free viewers).
 * Uses Stripe's REST API directly (form-encoded) — no SDK needed in Workers.
 */
import type { Env } from "../env.js";
import { hex } from "./crypto.js";
import { Db, eq } from "./db.js";
import { ensureExtractsForUser } from "./pipeline.js";

export type Plan = "annual" | "lifetime";

export interface EntitlementPatch {
  tier: "free" | "annual" | "lifetime";
  active: boolean;
  expires_at: string | null;
  stripe_subscription_id?: string | null;
}

/** Flattens nested params into Stripe's bracket form encoding. */
export function formEncode(obj: Record<string, unknown>, prefix = ""): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === "object") out.push(formEncode(item as Record<string, unknown>, `${key}[${i}]`));
        else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === "object") {
      out.push(formEncode(v as Record<string, unknown>, key));
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out.filter(Boolean).join("&");
}

export class StripeError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function stripe<T = Record<string, unknown>>(env: Env, method: "GET" | "POST", path: string, params?: Record<string, unknown>, fetcher: typeof fetch = (i, n) => fetch(i, n)): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new StripeError("billing is not configured", 503);
  const body = params ? formEncode(params) : undefined;
  const url = `https://api.stripe.com/v1/${path}${method === "GET" && body ? `?${body}` : ""}`;
  const res = await fetcher(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2025-09-30.clover",
    },
    body: method === "POST" ? body : undefined,
  });
  const j = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new StripeError(j.error?.message ?? `Stripe error ${res.status}`, res.status);
  return j;
}

export const priceFor = (env: Env, plan: Plan): string | undefined => (plan === "annual" ? env.STRIPE_PRICE_ANNUAL : env.STRIPE_PRICE_LIFETIME) || undefined;

export function availablePlans(env: Env): Plan[] {
  return (["annual", "lifetime"] as Plan[]).filter((p) => !!priceFor(env, p));
}

interface EntRow { tier: string; stripe_customer_id: string | null }

/** Reuses the user's Stripe customer or creates one (stored on entitlements). */
export async function ensureCustomer(env: Env, db: Db, userId: string, email: string | undefined, fetcher?: typeof fetch): Promise<string> {
  const row = await db.one<EntRow>("entitlements", `select=tier,stripe_customer_id&user_id=${eq(userId)}`);
  if (row?.stripe_customer_id) return row.stripe_customer_id;
  const c = await stripe<{ id: string }>(env, "POST", "customers", { email, metadata: { user_id: userId } }, fetcher);
  await db.insert("entitlements", { user_id: userId, stripe_customer_id: c.id }, { upsert: true, onConflict: "user_id" });
  return c.id;
}

export async function createCheckout(env: Env, db: Db, user: { userId: string; email?: string }, plan: Plan, fetcher?: typeof fetch): Promise<string> {
  if (!env.STRIPE_SECRET_KEY) throw new StripeError("billing is not configured", 503);
  const price = priceFor(env, plan);
  if (!price) throw new StripeError(`the ${plan} plan isn't available`, 400);
  const current = await db.one<EntRow>("entitlements", `select=tier,stripe_customer_id&user_id=${eq(user.userId)}`);
  if (current?.tier === "lifetime") throw new StripeError("you already have lifetime access", 409);
  const customer = await ensureCustomer(env, db, user.userId, user.email, fetcher);
  const base = `${env.PUBLIC_URL}/account`;
  const session = await stripe<{ url: string }>(env, "POST", "checkout/sessions", {
    mode: plan === "annual" ? "subscription" : "payment",
    customer,
    client_reference_id: user.userId,
    line_items: [{ price, quantity: 1 }],
    success_url: `${base}?checkout=success`,
    cancel_url: `${base}?checkout=cancelled`,
    allow_promotion_codes: true,
    metadata: { user_id: user.userId, plan },
    ...(plan === "annual" ? { subscription_data: { metadata: { user_id: user.userId } } } : { payment_intent_data: { metadata: { user_id: user.userId, plan } } }),
  }, fetcher);
  return session.url;
}

export async function createPortal(env: Env, db: Db, user: { userId: string; email?: string }, fetcher?: typeof fetch): Promise<string> {
  const customer = await ensureCustomer(env, db, user.userId, user.email, fetcher);
  const s = await stripe<{ url: string }>(env, "POST", "billing_portal/sessions", { customer, return_url: `${env.PUBLIC_URL}/account` }, fetcher);
  return s.url;
}

// ---------- webhook ----------

/** Verifies the `Stripe-Signature` header (v1 HMAC-SHA256 over `${t}.${payload}`, 5-minute tolerance). */
export async function verifyStripeSignature(secret: string, payload: string, header: string | null, now = Date.now(), toleranceSec = 300): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v]));
  const t = Number(parts.t);
  const sigs = header.split(",").filter((p) => p.trim().startsWith("v1=")).map((p) => p.trim().slice(3));
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return sigs.some((s) => timingSafeEqual(s, expected));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export interface StripeEvent { id: string; type: string; data: { object: Record<string, unknown> } }

/** Maps a subscription object to an entitlement (pure; unit-tested). */
export function entitlementFromSubscription(sub: Record<string, unknown>): EntitlementPatch {
  const status = String(sub.status);
  // current_period_end moved onto subscription items in newer API versions.
  const items = (sub.items as { data?: { current_period_end?: number }[] } | undefined)?.data ?? [];
  const periodEnd = Number(sub.current_period_end ?? items[0]?.current_period_end ?? 0);
  const live = ["active", "trialing", "past_due"].includes(status); // past_due: Stripe is retrying; keep access
  return live
    ? { tier: "annual", active: true, expires_at: periodEnd ? new Date(periodEnd * 1000).toISOString() : null, stripe_subscription_id: String(sub.id) }
    : { tier: "free", active: true, expires_at: null, stripe_subscription_id: null };
}

/** Decides what an event means for the user's entitlement. Returns null to ignore. Lifetime always wins. */
export function planEvent(e: StripeEvent, currentTier: string): { userId?: string; customer?: string; patch: EntitlementPatch } | null {
  const o = e.data.object;
  const userId = ((o.metadata as Record<string, string> | undefined)?.user_id ?? (o.client_reference_id as string | undefined)) || undefined;
  const customer = typeof o.customer === "string" ? o.customer : undefined;
  switch (e.type) {
    case "checkout.session.completed": {
      if (o.mode === "payment" && o.payment_status === "paid") return { userId, customer, patch: { tier: "lifetime", active: true, expires_at: null } };
      return null; // subscriptions are handled by customer.subscription.* events
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      if (currentTier === "lifetime") return null;
      const patch = e.type === "customer.subscription.deleted" ? { tier: "free" as const, active: true, expires_at: null, stripe_subscription_id: null } : entitlementFromSubscription(o);
      return { userId, customer, patch };
    }
    case "charge.refunded": {
      // A refunded lifetime purchase revokes it.
      const meta = (o.metadata as Record<string, string> | undefined) ?? {};
      if (meta.plan === "lifetime" && o.refunded === true) return { userId: meta.user_id, customer, patch: { tier: "free", active: true, expires_at: null } };
      return null;
    }
    default:
      return null;
  }
}

export async function handleStripeWebhook(env: Env, req: Request): Promise<Response> {
  const payload = await req.text();
  if (!(await verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET ?? "", payload, req.headers.get("Stripe-Signature")))) {
    return new Response("invalid signature", { status: 400 });
  }
  const e = JSON.parse(payload) as StripeEvent;
  const db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  // Idempotency: Stripe retries; process each event id once.
  const inserted = await db.insert("billing_events", { id: e.id, type: e.type, payload: e }, { upsert: false }).catch((err: { status?: number }) => {
    if (err.status === 409) return [] as unknown[];
    throw err;
  });
  if (!inserted.length) return Response.json({ ok: true, duplicate: true });

  const o = e.data.object;
  const customer = typeof o.customer === "string" ? o.customer : undefined;
  let userId = ((o.metadata as Record<string, string> | undefined)?.user_id ?? (o.client_reference_id as string | undefined)) || undefined;
  if (!userId && customer) {
    userId = (await db.one<{ user_id: string }>("entitlements", `select=user_id&stripe_customer_id=${eq(customer)}`))?.user_id;
  }
  if (!userId) return Response.json({ ok: true, ignored: "no user" });
  const cur = await db.one<{ tier: string }>("entitlements", `select=tier&user_id=${eq(userId)}`);
  const plan = planEvent(e, cur?.tier ?? "free");
  if (!plan) return Response.json({ ok: true, ignored: e.type });
  await db.update("billing_events", `id=${eq(e.id)}`, { user_id: userId });
  await db.insert(
    "entitlements",
    { user_id: userId, ...plan.patch, ...(customer ? { stripe_customer_id: customer } : {}), source: "stripe", updated_at: new Date().toISOString() },
    { upsert: true, onConflict: "user_id" },
  );
  // Newly entitled: cut offline maps for trips published while on the free plan.
  if (plan.patch.tier !== "free" && cur?.tier === "free") await ensureExtractsForUser(env, db, userId);
  return Response.json({ ok: true, tier: plan.patch.tier });
}
