-- 2DoByU Pro schema (normalized + collaboration-ready)
-- Safe to run multiple times.

begin;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Legacy blob table kept for backward compatibility during migration.
create table if not exists public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_user_data_updated_at on public.user_data;
create trigger trg_user_data_updated_at
before update on public.user_data
for each row
execute function public.set_updated_at();

-- Teams and memberships
create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_teams_updated_at on public.teams;
create trigger trg_teams_updated_at
before update on public.teams
for each row
execute function public.set_updated_at();

create table if not exists public.memberships (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

-- Normalized entities
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  team_id uuid null references public.teams(id) on delete set null,
  title text not null,
  due_date date,
  priority text not null default 'medium',
  tag text,
  notes text,
  status text not null default 'todo' check (status in ('todo', 'inprogress', 'done')),
  position_index integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_tasks_updated_at on public.tasks;
create trigger trg_tasks_updated_at
before update on public.tasks
for each row
execute function public.set_updated_at();

create index if not exists idx_tasks_user on public.tasks(user_id);
create index if not exists idx_tasks_team on public.tasks(team_id);

create table if not exists public.habits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  team_id uuid null references public.teams(id) on delete set null,
  name text not null,
  category text,
  habit_type text not null default 'positive',
  frequency text not null default 'daily',
  history jsonb not null default '{}'::jsonb,
  reflections jsonb not null default '{}'::jsonb,
  color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_habits_updated_at on public.habits;
create trigger trg_habits_updated_at
before update on public.habits
for each row
execute function public.set_updated_at();

create index if not exists idx_habits_user on public.habits(user_id);
create index if not exists idx_habits_team on public.habits(team_id);

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  body text,
  color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_notes_updated_at on public.notes;
create trigger trg_notes_updated_at
before update on public.notes
for each row
execute function public.set_updated_at();

create index if not exists idx_notes_user on public.notes(user_id);

-- Push subscriptions
create table if not exists public.user_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text,
  auth text,
  subscription jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_user_subscriptions_updated_at on public.user_subscriptions;
create trigger trg_user_subscriptions_updated_at
before update on public.user_subscriptions
for each row
execute function public.set_updated_at();

alter table public.user_data enable row level security;
alter table public.teams enable row level security;
alter table public.memberships enable row level security;
alter table public.tasks enable row level security;
alter table public.habits enable row level security;
alter table public.notes enable row level security;
alter table public.user_subscriptions enable row level security;

drop policy if exists "user_data_select_own" on public.user_data;
drop policy if exists "user_data_insert_own" on public.user_data;
drop policy if exists "user_data_update_own" on public.user_data;
drop policy if exists "user_data_delete_own" on public.user_data;
create policy "user_data_select_own" on public.user_data for select to authenticated using (auth.uid() = user_id);
create policy "user_data_insert_own" on public.user_data for insert to authenticated with check (auth.uid() = user_id);
create policy "user_data_update_own" on public.user_data for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "user_data_delete_own" on public.user_data for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "teams_select_member" on public.teams;
drop policy if exists "teams_insert_owner" on public.teams;
drop policy if exists "teams_update_owner_admin" on public.teams;
drop policy if exists "teams_delete_owner" on public.teams;
create policy "teams_select_member"
on public.teams for select to authenticated
using (
  owner_id = auth.uid()
  or exists (
    select 1 from public.memberships m
    where m.team_id = teams.id and m.user_id = auth.uid()
  )
);
create policy "teams_insert_owner" on public.teams for insert to authenticated with check (owner_id = auth.uid());
create policy "teams_update_owner_admin"
on public.teams for update to authenticated
using (
  owner_id = auth.uid()
  or exists (
    select 1 from public.memberships m
    where m.team_id = teams.id and m.user_id = auth.uid() and m.role in ('owner','admin')
  )
)
with check (
  owner_id = auth.uid()
  or exists (
    select 1 from public.memberships m
    where m.team_id = teams.id and m.user_id = auth.uid() and m.role in ('owner','admin')
  )
);
create policy "teams_delete_owner" on public.teams for delete to authenticated using (owner_id = auth.uid());

drop policy if exists "memberships_select_member" on public.memberships;
drop policy if exists "memberships_insert_admin" on public.memberships;
drop policy if exists "memberships_update_admin" on public.memberships;
drop policy if exists "memberships_delete_admin_or_self" on public.memberships;
create policy "memberships_select_member"
on public.memberships for select to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1 from public.memberships m
    where m.team_id = memberships.team_id and m.user_id = auth.uid()
  )
);
create policy "memberships_insert_admin"
on public.memberships for insert to authenticated
with check (
  exists (
    select 1 from public.teams t where t.id = memberships.team_id and t.owner_id = auth.uid()
  )
  or exists (
    select 1 from public.memberships m
    where m.team_id = memberships.team_id and m.user_id = auth.uid() and m.role in ('owner','admin')
  )
);
create policy "memberships_update_admin"
on public.memberships for update to authenticated
using (
  exists (
    select 1 from public.teams t where t.id = memberships.team_id and t.owner_id = auth.uid()
  )
  or exists (
    select 1 from public.memberships m
    where m.team_id = memberships.team_id and m.user_id = auth.uid() and m.role in ('owner','admin')
  )
)
with check (
  exists (
    select 1 from public.teams t where t.id = memberships.team_id and t.owner_id = auth.uid()
  )
  or exists (
    select 1 from public.memberships m
    where m.team_id = memberships.team_id and m.user_id = auth.uid() and m.role in ('owner','admin')
  )
);
create policy "memberships_delete_admin_or_self"
on public.memberships for delete to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1 from public.teams t where t.id = memberships.team_id and t.owner_id = auth.uid()
  )
  or exists (
    select 1 from public.memberships m
    where m.team_id = memberships.team_id and m.user_id = auth.uid() and m.role in ('owner','admin')
  )
);

drop policy if exists "tasks_select_owner_or_team" on public.tasks;
drop policy if exists "tasks_insert_owner_or_team_member" on public.tasks;
drop policy if exists "tasks_update_owner_or_team_member" on public.tasks;
drop policy if exists "tasks_delete_owner_or_team_member" on public.tasks;
create policy "tasks_select_owner_or_team"
on public.tasks for select to authenticated
using (
  user_id = auth.uid()
  or (
    team_id is not null
    and exists (
      select 1 from public.memberships m
      where m.team_id = tasks.team_id and m.user_id = auth.uid()
    )
  )
);
create policy "tasks_insert_owner_or_team_member"
on public.tasks for insert to authenticated
with check (
  user_id = auth.uid()
  or (
    team_id is not null
    and exists (
      select 1 from public.memberships m
      where m.team_id = tasks.team_id and m.user_id = auth.uid()
    )
  )
);
create policy "tasks_update_owner_or_team_member"
on public.tasks for update to authenticated
using (
  user_id = auth.uid()
  or (
    team_id is not null
    and exists (
      select 1 from public.memberships m
      where m.team_id = tasks.team_id and m.user_id = auth.uid()
    )
  )
)
with check (
  user_id = auth.uid()
  or (
    team_id is not null
    and exists (
      select 1 from public.memberships m
      where m.team_id = tasks.team_id and m.user_id = auth.uid()
    )
  )
);
create policy "tasks_delete_owner_or_team_member"
on public.tasks for delete to authenticated
using (
  user_id = auth.uid()
  or (
    team_id is not null
    and exists (
      select 1 from public.memberships m
      where m.team_id = tasks.team_id and m.user_id = auth.uid()
    )
  )
);

drop policy if exists "habits_select_owner_or_team" on public.habits;
drop policy if exists "habits_insert_owner_or_team_member" on public.habits;
drop policy if exists "habits_update_owner_or_team_member" on public.habits;
drop policy if exists "habits_delete_owner_or_team_member" on public.habits;
create policy "habits_select_owner_or_team"
on public.habits for select to authenticated
using (
  user_id = auth.uid()
  or (
    team_id is not null
    and exists (
      select 1 from public.memberships m
      where m.team_id = habits.team_id and m.user_id = auth.uid()
    )
  )
);
create policy "habits_insert_owner_or_team_member"
on public.habits for insert to authenticated
with check (
  user_id = auth.uid()
  or (
    team_id is not null
    and exists (
      select 1 from public.memberships m
      where m.team_id = habits.team_id and m.user_id = auth.uid()
    )
  )
);
create policy "habits_update_owner_or_team_member"
on public.habits for update to authenticated
using (
  user_id = auth.uid()
  or (
    team_id is not null
    and exists (
      select 1 from public.memberships m
      where m.team_id = habits.team_id and m.user_id = auth.uid()
    )
  )
)
with check (
  user_id = auth.uid()
  or (
    team_id is not null
    and exists (
      select 1 from public.memberships m
      where m.team_id = habits.team_id and m.user_id = auth.uid()
    )
  )
);
create policy "habits_delete_owner_or_team_member"
on public.habits for delete to authenticated
using (
  user_id = auth.uid()
  or (
    team_id is not null
    and exists (
      select 1 from public.memberships m
      where m.team_id = habits.team_id and m.user_id = auth.uid()
    )
  )
);

drop policy if exists "notes_select_own" on public.notes;
drop policy if exists "notes_insert_own" on public.notes;
drop policy if exists "notes_update_own" on public.notes;
drop policy if exists "notes_delete_own" on public.notes;
create policy "notes_select_own" on public.notes for select to authenticated using (auth.uid() = user_id);
create policy "notes_insert_own" on public.notes for insert to authenticated with check (auth.uid() = user_id);
create policy "notes_update_own" on public.notes for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "notes_delete_own" on public.notes for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "user_subscriptions_select_own" on public.user_subscriptions;
drop policy if exists "user_subscriptions_insert_own" on public.user_subscriptions;
drop policy if exists "user_subscriptions_update_own" on public.user_subscriptions;
drop policy if exists "user_subscriptions_delete_own" on public.user_subscriptions;
create policy "user_subscriptions_select_own" on public.user_subscriptions for select to authenticated using (auth.uid() = user_id);
create policy "user_subscriptions_insert_own" on public.user_subscriptions for insert to authenticated with check (auth.uid() = user_id);
create policy "user_subscriptions_update_own" on public.user_subscriptions for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "user_subscriptions_delete_own" on public.user_subscriptions for delete to authenticated using (auth.uid() = user_id);

commit;
