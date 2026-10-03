// Pure entitlement logic for RevenueCat webhooks (no Deno/Node APIs → unit-testable).
export type Tier = "free" | "annual" | "lifetime";
export interface Entitlement { tier: Tier; active: boolean; expires_at: string | null }

export interface RcEvent {
  id: string;
  type: string;
  app_user_id: string;
  original_app_user_id?: string;
  aliases?: string[];
  product_id?: string;
  entitlement_ids?: string[] | null;
  expiration_at_ms?: number | null;
  transferred_from?: string[];
  transferred_to?: string[];
  environment?: "SANDBOX" | "PRODUCTION";
}

export const ENTITLEMENT_ID = "pro";
const isLifetime = (productId?: string) => !!productId && /lifetime/i.test(productId);
const iso = (ms?: number | null) => (ms ? new Date(ms).toISOString() : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RevenueCat app_user_id is the Supabase user id (the app calls Purchases.logIn(userId)). */
export function userIdOf(e: RcEvent): string | null {
  for (const id of [e.app_user_id, e.original_app_user_id, ...(e.aliases ?? [])]) if (id && UUID.test(id)) return id;
  return null;
}

/**
 * Next entitlement given the current one and an event. Returns null when the event
 * doesn't change anything. Lifetime is never downgraded by subscription events.
 */
export function applyEvent(cur: Entitlement, e: RcEvent, now = Date.now()): Entitlement | null {
  if (e.entitlement_ids && !e.entitlement_ids.includes(ENTITLEMENT_ID) && e.type !== "EXPIRATION") return null;
  switch (e.type) {
    case "INITIAL_PURCHASE":
    case "RENEWAL":
    case "PRODUCT_CHANGE":
    case "UNCANCELLATION":
    case "NON_RENEWING_PURCHASE":
    case "SUBSCRIPTION_EXTENDED":
    case "TEMPORARY_ENTITLEMENT_GRANT":
      if (isLifetime(e.product_id)) return { tier: "lifetime", active: true, expires_at: null };
      if (cur.tier === "lifetime" && cur.active) return null;
      return { tier: "annual", active: (e.expiration_at_ms ?? Infinity) > now, expires_at: iso(e.expiration_at_ms) };
    case "CANCELLATION":
    case "BILLING_ISSUE":
      // Access continues until expiration; just keep the date in sync.
      if (cur.tier !== "annual") return null;
      return { ...cur, expires_at: iso(e.expiration_at_ms) ?? cur.expires_at };
    case "EXPIRATION":
      if (cur.tier === "lifetime") return null;
      return { tier: "free", active: true, expires_at: null };
    default:
      return null; // TEST, SUBSCRIBER_ALIAS, TRANSFER (handled separately), …
  }
}

/** Derives the entitlement from RevenueCat's subscriber object (authoritative when an API key is configured). */
export function fromSubscriber(sub: { entitlements?: Record<string, { expires_date: string | null; product_identifier: string }> }, now = Date.now()): Entitlement {
  const pro = sub.entitlements?.[ENTITLEMENT_ID];
  if (!pro) return { tier: "free", active: true, expires_at: null };
  if (isLifetime(pro.product_identifier) || pro.expires_date === null) return { tier: "lifetime", active: true, expires_at: null };
  const exp = Date.parse(pro.expires_date);
  return exp > now ? { tier: "annual", active: true, expires_at: new Date(exp).toISOString() } : { tier: "free", active: true, expires_at: null };
}
