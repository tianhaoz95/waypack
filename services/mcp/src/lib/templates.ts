// Trip templates (DECISIONS #66): a trip someone actually took, turned into a plan others can start
// from. The owner's agent runs a short debrief (what they kept, would cut, what surprised them),
// removes personal details, and calls draft_template; the owner checks the draft and publishes it.
// The gallery (Discover, on the site and in the app) lists published templates; another person's
// agent reads one with get_template and adapts it to their dates.
//
// What's public is only what's built here: no dates (just the month it was traveled), no names
// (crew shape only), booking codes masked, route geometry dropped. The owner is never shown unless
// they chose a credit name.
import type { Manifest } from "@waypack/bundle-schema";
import type { Env } from "../env.js";
import { randomToken } from "./crypto.js";
import { Db, eq } from "./db.js";
import { redactText } from "./shares.js";

export const MAX_TEMPLATES_PER_USER = 25;
export const PACES = ["easy", "moderate", "packed"] as const;
export const MOVES = ["car", "transit", "walking", "bike", "mixed"] as const;
export type Pace = (typeof PACES)[number];
export type Move = (typeof MOVES)[number];
export type Status = "draft" | "published" | "hidden";

export class TemplateError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** What the agent sends (after the debrief). Everything else is derived from the trip. */
export interface TemplateInput {
  title?: string;
  tagline: string;
  region: string;
  notes: { kept?: string[]; cut?: string[]; surprise?: string[] };
  recheck?: string[];
  tags?: string[];
  pace: Pace;
  getting_around: Move;
  good_months?: number[];
  starts_from?: string;
  author_name?: string;
  would_go_again?: boolean;
}

export interface PlanDay { title: string; stops: { name: string; lat?: number; lon?: number }[] }

/** The public card: everything the gallery and the template page show. */
export interface TemplateCard {
  slug: string;
  title: string;
  tagline: string;
  region: string;
  lat: number | null;
  lon: number | null;
  days: number;
  places: number;
  /** YYYY-MM: the month the trip started. Never the day. */
  traveled: string;
  /** 1–12: months the plan suits. */
  months: number[];
  season: "Winter" | "Spring" | "Summer" | "Autumn";
  pace: Pace;
  getting_around: Move;
  crew: { adults: number; kids: number[]; pets: number };
  tags: string[];
  starts_from: string | null;
  author: string | null;
  would_go_again: boolean;
  accent: string | null;
  scene: Record<string, unknown>;
  notes: { kept: string[]; cut: string[]; surprise: string[] };
  recheck: string[];
  plan: PlanDay[];
  remix_count: number;
  status: Status;
}

export interface TemplateRow {
  id: string;
  user_id: string;
  trip_id: string;
  version: number;
  slug: string;
  status: Status;
  title: string;
  card: TemplateCard;
  manifest: Record<string, unknown>;
  remix_count: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

const COLS = "id,user_id,trip_id,version,slug,status,title,card,manifest,remix_count,created_at,updated_at,published_at";
const LIST_COLS = "id,user_id,trip_id,version,slug,status,title,card,remix_count,created_at,updated_at,published_at";
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9-]{3,80}$/;

// ------------------------------------------------------------------ building (pure)

const clean = (s: unknown, max: number): string => redactText(String(s ?? "").replace(/\s+/g, " ").trim()).text.slice(0, max);

function list(v: unknown, name: string, maxItems: number, maxLen: number): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new TemplateError(`\`${name}\` must be a list of short strings.`);
  if (v.length > maxItems) throw new TemplateError(`\`${name}\` takes at most ${maxItems} items.`);
  return v.map((x) => clean(x, maxLen)).filter(Boolean);
}

export function seasonOf(month: number): TemplateCard["season"] {
  return month === 12 || month <= 2 ? "Winter" : month <= 5 ? "Spring" : month <= 8 ? "Summer" : "Autumn";
}

/** Months (1–12) a trip's dates touch. */
function tripMonths(start: string, end: string): number[] {
  const out = new Set<number>();
  const d = new Date(`${start}T12:00:00Z`), e = new Date(`${end}T12:00:00Z`);
  for (let i = 0; i < 400 && d <= e; i++, d.setUTCDate(d.getUTCDate() + 1)) out.add(d.getUTCMonth() + 1);
  return [...out].sort((a, b) => a - b);
}

// Same presets as the starter bundle's scene.js (skill/templates/base/assets/scene.js), so a card's
// drawn cover matches the trip's own header.
const SCENE_PRESETS: Record<string, Record<string, unknown>> = {
  "alpine-winter": { sun: "sun", mountains: "snowy-peaks", water: "frozen-lake", trees: "snowy-pine", ground: "snow" },
  "winter-forest": { sun: "low-sun", mountains: "snowy-peaks", water: "none", trees: "sequoia", ground: "snow" },
  "lake-summer": { sun: "sun", mountains: "peaks", water: "lake", trees: "pine", ground: "grass" },
  coast: { sun: "sun", mountains: "rolling", water: "ocean", trees: "none", ground: "sand" },
  tropical: { sun: "sun", mountains: "rolling", water: "ocean", trees: "palm", ground: "sand" },
  desert: { sun: "low-sun", mountains: "mesas", water: "none", trees: "cactus", ground: "sand" },
  autumn: { sun: "low-sun", mountains: "rolling", water: "lake", trees: "autumn", ground: "grass" },
  "spring-blossom": { sun: "sun", mountains: "rolling", water: "river", trees: "blossom", ground: "grass" },
  city: { sun: "low-sun", mountains: "none", water: "river", trees: "deciduous", ground: "city", skyline: true },
  default: { sun: "sun", mountains: "rolling", water: "none", trees: "deciduous", ground: "grass" },
};

export function resolveScene(theme: Manifest["theme"]): Record<string, unknown> {
  const base = SCENE_PRESETS[theme?.preset ?? ""] ?? SCENE_PRESETS.default;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(theme?.scene ?? {})) if (typeof v === "string" || typeof v === "boolean") out[k] = v;
  return out;
}

export function slugify(title: string): string {
  const base = title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "trip";
  return `${base}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
}

/**
 * The dateless plan agents read: days become "Day N", traveler notes and trip id go, route geometry
 * goes (it's recomputed for the new trip), booking codes are masked across the whole document.
 */
export function cleanManifest(m: Manifest): Record<string, unknown> {
  const c = JSON.parse(JSON.stringify(m)) as Record<string, unknown>;
  c.trip_id = null;
  delete c.start_date;
  delete c.end_date;
  delete c.listing;
  delete c.cover_image;
  const t = (m.travelers ?? {}) as NonNullable<Manifest["travelers"]>;
  c.travelers = { adults: t.adults ?? 2, children: (t.children ?? []).map((k) => ({ age: k.age })), pets: (t.pets ?? []).length };
  c.days = (m.days ?? []).map((d, i) => {
    const { date: _date, ...rest } = d as unknown as Record<string, unknown>;
    return { day: i + 1, ...rest };
  });
  if (Array.isArray(c.routes)) {
    c.routes = (c.routes as Record<string, unknown>[]).map((r) => {
      const { geometry: _g, ...rest } = r;
      return rest;
    });
  }
  return JSON.parse(redactText(JSON.stringify(c)).text) as Record<string, unknown>;
}

/** Validates the agent's input and derives the card from the trip's manifest. */
export function buildCard(m: Manifest, input: TemplateInput, opts: { slug: string; today?: string; remixCount?: number; status?: Status }): TemplateCard {
  if (!m || !Array.isArray(m.days) || !m.days.length) throw new TemplateError("This trip has no days to turn into a template.");
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  if (!m.start_date || !m.end_date) throw new TemplateError("The trip needs start and end dates.");
  if (m.end_date >= today) {
    throw new TemplateError(`Templates are made from trips people have taken. This one ends ${m.end_date}; turn it into a template after you're back.`, 409);
  }
  const tagline = clean(input.tagline, 160);
  const region = clean(input.region, 80);
  if (!tagline) throw new TemplateError("`tagline` is required: one sentence on what makes this trip good.");
  if (!region) throw new TemplateError("`region` is required, e.g. \"California, USA\".");
  const notes = {
    kept: list(input.notes?.kept, "notes.kept", 5, 300),
    cut: list(input.notes?.cut, "notes.cut", 5, 300),
    surprise: list(input.notes?.surprise, "notes.surprise", 5, 300),
  };
  if (!notes.kept.length && !notes.cut.length && !notes.surprise.length) {
    throw new TemplateError("Add at least one note from the trip (notes.kept, notes.cut or notes.surprise). Ask the traveler what worked, what they'd skip and what surprised them.");
  }
  if (!PACES.includes(input.pace)) throw new TemplateError(`\`pace\` must be one of ${PACES.join(", ")}.`);
  if (!MOVES.includes(input.getting_around)) throw new TemplateError(`\`getting_around\` must be one of ${MOVES.join(", ")}.`);
  const own = tripMonths(m.start_date, m.end_date);
  let months = own;
  if (input.good_months !== undefined) {
    if (!Array.isArray(input.good_months) || input.good_months.some((x) => !Number.isInteger(x) || x < 1 || x > 12)) {
      throw new TemplateError("`good_months` must be month numbers 1–12 (January = 1).");
    }
    months = [...new Set([...input.good_months, ...own])].sort((a, b) => a - b);
  }
  const places = (m.places ?? []).filter((p) => typeof p.lat === "number" && typeof p.lon === "number");
  const byId = new Map(places.map((p) => [p.id, p]));
  const lat = places.length ? places.reduce((s, p) => s + p.lat, 0) / places.length : null;
  const lon = places.length ? places.reduce((s, p) => s + p.lon, 0) / places.length : null;
  const plan: PlanDay[] = m.days.map((d, i) => ({
    title: clean(d.title || `Day ${i + 1}`, 80),
    stops: (d.items ?? []).slice(0, 10).map((it) => {
      const p = it.place_id ? byId.get(it.place_id) : undefined;
      return { name: clean(it.title, 80), ...(p ? { lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5) } : {}) };
    }).filter((s) => s.name),
  }));
  const t = (m.travelers ?? {}) as NonNullable<Manifest["travelers"]>;
  const startMonth = Number(m.start_date.slice(5, 7));
  return {
    slug: opts.slug,
    title: clean(input.title || m.title, 80),
    tagline,
    region,
    lat: lat === null ? null : +lat.toFixed(4),
    lon: lon === null ? null : +lon.toFixed(4),
    days: m.days.length,
    places: (m.places ?? []).length,
    traveled: m.start_date.slice(0, 7),
    months,
    season: seasonOf(startMonth),
    pace: input.pace,
    getting_around: input.getting_around,
    crew: { adults: Math.max(1, Math.min(20, Number(t.adults ?? 2))), kids: (t.children ?? []).map((k) => Math.max(0, Math.min(17, Math.round(Number(k.age) || 0)))), pets: (t.pets ?? []).length },
    tags: list(input.tags, "tags", 8, 24),
    starts_from: clean(input.starts_from, 60) || null,
    author: clean(input.author_name, 40) || null,
    would_go_again: input.would_go_again !== false,
    accent: typeof m.theme?.accent === "string" && /^#[0-9a-f]{6}$/i.test(m.theme.accent) ? m.theme.accent : null,
    scene: resolveScene(m.theme),
    notes,
    recheck: list(input.recheck, "recheck", 8, 160),
    plan,
    remix_count: opts.remixCount ?? 0,
    status: opts.status ?? "draft",
  };
}

// ------------------------------------------------------------------ search + home (pure)

export interface SearchQuery {
  q?: string;
  /** 1–12 */
  month?: number;
  season?: string;
  length?: "weekend" | "mid" | "long";
  who?: "kids" | "couple" | "friends" | "dog";
  move?: "car" | "nocar";
  sort?: "planned" | "new";
}

const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 1);

function haystack(c: TemplateCard): string {
  return [c.title, c.tagline, c.region, c.season, c.pace, c.getting_around, ...c.tags, ...c.plan.map((d) => d.title)].join(" ").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/** Why a card fits a query, in plain words (the gallery and the MCP tool show these). */
export function matchReasons(c: TemplateCard, q: SearchQuery): string[] {
  const r: string[] = [];
  if (q.month && c.months.includes(q.month)) r.push(`good in ${MONTHS[q.month - 1]}`);
  if (q.season && c.season.toLowerCase() === q.season.toLowerCase()) r.push(c.season.toLowerCase());
  if (q.length === "weekend" && c.days <= 3) r.push(`${c.days} days`);
  if (q.length === "mid" && c.days >= 4 && c.days <= 6) r.push(`${c.days} days`);
  if (q.length === "long" && c.days >= 7) r.push(`${c.days} days`);
  if (q.who === "kids" && c.crew.kids.length) r.push(`tested with kids ${c.crew.kids.join(" & ")}`);
  if (q.who === "dog" && c.crew.pets) r.push("dog friendly");
  if (q.move === "nocar" && c.getting_around !== "car") r.push("no car needed");
  if (q.q) {
    const h = haystack(c);
    for (const w of words(q.q)) if (h.includes(w)) r.push(`“${w}”`);
  }
  return r;
}

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function filterCards(cards: TemplateCard[], q: SearchQuery): TemplateCard[] {
  const ws = q.q ? words(q.q) : [];
  const out = cards.filter((c) => {
    if (q.month && !c.months.includes(q.month)) return false;
    if (q.season && c.season.toLowerCase() !== q.season.toLowerCase()) return false;
    if (q.length === "weekend" && c.days > 3) return false;
    if (q.length === "mid" && (c.days < 4 || c.days > 6)) return false;
    if (q.length === "long" && c.days < 7) return false;
    if (q.who === "kids" && !c.crew.kids.length) return false;
    if (q.who === "couple" && !(c.crew.adults === 2 && !c.crew.kids.length)) return false;
    if (q.who === "friends" && !(c.crew.adults >= 3 && !c.crew.kids.length)) return false;
    if (q.who === "dog" && !c.crew.pets) return false;
    if (q.move === "car" && c.getting_around !== "car") return false;
    if (q.move === "nocar" && c.getting_around === "car") return false;
    if (ws.length) {
      const h = haystack(c);
      if (!ws.every((w) => h.includes(w))) return false;
    }
    return true;
  });
  return q.sort === "new" ? out : [...out].sort((a, b) => b.remix_count - a.remix_count);
}

/** Parses gallery query parameters (anything unknown is ignored). */
export function parseQuery(p: URLSearchParams): SearchQuery {
  const q: SearchQuery = {};
  const text = p.get("q")?.trim();
  if (text) q.q = text.slice(0, 120);
  const month = Number(p.get("month"));
  if (Number.isInteger(month) && month >= 1 && month <= 12) q.month = month;
  const season = p.get("season");
  if (season && /^(winter|spring|summer|autumn)$/i.test(season)) q.season = season;
  const length = p.get("length");
  if (length === "weekend" || length === "mid" || length === "long") q.length = length;
  const who = p.get("who");
  if (who === "kids" || who === "couple" || who === "friends" || who === "dog") q.who = who;
  const move = p.get("move");
  if (move === "car" || move === "nocar") q.move = move;
  if (p.get("sort") === "new") q.sort = "new";
  return q;
}

/** Automatic collections (no hand curation needed); only non-empty ones are shown. */
export const COLLECTIONS: { id: string; name: string; query: SearchQuery }[] = [
  { id: "weekend", name: "Weekend getaways", query: { length: "weekend" } },
  { id: "kids", name: "Tested with kids", query: { who: "kids" } },
  { id: "nocar", name: "No car needed", query: { move: "nocar" } },
  { id: "dog", name: "Bring the dog", query: { who: "dog" } },
  { id: "long", name: "A week or more", query: { length: "long" } },
];

/**
 * The magazine home: a trip of the week (rotates weekly through the five most planned), collections
 * and the most planned list. `cards` are published cards, newest first.
 */
export function homeFeed(cards: TemplateCard[], now = new Date()) {
  const planned = [...cards].sort((a, b) => b.remix_count - a.remix_count);
  const top = planned.slice(0, 5);
  const week = Math.floor(now.getTime() / (7 * 86400e3));
  const featured = top.length ? top[week % top.length] : null;
  const month = now.getUTCMonth() + 1;
  return {
    issue: { month: MONTHS[month - 1], week },
    total: cards.length,
    featured: featured && listCard(featured),
    in_season: filterCards(cards, { month }).slice(0, 8).map(listCard),
    collections: COLLECTIONS.map((c) => ({ id: c.id, name: c.name, query: c.query, items: filterCards(cards, c.query).slice(0, 8).map(listCard) })).filter((c) => c.items.length),
    most_planned: planned.slice(0, 5).map(listCard),
    newest: cards.slice(0, 8).map(listCard),
  };
}

// ------------------------------------------------------------------ storage

async function sourceTrip(db: Db, userId: string, tripId: string) {
  if (!uuidRe.test(tripId)) throw new TemplateError("`trip_id` must be a UUID (from list_trips).");
  const trip = await db.one<{ id: string; current_version: number }>("trips", `select=id,current_version&id=${eq(tripId)}&user_id=${eq(userId)}&deleted_at=is.null`);
  if (!trip || trip.current_version < 1) throw new TemplateError(`Trip ${tripId} not found in your account (only published trips can become templates).`, 404);
  const v = await db.one<{ manifest: Manifest }>("trip_versions", `select=manifest&trip_id=${eq(tripId)}&version=${eq(trip.current_version)}`);
  if (!v) throw new TemplateError("This trip has no published version yet.", 404);
  return { version: trip.current_version, manifest: v.manifest };
}

export function templateLinks(env: Env, slug: string) {
  return { url: `${env.PUBLIC_URL}/trips/${slug}`, gallery_url: `${env.PUBLIC_URL}/discover` };
}

/**
 * Creates or updates the template for a trip, always as a draft: changes are never public until the
 * owner publishes them. `manifest` lets the agent pass a copy it cleaned of personal details.
 */
export async function draftTemplate(env: Env, db: Db, userId: string, tripId: string, input: TemplateInput, manifest?: Manifest, today?: string) {
  const src = await sourceTrip(db, userId, tripId);
  const m = manifest ? { ...src.manifest, ...manifest, start_date: src.manifest.start_date, end_date: src.manifest.end_date } : src.manifest;
  let row = await db.one<TemplateRow>("trip_templates", `select=${COLS}&trip_id=${eq(tripId)}&user_id=${eq(userId)}`);
  if (!row) {
    const mine = await db.count("trip_templates", `user_id=${eq(userId)}`);
    if (mine >= MAX_TEMPLATES_PER_USER) throw new TemplateError(`You have ${mine} templates (max ${MAX_TEMPLATES_PER_USER}). Delete one first.`, 429);
  }
  const slug = row?.slug ?? slugify(input.title || m.title);
  const card = buildCard(m, input, { slug, today, remixCount: row?.remix_count ?? 0, status: "draft" });
  const patch = { version: src.version, status: "draft" as const, title: card.title, card, manifest: cleanManifest(m), updated_at: new Date().toISOString() };
  const [saved] = row
    ? await db.update<TemplateRow>("trip_templates", `id=${eq(row.id)}`, patch)
    : await db.insert<TemplateRow>("trip_templates", { user_id: userId, trip_id: tripId, slug, ...patch });
  return { template_id: saved.id, slug: saved.slug, status: saved.status, card: saved.card, ...templateLinks(env, saved.slug) };
}

export async function setTemplateStatus(env: Env, db: Db, userId: string, id: string, status: "published" | "hidden") {
  if (!uuidRe.test(id)) throw new TemplateError("`template_id` must be a UUID (from draft_template or list_templates).");
  const row = await db.one<TemplateRow>("trip_templates", `select=${LIST_COLS}&id=${eq(id)}&user_id=${eq(userId)}`);
  if (!row) throw new TemplateError("Template not found in your account.", 404);
  const now = new Date().toISOString();
  const [saved] = await db.update<TemplateRow>("trip_templates", `id=${eq(id)}`, {
    status,
    card: { ...row.card, status },
    updated_at: now,
    ...(status === "published" ? { published_at: row.published_at ?? now } : {}),
  });
  return { template_id: saved.id, slug: saved.slug, status: saved.status, ...templateLinks(env, saved.slug) };
}

export async function deleteTemplate(db: Db, userId: string, id: string): Promise<boolean> {
  if (!uuidRe.test(id)) throw new TemplateError("`template_id` must be a UUID.");
  const row = await db.one<{ id: string }>("trip_templates", `select=id&id=${eq(id)}&user_id=${eq(userId)}`);
  if (!row) return false;
  await db.delete("trip_templates", `id=${eq(id)}`);
  return true;
}

export async function listMyTemplates(env: Env, db: Db, userId: string) {
  const rows = await db.select<TemplateRow>("trip_templates", `select=${LIST_COLS}&user_id=${eq(userId)}&order=updated_at.desc`);
  return rows.map((r) => ({ template_id: r.id, trip_id: r.trip_id, slug: r.slug, status: r.status, title: r.title, remix_count: r.remix_count, updated_at: r.updated_at, card: { ...r.card, remix_count: r.remix_count, status: r.status }, ...templateLinks(env, r.slug) }));
}

/** A card for lists (home, search): everything but the day-by-day plan, which only the template page needs. */
export function listCard(c: TemplateCard): Omit<TemplateCard, "plan"> {
  const { plan: _plan, ...rest } = c;
  return rest;
}

/** Published cards, newest first. The gallery is small for now, so filtering happens in the Worker. */
export async function publishedCards(db: Db): Promise<TemplateCard[]> {
  const rows = await db.select<TemplateRow>("trip_templates", `select=${LIST_COLS}&status=eq.published&order=published_at.desc&limit=500`);
  return rows.map((r) => ({ ...r.card, remix_count: r.remix_count, status: r.status }));
}

/** Slug from a template link (…/trips/<slug>) or the bare slug. */
export function slugFrom(input: string): string | null {
  const s = input.trim();
  const m = s.match(/\/trips\/([a-z0-9-]{3,80})(?:[/?#]|$)/) ?? s.match(/^([a-z0-9-]{3,80})$/);
  return m && SLUG_RE.test(m[1]) ? m[1] : null;
}

/** A template by slug: published ones for everyone, drafts and hidden ones only for their owner. */
export async function templateBySlug(db: Db, slug: string, viewerId?: string): Promise<TemplateRow | null> {
  if (!SLUG_RE.test(slug)) return null;
  const row = await db.one<TemplateRow>("trip_templates", `select=${COLS}&slug=${eq(slug)}`);
  if (!row) return null;
  if (row.status !== "published" && row.user_id !== viewerId) return null;
  return row;
}

/** Public JSON for the template page (no owner id, no trip id). */
export function publicTemplate(env: Env, row: TemplateRow, viewerId?: string) {
  return { ...row.card, remix_count: row.remix_count, status: row.status, owner: row.user_id === viewerId, template_id: row.user_id === viewerId ? row.id : undefined, ...templateLinks(env, row.slug) };
}

/** What an agent plans from: the card (notes, re-checks) and the cleaned manifest. Counts a "planned from it". */
export async function templateForAgent(env: Env, db: Db, input: string, viewerId: string) {
  const slug = slugFrom(input);
  const row = slug ? await templateBySlug(db, slug, viewerId) : null;
  if (!row) throw new TemplateError("That template doesn't exist or isn't public. Check the link, or use search_templates.", 404);
  if (row.status === "published" && row.user_id !== viewerId) await db.rpc("increment_template_remix", { template_slug: row.slug }).catch(() => undefined);
  return { card: { ...row.card, remix_count: row.remix_count }, manifest: row.manifest, ...templateLinks(env, row.slug) };
}
