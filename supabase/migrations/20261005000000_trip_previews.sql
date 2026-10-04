-- Live previews (DECISIONS #39): an agent pushes its work-in-progress bundle as it builds;
-- anyone with the unguessable link watches it update. A preview is a draft, not a version:
-- it never shows up in the app, never counts toward trip limits and never cuts offline maps.
-- publish_preview turns the current files into a normal trip version.
create table public.trip_previews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  -- Set when the preview revises an existing trip, or after its first publish.
  trip_id uuid references public.trips on delete set null,
  -- Capability in the preview URL (https://<preview host>/t/<token>/). 32 random chars.
  token text not null unique,
  title text,
  -- path -> {sha256, bytes, type}. Blobs live in R2 at previews/<user>/<id>/blobs/<sha256>.
  files jsonb not null default '{}'::jsonb,
  rev integer not null default 0,
  bytes bigint not null default 0,
  -- {ok, errors, warnings} for the current files (previews accept unfinished bundles).
  validation jsonb,
  published_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 14 days after the last push.
  expires_at timestamptz not null
);

create index trip_previews_user on public.trip_previews (user_id, updated_at desc);
create unique index trip_previews_one_per_trip on public.trip_previews (trip_id) where trip_id is not null;
create index trip_previews_expiry on public.trip_previews (expires_at);

alter table public.trip_previews enable row level security;
-- Service role only (the Worker); the portal reads previews through /api/previews.

-- CLI agents push a zipped preview through the normal upload (create_upload with preview: true).
alter table public.uploads add column purpose text not null default 'publish' check (purpose in ('publish', 'preview'));
alter table public.uploads add column preview_id uuid references public.trip_previews on delete cascade;
