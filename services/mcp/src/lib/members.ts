// Travel companions (DECISIONS #47): an owner's invite link lets companions join a trip as
// viewers. Viewers see and download it (maps cut under the owner's plan); they can't change,
// share or delete it, and can leave at any time.
import type { Env } from "../env.js";
import { randomToken } from "./crypto.js";
import { Db, eq } from "./db.js";
import type { TripRow } from "./pipeline.js";

export const MAX_COMPANIONS = 8;
export const INVITE_DAYS = 14;
const CODE_RE = /^[A-Za-z0-9_-]{24}$/;
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MemberError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface MemberRow { trip_id: string; user_id: string; email: string | null; owner_email: string | null; role: string; joined_at: string }
interface InviteRow { trip_id: string; code: string; owner_email: string | null; created_at: string; expires_at: string }

/** The trip if the user owns it or is a companion on it. */
export async function tripAccess(db: Db, userId: string, tripId: string): Promise<{ trip: TripRow; role: "owner" | "member"; member?: MemberRow } | null> {
  if (!uuidRe.test(tripId)) return null;
  const trip = await db.one<TripRow>("trips", `select=*&id=${eq(tripId)}&deleted_at=is.null`);
  if (!trip) return null;
  if (trip.user_id === userId) return { trip, role: "owner" };
  const member = await db.one<MemberRow>("trip_members", `select=*&trip_id=${eq(tripId)}&user_id=${eq(userId)}`);
  return member ? { trip, role: "member", member } : null;
}

async function ownedTrip(db: Db, userId: string, tripId: string): Promise<TripRow> {
  const a = await tripAccess(db, userId, tripId);
  if (!a) throw new MemberError("Trip not found.", 404);
  if (a.role !== "owner") throw new MemberError("Only the trip's owner can do that.", 403);
  return a.trip;
}

const inviteUrl = (env: Env, code: string) => `${env.PUBLIC_URL}/join/${code}`;

/** Returns the trip's invite link, creating one (or renewing an expired one). */
export async function createInvite(env: Env, db: Db, userId: string, ownerEmail: string | undefined, tripId: string): Promise<{ invite_url: string; expires_at: string }> {
  await ownedTrip(db, userId, tripId);
  const existing = await db.one<InviteRow>("trip_invites", `select=*&trip_id=${eq(tripId)}`);
  if (existing && Date.parse(existing.expires_at) > Date.now()) return { invite_url: inviteUrl(env, existing.code), expires_at: existing.expires_at };
  const row = { trip_id: tripId, code: randomToken(18), owner_email: ownerEmail ?? null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + INVITE_DAYS * 86400000).toISOString() };
  await db.insert("trip_invites", row, { upsert: true, onConflict: "trip_id" });
  return { invite_url: inviteUrl(env, row.code), expires_at: row.expires_at };
}

export async function revokeInvite(db: Db, userId: string, tripId: string): Promise<void> {
  await ownedTrip(db, userId, tripId);
  await db.delete("trip_invites", `trip_id=${eq(tripId)}`);
}

/** Public view of an invite: enough to decide to join, nothing about other companions. */
export async function inviteSummary(db: Db, code: string) {
  if (!CODE_RE.test(code)) return null;
  const inv = await db.one<InviteRow>("trip_invites", `select=*&code=${eq(code)}&expires_at=gt.${new Date().toISOString()}`);
  if (!inv) return null;
  const trip = await db.one<TripRow>("trips", `select=*&id=${eq(inv.trip_id)}&deleted_at=is.null`);
  if (!trip || trip.current_version < 1) return null;
  return { trip_id: trip.id, title: trip.title, start_date: trip.start_date, end_date: trip.end_date, invited_by: inv.owner_email, expires_at: inv.expires_at };
}

export async function acceptInvite(db: Db, userId: string, email: string | undefined, code: string): Promise<{ trip_id: string; title: string; already: boolean; owner: boolean }> {
  const inv = await inviteSummary(db, code);
  if (!inv) throw new MemberError("This invite link has expired or was turned off. Ask for a new one.", 404);
  const access = await tripAccess(db, userId, inv.trip_id);
  if (access) return { trip_id: inv.trip_id, title: inv.title, already: true, owner: access.role === "owner" };
  const count = (await db.select("trip_members", `select=user_id&trip_id=${eq(inv.trip_id)}`)).length;
  if (count >= MAX_COMPANIONS) throw new MemberError(`This trip already has ${MAX_COMPANIONS} companions.`, 409);
  await db.insert("trip_members", { trip_id: inv.trip_id, user_id: userId, email: email ?? null, owner_email: inv.invited_by, role: "viewer" }, { upsert: true, onConflict: "trip_id,user_id" });
  return { trip_id: inv.trip_id, title: inv.title, already: false, owner: false };
}

/** Owner: companions with their emails. */
export async function listMembers(env: Env, db: Db, userId: string, tripId: string) {
  await ownedTrip(db, userId, tripId);
  const members = await db.select<MemberRow>("trip_members", `select=*&trip_id=${eq(tripId)}&order=joined_at`);
  const inv = await db.one<InviteRow>("trip_invites", `select=*&trip_id=${eq(tripId)}&expires_at=gt.${new Date().toISOString()}`);
  return {
    members: members.map((m) => ({ user_id: m.user_id, email: m.email, joined_at: m.joined_at })),
    invite: inv ? { invite_url: inviteUrl(env, inv.code), expires_at: inv.expires_at } : null,
    max: MAX_COMPANIONS,
  };
}

/** The owner removes a companion, or a companion leaves. */
export async function removeMember(db: Db, userId: string, tripId: string, memberId: string): Promise<void> {
  if (!uuidRe.test(memberId)) throw new MemberError("Unknown companion.", 404);
  const a = await tripAccess(db, userId, tripId);
  if (!a) throw new MemberError("Trip not found.", 404);
  if (a.role !== "owner" && memberId !== userId) throw new MemberError("Only the owner can remove other companions.", 403);
  await db.delete("trip_members", `trip_id=${eq(tripId)}&user_id=${eq(memberId)}`);
}

/** Trips the user joined as a companion. */
export async function companionTrips(db: Db, userId: string): Promise<(TripRow & { owner_email: string | null })[]> {
  const rows = await db.select<MemberRow>("trip_members", `select=*&user_id=${eq(userId)}`);
  if (!rows.length) return [];
  const trips = await db.select<TripRow>("trips", `select=id,title,start_date,end_date,current_version,status,updated_at,user_id&id=in.(${rows.map((r) => r.trip_id).join(",")})&deleted_at=is.null`);
  return trips.map((t) => ({ ...t, owner_email: rows.find((r) => r.trip_id === t.id)?.owner_email ?? null }));
}
