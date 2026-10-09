import type { Db } from "./db.js";
import { eq } from "./db.js";

export type Tier = "free" | "annual" | "lifetime";

export interface Plan { tier: Tier; activeTrips: number; offlineMaps: boolean; maxAreas: number }

export const PLANS: Record<Tier, Plan> = {
  free: { tier: "free", activeTrips: 1, offlineMaps: false, maxAreas: 0 },
  annual: { tier: "annual", activeTrips: 10, offlineMaps: true, maxAreas: 4 },
  lifetime: { tier: "lifetime", activeTrips: 10, offlineMaps: true, maxAreas: 4 },
};

export const upgradeHint = (publicUrl: string) =>
  `Upgrade to Waypack Pro at ${publicUrl}/account#billing to unlock offline maps and up to 10 active trips.`;

interface EntRow { tier: Tier; active: boolean; expires_at: string | null }

export async function planFor(db: Db, userId: string, now = new Date()): Promise<Plan> {
  const row = await db.one<EntRow>("entitlements", `select=tier,active,expires_at&user_id=${eq(userId)}`);
  if (!row || !row.active) return PLANS.free;
  if (row.tier !== "lifetime" && row.expires_at && new Date(row.expires_at) < now) return PLANS.free;
  return PLANS[row.tier] ?? PLANS.free;
}

export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

/** Trips whose end date hasn't passed (or have no dates yet) count as active. */
export async function activeTripCount(db: Db, userId: string, excludeTripId?: string, now = new Date()): Promise<number> {
  const rows = await db.select<{ id: string; end_date: string | null }>(
    "trips",
    `select=id,end_date&user_id=${eq(userId)}&deleted_at=is.null&or=(end_date.is.null,end_date.gte.${todayUtc(now)})`,
  );
  return rows.filter((r) => r.id !== excludeTripId).length;
}
