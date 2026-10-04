-- Public, remixable trips (DECISIONS #44). The owner shares a published version as a read-only
-- page on the preview origin (/t/<token>/); anyone can open it and ask their own agent to
-- "plan this trip for my dates" (MCP get_shared_trip). A share is a frozen snapshot: later
-- versions are shared again explicitly. Confirmation/booking numbers are masked when sharing.
create table public.trip_shares (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  trip_id uuid not null references public.trips on delete cascade,
  version integer not null,
  token text not null unique,
  title text,
  summary text,
  start_date date,
  end_date date,
  -- path -> {sha256, bytes, type}; blobs in R2 at shares/<user>/<id>/blobs/<sha256>.
  files jsonb not null default '{}'::jsonb,
  bytes bigint not null default 0,
  redactions integer not null default 0,
  remix_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- One live share per trip (sharing again updates it to the current version, same link).
create unique index trip_shares_one_live on public.trip_shares (trip_id) where revoked_at is null;
create index trip_shares_user on public.trip_shares (user_id);

alter table public.trip_shares enable row level security;
-- Service role only (the Worker).

-- Bumps remix_count without a read-modify-write race.
create or replace function public.increment_remix(share_token text) returns void
language sql security definer set search_path = public as $$
  update public.trip_shares set remix_count = remix_count + 1 where token = share_token and revoked_at is null;
$$;
revoke all on function public.increment_remix(text) from public, anon, authenticated;
