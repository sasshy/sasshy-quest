# SASSHY QUEST

Static GitHub Pages build.

## Publish With GitHub Pages

1. Create a new GitHub repository.
2. Upload all files in this folder to the repository root.
3. In GitHub, open `Settings` -> `Pages`.
4. Set source to `Deploy from a branch`, branch `main`, folder `/root`.
5. Open the generated `https://...github.io/.../` URL on your phone.

## Optional Mac / iPhone Sync With Supabase

The app has a built-in Supabase sync panel. In the current UI, open it from the sync/settings button and use `Cloud Sync / PC・iPhone同期`.

1. Create a Supabase project.
2. Open `SQL Editor` and run:

```sql
create table if not exists public.app_state (
  sync_key text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

create policy "allow app_state select"
on public.app_state
for select
to anon
using (true);

create policy "allow app_state insert"
on public.app_state
for insert
to anon
with check (true);

create policy "allow app_state update"
on public.app_state
for update
to anon
using (true)
with check (true);
```

3. In Supabase, open `Project Settings` -> `API`.
4. Copy `Project URL` and the `anon public` key.
5. Open the app on Mac, open `Cloud Sync / PC・iPhone同期`, enter:
   - Supabase URL
   - anon key
   - a long private sync key of your choice
6. Press `設定保存`, then `この端末をアップロード`, then turn `自動同期ON`.
7. Open the GitHub Pages URL on iPhone, enter the same three values, press `設定保存`, then `クラウドから読込`, then turn `自動同期ON`.

This is meant for personal use. Treat the sync key like a password and avoid storing sensitive information unless you later add Supabase Auth.
