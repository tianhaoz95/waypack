import { describe, expect, it } from "vitest";
import { applyEvent, fromSubscriber, userIdOf, type Entitlement } from "./logic";

const free: Entitlement = { tier: "free", active: true, expires_at: null };
const uid = "11111111-2222-3333-4444-555555555555";
const ev = (type: string, extra = {}) => ({ id: "e1", type, app_user_id: uid, entitlement_ids: ["pro"], ...extra });
const NOW = Date.parse("2026-10-03T00:00:00Z");
const nextYear = Date.parse("2027-10-03T00:00:00Z");

describe("revenuecat logic", () => {
  it("annual purchase → annual with expiry", () => {
    expect(applyEvent(free, ev("INITIAL_PURCHASE", { product_id: "waypack_annual", expiration_at_ms: nextYear }), NOW))
      .toEqual({ tier: "annual", active: true, expires_at: "2027-10-03T00:00:00.000Z" });
  });
  it("lifetime purchase → lifetime and never downgraded", () => {
    const life = applyEvent(free, ev("NON_RENEWING_PURCHASE", { product_id: "waypack_lifetime" }), NOW)!;
    expect(life).toEqual({ tier: "lifetime", active: true, expires_at: null });
    expect(applyEvent(life, ev("EXPIRATION"), NOW)).toBeNull();
    expect(applyEvent(life, ev("RENEWAL", { product_id: "waypack_annual", expiration_at_ms: nextYear }), NOW)).toBeNull();
  });
  it("cancellation keeps access; expiration revokes", () => {
    const annual: Entitlement = { tier: "annual", active: true, expires_at: "2027-10-03T00:00:00.000Z" };
    expect(applyEvent(annual, ev("CANCELLATION", { expiration_at_ms: nextYear }), NOW)?.tier).toBe("annual");
    expect(applyEvent(annual, ev("EXPIRATION"), NOW)).toEqual(free);
  });
  it("ignores other entitlements and unknown events", () => {
    expect(applyEvent(free, ev("INITIAL_PURCHASE", { entitlement_ids: ["other"] }), NOW)).toBeNull();
    expect(applyEvent(free, ev("TEST"), NOW)).toBeNull();
  });
  it("finds the Supabase user id among aliases", () => {
    expect(userIdOf({ id: "x", type: "T", app_user_id: "$RCAnonymousID:abc", aliases: [uid] })).toBe(uid);
  });
  it("derives from subscriber", () => {
    expect(fromSubscriber({ entitlements: { pro: { expires_date: null, product_identifier: "waypack_lifetime" } } }, NOW).tier).toBe("lifetime");
    expect(fromSubscriber({ entitlements: { pro: { expires_date: "2027-01-01T00:00:00Z", product_identifier: "waypack_annual" } } }, NOW).tier).toBe("annual");
    expect(fromSubscriber({ entitlements: { pro: { expires_date: "2026-01-01T00:00:00Z", product_identifier: "waypack_annual" } } }, NOW).tier).toBe("free");
    expect(fromSubscriber({}, NOW).tier).toBe("free");
  });
});
