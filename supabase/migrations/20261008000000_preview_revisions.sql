-- Revising published trips (DECISIONS #51). A preview for a trip starts as a copy of its latest
-- published version (base_version), so agents push only what they change; `note` is the agent's
-- one-line "what changed" for the latest push, shown to viewers.
alter table public.trip_previews add column base_version integer;
alter table public.trip_previews add column note text;
