-- SASSHY v2.3: iPhone / Mac Web Push.
-- Run once in Supabase SQL Editor after the main supabase-setup.sql.

create table if not exists public.sasshy_v2_push_subscriptions (
  workspace_hash text not null,
  endpoint_hash text not null,
  subscription jsonb not null,
  device_name text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_hash, endpoint_hash)
);

create table if not exists public.sasshy_v2_push_deliveries (
  workspace_hash text not null,
  notification_key text not null,
  endpoint_hash text not null,
  delivered_at timestamptz,
  error text not null default '',
  created_at timestamptz not null default now(),
  primary key (workspace_hash, notification_key, endpoint_hash)
);

create index if not exists sasshy_v2_push_subscriptions_active_idx
  on public.sasshy_v2_push_subscriptions(workspace_hash)
  where active;

create index if not exists sasshy_v2_push_deliveries_created_idx
  on public.sasshy_v2_push_deliveries(created_at);

alter table public.sasshy_v2_push_subscriptions enable row level security;
alter table public.sasshy_v2_push_deliveries enable row level security;

revoke all on public.sasshy_v2_push_subscriptions from public, anon, authenticated;
revoke all on public.sasshy_v2_push_deliveries from public, anon, authenticated;
