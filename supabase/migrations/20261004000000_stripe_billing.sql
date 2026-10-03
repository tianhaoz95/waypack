-- Billing moves to the web portal (Stripe). The mobile apps are free viewers.
alter table public.entitlements
  add column if not exists stripe_customer_id text unique,
  add column if not exists stripe_subscription_id text;

comment on column public.entitlements.source is 'stripe | manual';
create index if not exists entitlements_stripe_customer_idx on public.entitlements (stripe_customer_id);
