-- Equilibrium / SpaceMan -- Supabase schema hardening.
--
-- Idempotent: safe to re-run. Apply with
--   psql "$DATABASE_URL" -f supabase_schema.sql
--
-- WHY THIS FILE EXISTS
-- Supabase exposes every table in `public` over PostgREST. The anon key is
-- public by design (it ships to browsers), so without RLS anyone can call
--   GET https://<ref>.supabase.co/rest/v1/users?select=*
-- and read the table. RLS is what stops that. The Flask app connects as the
-- `postgres` role, which BYPASSES RLS -- so these policies are not what gates
-- the app's own queries (Flask's own auth checks do that). They gate the REST
-- API, which is reachable by anyone on the internet.

begin;

-- ---------------------------------------------------------------------------
-- 1. Table renames (no-ops after the first run)
-- ---------------------------------------------------------------------------
alter table if exists public.profiles rename to users;
alter table if exists public.checkins rename to check_ins;

-- ---------------------------------------------------------------------------
-- 2. Make the id columns real uuids
--
-- SQLAlchemy emits varchar(36), but auth.users.id is uuid and a foreign key
-- needs matching types. Drop the dependent FKs, convert, then re-add.
-- ---------------------------------------------------------------------------
do $$
declare
  fk record;
begin
  if (select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'users' and column_name = 'id') = 'uuid'
  then
    return;  -- already converted
  end if;

  -- Drop every FK pointing at public.users, whatever SQLAlchemy named it.
  for fk in
    select con.conname, rel.relname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_class ref on ref.oid = con.confrelid
    where con.contype = 'f' and ref.relname = 'users'
      and rel.relnamespace = 'public'::regnamespace
  loop
    execute format('alter table public.%I drop constraint %I', fk.relname, fk.conname);
  end loop;

  alter table public.users       alter column id      type uuid using id::uuid;
  alter table public.check_ins   alter column user_id type uuid using user_id::uuid;
  alter table public.commitments alter column user_id type uuid using user_id::uuid;
  alter table public.insights    alter column user_id type uuid using user_id::uuid;

  alter table public.check_ins   add constraint check_ins_user_id_fkey
    foreign key (user_id) references public.users(id) on delete cascade;
  alter table public.commitments add constraint commitments_user_id_fkey
    foreign key (user_id) references public.users(id) on delete cascade;
  alter table public.insights    add constraint insights_user_id_fkey
    foreign key (user_id) references public.users(id) on delete cascade;
end $$;

-- Tie users to auth.users so deleting an auth user cascades everything away.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_id_fkey') then
    alter table public.users
      add constraint users_id_fkey
      foreign key (id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2b. Sleep-tracking columns, added after the initial launch.
-- ---------------------------------------------------------------------------
alter table public.users
  add column if not exists bedtime_reminder           varchar(5),
  add column if not exists bedtime_reminder_sent_date  date;

-- ---------------------------------------------------------------------------
-- 2c. Meditation habit-tracker counter. Server-incremented only (no grant to
-- `authenticated` below) so it can't be inflated via a direct REST call.
-- ---------------------------------------------------------------------------
alter table public.users
  add column if not exists meditation_sessions_completed integer not null default 0;

-- ---------------------------------------------------------------------------
-- 3. Admin check as SECURITY DEFINER
--
-- The admin role itself was removed from the app (no `is_admin` column left
-- on `users`), but the policies below still call this function -- kept as a
-- permanent "no" so those `or public.is_admin()` clauses stay harmless no-ops
-- instead of every policy needing to be rewritten.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select false;
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Enable RLS everywhere
--
-- RLS on with zero policies = deny all. Every table below is opt-in only.
-- ---------------------------------------------------------------------------
alter table public.users              enable row level security;
alter table public.check_ins          enable row level security;
alter table public.commitments        enable row level security;
alter table public.insights           enable row level security;
alter table public.activity_sessions  enable row level security;
alter table public.push_subscriptions enable row level security;

-- Deliberately NOT `force row level security`. FORCE applies RLS to the table
-- owner too, and Flask connects as `postgres` (the owner) with no JWT, so
-- auth.uid() would be NULL, every policy would evaluate false, and the app
-- would be locked out of its own tables. The app does its own authorisation;
-- these policies exist to gate the PostgREST API, whose roles are anon and
-- authenticated -- neither of which is the owner.

-- ---------------------------------------------------------------------------
-- 5. Privileges
--
-- anon (logged out) gets nothing at all. authenticated gets table access, then
-- RLS narrows it to their own rows. Column-level grants handle what RLS can't:
-- stopping someone editing a *field* they shouldn't (is_admin especially).
-- ---------------------------------------------------------------------------
revoke all on public.users, public.check_ins, public.commitments, public.insights,
  public.activity_sessions, public.push_subscriptions
  from anon, authenticated;

-- users: read/insert own row; may only ever change these columns.
grant select, insert                              on public.users to authenticated;
grant update (display_name, theme, bedtime_reminder,
              bedtime_reminder_sent_date)          on public.users to authenticated;

grant select, insert, update, delete on public.check_ins   to authenticated;
grant select, insert, update, delete on public.commitments to authenticated;
-- insights are written by the server; users may only read and triage them.
grant select                          on public.insights to authenticated;
grant update (acted_on, dismissed)    on public.insights to authenticated;

grant select, insert, update, delete on public.activity_sessions  to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

grant usage, select on all sequences in schema public to authenticated;

-- ---------------------------------------------------------------------------
-- 5b. Column defaults
--
-- SQLAlchemy applies its defaults in Python, so the columns land NOT NULL with
-- no database default. That's fine for the Flask app but breaks any insert
-- coming through PostgREST -- which is exactly what the policies below permit.
-- Mirror the model defaults into the database so both paths work.
-- ---------------------------------------------------------------------------
alter table public.users
  alter column created_at set default now(),
  alter column theme      set default 'light';

alter table public.check_ins
  alter column created_at set default now(),
  alter column note       set default '';

alter table public.commitments
  alter column created_at set default now(),
  alter column category   set default 'academic',
  alter column movable    set default true,
  alter column effort     set default 3,
  alter column completed  set default false;

alter table public.insights
  alter column created_at set default now(),
  alter column body       set default '',
  alter column tag        set default 'pattern',
  alter column severity   set default 'low',
  alter column acted_on   set default false,
  alter column dismissed  set default false;

alter table public.activity_sessions
  alter column started_at   set default now(),
  alter column last_ping_at set default now();

-- ---------------------------------------------------------------------------
-- 6. Policies
-- ---------------------------------------------------------------------------

-- users -------------------------------------------------------------------
drop policy if exists users_select_own    on public.users;
drop policy if exists users_insert_own    on public.users;
drop policy if exists users_update_own    on public.users;

create policy users_select_own on public.users
  for select to authenticated
  using (auth.uid() = id or public.is_admin());

create policy users_insert_own on public.users
  for insert to authenticated
  with check (auth.uid() = id);

create policy users_update_own on public.users
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- check_ins ---------------------------------------------------------------
drop policy if exists check_ins_select_own on public.check_ins;
drop policy if exists check_ins_insert_own on public.check_ins;
drop policy if exists check_ins_update_own on public.check_ins;
drop policy if exists check_ins_delete_own on public.check_ins;

create policy check_ins_select_own on public.check_ins
  for select to authenticated
  using (auth.uid() = user_id or public.is_admin());

create policy check_ins_insert_own on public.check_ins
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy check_ins_update_own on public.check_ins
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy check_ins_delete_own on public.check_ins
  for delete to authenticated
  using (auth.uid() = user_id);

-- commitments -------------------------------------------------------------
drop policy if exists commitments_select_own on public.commitments;
drop policy if exists commitments_insert_own on public.commitments;
drop policy if exists commitments_update_own on public.commitments;
drop policy if exists commitments_delete_own on public.commitments;

create policy commitments_select_own on public.commitments
  for select to authenticated
  using (auth.uid() = user_id);

create policy commitments_insert_own on public.commitments
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy commitments_update_own on public.commitments
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy commitments_delete_own on public.commitments
  for delete to authenticated
  using (auth.uid() = user_id);

-- insights ----------------------------------------------------------------
-- Read your own; mark them acted-on/dismissed. No insert or delete policy on
-- purpose: only the server (postgres / service_role) writes insights, so a
-- user can't fabricate one.
drop policy if exists insights_select_own on public.insights;
drop policy if exists insights_update_own on public.insights;

create policy insights_select_own on public.insights
  for select to authenticated
  using (auth.uid() = user_id);

create policy insights_update_own on public.insights
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- activity_sessions -------------------------------------------------------
drop policy if exists activity_sessions_select_own on public.activity_sessions;
drop policy if exists activity_sessions_insert_own on public.activity_sessions;
drop policy if exists activity_sessions_update_own on public.activity_sessions;
drop policy if exists activity_sessions_delete_own on public.activity_sessions;

create policy activity_sessions_select_own on public.activity_sessions
  for select to authenticated
  using (auth.uid() = user_id);

create policy activity_sessions_insert_own on public.activity_sessions
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy activity_sessions_update_own on public.activity_sessions
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy activity_sessions_delete_own on public.activity_sessions
  for delete to authenticated
  using (auth.uid() = user_id);

-- push_subscriptions --------------------------------------------------------
drop policy if exists push_subscriptions_select_own on public.push_subscriptions;
drop policy if exists push_subscriptions_insert_own on public.push_subscriptions;
drop policy if exists push_subscriptions_update_own on public.push_subscriptions;
drop policy if exists push_subscriptions_delete_own on public.push_subscriptions;

create policy push_subscriptions_select_own on public.push_subscriptions
  for select to authenticated
  using (auth.uid() = user_id);

create policy push_subscriptions_insert_own on public.push_subscriptions
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy push_subscriptions_update_own on public.push_subscriptions
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy push_subscriptions_delete_own on public.push_subscriptions
  for delete to authenticated
  using (auth.uid() = user_id);

commit;
