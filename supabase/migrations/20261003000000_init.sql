-- Waypack v1 schema (design §10). All writes happen server-side with the service role
-- (MCP Worker / Edge Functions); clients only read their own rows through RLS.

create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  title text not null,
  start_date date,
  end_date date,
  current_version int not null default 0,
  status text not null default 'processing' check (status in ('processing', 'ready', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index trips_user_idx on public.trips (user_id) where deleted_at is null;

create table public.trip_versions (
  trip_id uuid not null references public.trips on delete cascade,
  version int not null,
  bundle_key text not null,
  bundle_sha256 text not null,
  bundle_bytes bigint not null,
  manifest jsonb not null,
  sdk_version text not null,
  map_hash text,                       -- hash of the manifest's map areas (re-cut tiles only when it changes)
  created_at timestamptz not null default now(),
  primary key (trip_id, version)
);

create table public.map_extracts (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips on delete cascade,
  version int not null,                -- first trip version that uses this extract
  area_index int not null default 0,   -- 0 = map.bbox, 1.. = extra_areas
  area_hash text not null,             -- hash(bbox, max_zoom, basemap_build)
  bbox double precision[] not null check (array_length(bbox, 1) = 4),
  max_zoom int not null,
  basemap_build text,
  tiles_key text,
  tiles_bytes bigint,
  tiles_sha256 text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed', 'expired', 'skipped')),
  error text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz
);
create index map_extracts_trip_idx on public.map_extracts (trip_id);
create index map_extracts_expiry_idx on public.map_extracts (expires_at) where status = 'ready';

create table public.entitlements (
  user_id uuid primary key references auth.users on delete cascade,
  tier text not null default 'free' check (tier in ('free', 'annual', 'lifetime')),
  active boolean not null default true,
  expires_at timestamptz,
  source text,                         -- 'revenuecat' | 'manual'
  updated_at timestamptz not null default now()
);

create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  token_hash text not null unique,
  token_prefix text not null,          -- first chars for display, e.g. "wpk_3fA9"
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- Pending uploads created by MCP create_upload (single use).
create table public.uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  trip_id uuid references public.trips on delete cascade,
  size_bytes bigint not null,
  object_key text not null,
  status text not null default 'pending' check (status in ('pending', 'received', 'finalized', 'failed', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- RevenueCat webhook idempotency log.
create table public.billing_events (
  id text primary key,
  user_id uuid,
  type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.trips enable row level security;
alter table public.trip_versions enable row level security;
alter table public.map_extracts enable row level security;
alter table public.entitlements enable row level security;
alter table public.api_tokens enable row level security;
alter table public.uploads enable row level security;
alter table public.billing_events enable row level security;

create policy "own profile" on public.profiles for select using (auth.uid() = id);
create policy "own trips" on public.trips for select using (auth.uid() = user_id and deleted_at is null);
create policy "own trip versions" on public.trip_versions for select
  using (exists (select 1 from public.trips t where t.id = trip_id and t.user_id = auth.uid() and t.deleted_at is null));
create policy "own map extracts" on public.map_extracts for select
  using (exists (select 1 from public.trips t where t.id = trip_id and t.user_id = auth.uid() and t.deleted_at is null));
create policy "own entitlements" on public.entitlements for select using (auth.uid() = user_id);
create policy "own api tokens" on public.api_tokens for select using (auth.uid() = user_id);
-- uploads and billing_events: service role only (no policies).

-- ---------- helpers ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  insert into public.entitlements (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger trips_touch before update on public.trips for each row execute function public.touch_updated_at();
create trigger map_extracts_touch before update on public.map_extracts for each row execute function public.touch_updated_at();

-- Trips list for the app: one row per trip with latest version info, sizes and extract state.
create or replace view public.trip_summaries with (security_invoker = true) as
select
  t.id, t.title, t.start_date, t.end_date, t.current_version, t.status, t.updated_at,
  v.bundle_bytes, v.bundle_sha256, v.created_at as version_created_at,
  coalesce((select sum(e.tiles_bytes) from public.map_extracts e
            where e.trip_id = t.id and e.status = 'ready'), 0)::bigint as tiles_bytes,
  (select count(*) from public.map_extracts e where e.trip_id = t.id and e.status in ('pending', 'processing'))::int as extracts_pending
from public.trips t
left join public.trip_versions v on v.trip_id = t.id and v.version = t.current_version
where t.deleted_at is null;

grant select on public.trip_summaries to authenticated;
