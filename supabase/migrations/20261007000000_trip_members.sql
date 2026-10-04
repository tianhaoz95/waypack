-- Travel companions (DECISIONS #47). The owner shares an invite link; companions who open it
-- and sign in become viewers: the trip shows up in their app and they can download it (maps
-- are cut under the owner's plan). Viewers can't change, share or delete the trip.
create table public.trip_members (
  trip_id uuid not null references public.trips on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  email text,
  owner_email text,
  role text not null default 'viewer' check (role in ('viewer')),
  joined_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);
create index trip_members_user on public.trip_members (user_id);

-- One active invite link per trip; reusable until it expires or the owner turns it off.
create table public.trip_invites (
  trip_id uuid primary key references public.trips on delete cascade,
  code text not null unique,
  owner_email text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.trip_members enable row level security;
alter table public.trip_invites enable row level security;
-- Service role only (the Worker).
