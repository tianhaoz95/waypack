import { describe, expect, it } from "vitest";
import { createCheckout, createPortal, entitlementFromSubscription, formEncode, planEvent, verifyStripeSignature, type StripeEvent } from "../src/lib/stripe.js";
import { hex } from "../src/lib/crypto.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/lib/db.js";

async function sign(secret: string, payload: string, t: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `t=${t},v1=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)))}`;
}

describe("stripe signature", () => {
  const now = 1_790_000_000_000;
  const t = Math.floor(now / 1000);
  it("accepts a valid signature", async () => {
    expect(await verifyStripeSignature("whsec_x", '{"a":1}', await sign("whsec_x", '{"a":1}', t), now)).toBe(true);
  });
  it("rejects wrong secret, tampered payload, stale timestamp, missing header", async () => {
    const h = await sign("whsec_x", '{"a":1}', t);
    expect(await verifyStripeSignature("whsec_y", '{"a":1}', h, now)).toBe(false);
    expect(await verifyStripeSignature("whsec_x", '{"a":2}', h, now)).toBe(false);
    expect(await verifyStripeSignature("whsec_x", '{"a":1}', h, now + 400_000)).toBe(false);
    expect(await verifyStripeSignature("whsec_x", '{"a":1}', null, now)).toBe(false);
  });
});

describe("stripe mapping", () => {
  const sub = (status: string) => ({ id: "sub_1", status, customer: "cus_1", metadata: { user_id: "u1", app: "waypack" }, items: { data: [{ current_period_end: 1_800_000_000 }] } });
  const W = { app: "waypack" };
  const ev = (type: string, object: Record<string, unknown>): StripeEvent => ({ id: "evt_1", type, data: { object } });

  it("form-encodes nested params", () => {
    expect(decodeURIComponent(formEncode({ mode: "subscription", line_items: [{ price: "price_1", quantity: 1 }], metadata: { user_id: "u" } })))
      .toBe("mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=1&metadata[user_id]=u");
  });
  it("active/past_due subscriptions grant annual; canceled revokes", () => {
    expect(entitlementFromSubscription(sub("active"))).toMatchObject({ tier: "annual", expires_at: "2027-01-15T08:00:00.000Z" });
    expect(entitlementFromSubscription(sub("past_due")).tier).toBe("annual");
    expect(entitlementFromSubscription(sub("canceled")).tier).toBe("free");
  });
  it("plans events, never downgrading lifetime", () => {
    expect(planEvent(ev("customer.subscription.updated", sub("active")), "free")?.patch.tier).toBe("annual");
    expect(planEvent(ev("customer.subscription.deleted", sub("canceled")), "annual")?.patch.tier).toBe("free");
    expect(planEvent(ev("customer.subscription.deleted", sub("canceled")), "lifetime")).toBeNull();
    expect(planEvent(ev("checkout.session.completed", { mode: "payment", payment_status: "paid", client_reference_id: "u1", metadata: W }), "annual")).toMatchObject({ userId: "u1", patch: { tier: "lifetime" } });
    expect(planEvent(ev("checkout.session.completed", { mode: "subscription", metadata: W }), "free")).toBeNull();
    expect(planEvent(ev("charge.refunded", { refunded: true, metadata: { plan: "lifetime", user_id: "u1", ...W } }), "lifetime")?.patch.tier).toBe("free");
    expect(planEvent(ev("invoice.paid", { metadata: W }), "free")).toBeNull();
  });
  it("a 100%-off code (no_payment_required) still grants lifetime", () => {
    const o = { mode: "payment", payment_status: "no_payment_required", client_reference_id: "u1", metadata: W };
    expect(planEvent(ev("checkout.session.completed", o), "free")?.patch.tier).toBe("lifetime");
    expect(planEvent(ev("checkout.session.completed", { ...o, payment_status: "unpaid" }), "free")).toBeNull();
  });
  it("ignores other products on the shared Stripe account", () => {
    const other = { ...sub("active"), metadata: { user_id: "u1" } };
    expect(planEvent(ev("customer.subscription.created", other), "free")).toBeNull();
    expect(planEvent(ev("checkout.session.completed", { mode: "payment", payment_status: "paid", client_reference_id: "u1" }), "free")).toBeNull();
    expect(planEvent(ev("charge.refunded", { refunded: true, metadata: { plan: "lifetime", user_id: "u1", app: "feedbackkit" } }), "lifetime")).toBeNull();
  });
});

describe("checkout", () => {
  it("creates a customer once and a subscription session with the user id", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return Response.json(url.endsWith("/customers") ? { id: "cus_new" } : { url: "https://checkout.stripe.com/c/pay/x" });
    }) as unknown as typeof fetch;
    const store: Record<string, unknown> = {};
    const db = {
      one: async () => (store.cus ? { tier: "free", stripe_customer_id: store.cus } : { tier: "free", stripe_customer_id: null }),
      insert: async (_t: string, row: { stripe_customer_id: string }) => { store.cus = row.stripe_customer_id; return [row]; },
    } as unknown as Db;
    const env = { STRIPE_SECRET_KEY: "sk_test", STRIPE_PRICE_ANNUAL: "price_annual", PUBLIC_URL: "https://waypack.app" } as Env;
    const url = await createCheckout(env, db, { userId: "u1", email: "a@b.c" }, "annual", fetcher);
    expect(url).toContain("checkout.stripe.com");
    const body = decodeURIComponent(calls[1].body);
    expect(body).toContain("mode=subscription");
    expect(body).toContain("customer=cus_new");
    expect(body).toContain("client_reference_id=u1");
    expect(body).toContain("line_items[0][price]=price_annual");
    expect(body).toContain("subscription_data[metadata][user_id]=u1");
    expect(body).toContain("subscription_data[metadata][app]=waypack");
    expect(body).toContain("metadata[app]=waypack");
    expect(body).toContain("allow_promotion_codes=true");
    expect(decodeURIComponent(calls[0].body)).toContain("metadata[app]=waypack");
    expect(body).toContain("success_url=https://waypack.app/account?checkout=success");
    await createCheckout(env, db, { userId: "u1" }, "annual", fetcher);
    expect(calls.filter((c) => c.url.endsWith("/customers")).length).toBe(1);
    await expect(createCheckout(env, db, { userId: "u1" }, "lifetime", fetcher)).rejects.toThrow(/isn't available/);
  });
});

describe("portal", () => {
  it("uses Waypack's own portal configuration when set", async () => {
    const bodies: string[] = [];
    const fetcher = (async (_u: string, init: RequestInit) => {
      bodies.push(decodeURIComponent(String(init.body)));
      return Response.json({ url: "https://billing.stripe.com/p/session/x" });
    }) as unknown as typeof fetch;
    const db = { one: async () => ({ tier: "annual", stripe_customer_id: "cus_1" }) } as unknown as Db;
    const env = { STRIPE_SECRET_KEY: "sk_test", PUBLIC_URL: "https://waypack.app", STRIPE_PORTAL_CONFIG: "bpc_waypack" } as Env;
    await createPortal(env, db, { userId: "u1" }, fetcher);
    expect(bodies[0]).toContain("configuration=bpc_waypack");
    expect(bodies[0]).toContain("return_url=https://waypack.app/account");
    await createPortal({ ...env, STRIPE_PORTAL_CONFIG: undefined }, db, { userId: "u1" }, fetcher);
    expect(bodies[1]).not.toContain("configuration=");
  });
});
