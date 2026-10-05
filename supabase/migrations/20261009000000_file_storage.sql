-- Files (trip bundles, uploads, previews, shares, Mac releases) move from R2 to
-- Supabase Storage, so data and files live in one place (DECISIONS #56).
-- Only the Worker touches this bucket, with the service key; no client policies.
insert into storage.buckets (id, name, public)
values ('waypack', 'waypack', false)
on conflict (id) do nothing;

-- Flat listing by key prefix (Storage's list API is one folder deep), keyset-paginated.
create or replace function public.storage_list(p_bucket text, p_prefix text, p_after text default '', p_limit int default 1000)
returns table (name text, size bigint, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name, coalesce((o.metadata ->> 'size')::bigint, 0), o.created_at
  from storage.objects o
  where o.bucket_id = p_bucket
    and starts_with(o.name, p_prefix)
    and o.name collate "C" > p_after collate "C"
  order by o.name collate "C"
  limit least(p_limit, 1000);
$$;

revoke execute on function public.storage_list(text, text, text, int) from public, anon, authenticated;
grant execute on function public.storage_list(text, text, text, int) to service_role;
