-- 2DoByU cloud sync schema (Supabase/Postgres)
-- Safe to run multiple times.

begin;

-- 1) Main per-user JSON document table
create table if not exists public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 2) Keep updated_at current on each update
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_user_data_updated_at on public.user_data;
create trigger trg_user_data_updated_at
before update on public.user_data
for each row
execute function public.set_updated_at();

-- 3) Enable row-level security
alter table public.user_data enable row level security;

-- 4) Policies: each authenticated user can only access their own row
drop policy if exists "user_data_select_own" on public.user_data;
drop policy if exists "user_data_insert_own" on public.user_data;
drop policy if exists "user_data_update_own" on public.user_data;
drop policy if exists "user_data_delete_own" on public.user_data;

-- Select own row
create policy "user_data_select_own"
on public.user_data
for select
to authenticated
using (auth.uid() = user_id);

-- Insert own row
create policy "user_data_insert_own"
on public.user_data
for insert
to authenticated
with check (auth.uid() = user_id);

-- Update own row
create policy "user_data_update_own"
on public.user_data
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Delete own row (optional, but usually desired)
create policy "user_data_delete_own"
on public.user_data
for delete
to authenticated
using (auth.uid() = user_id);

commit;
