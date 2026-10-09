-- Trip templates (DECISIONS #64): a trip someone actually took, turned into a reusable plan for
-- the public gallery (Discover). No dates, no names: `card` is what the gallery shows
-- (season, length, crew shape, notes from the trip) and `manifest` is the cleaned, dateless plan
-- agents read with get_template. One template per source trip. Drafts are visible only to their
-- owner; only `published` ones are listed.
create table public.trip_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  trip_id uuid not null references public.trips on delete cascade,
  version integer not null,
  slug text not null unique,
  status text not null default 'draft' check (status in ('draft', 'published', 'hidden')),
  title text not null,
  card jsonb not null,
  manifest jsonb not null,
  remix_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz
);

create unique index trip_templates_one_per_trip on public.trip_templates (trip_id);
create index trip_templates_user on public.trip_templates (user_id);
create index trip_templates_published on public.trip_templates (status) where status = 'published';

alter table public.trip_templates enable row level security;
-- Service role only (the Worker).

-- Counts "planned from it" without a read-modify-write race.
create or replace function public.increment_template_remix(template_slug text) returns void
language sql security definer set search_path = public as $$
  update public.trip_templates set remix_count = remix_count + 1 where slug = template_slug and status = 'published';
$$;
revoke all on function public.increment_template_remix(text) from public, anon, authenticated;
