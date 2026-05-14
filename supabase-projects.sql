-- Run this in Supabase SQL Editor after creating the project.
-- It stores complete PLC Sim project JSON documents per signed-in user.

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Untitled Project',
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.projects enable row level security;

drop policy if exists "Users can read their own projects" on public.projects;
create policy "Users can read their own projects"
on public.projects for select
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own projects" on public.projects;
create policy "Users can insert their own projects"
on public.projects for insert
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own projects" on public.projects;
create policy "Users can update their own projects"
on public.projects for update
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own projects" on public.projects;
create policy "Users can delete their own projects"
on public.projects for delete
using ((select auth.uid()) = user_id);

create index if not exists projects_user_updated_idx
on public.projects (user_id, updated_at desc);

-- Community project snapshots are public, read-only examples cloned from user
-- projects. They intentionally live outside the private projects table.

create table if not exists public.community_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  source_project_id text not null,
  title text not null default 'Untitled Project',
  description text not null default '',
  author_display_name text not null default 'PLC Sim User',
  tags text[] not null default '{}',
  difficulty text not null default 'beginner' check (difficulty in ('beginner', 'intermediate', 'advanced')),
  recipe_notes text not null default '',
  featured boolean not null default false,
  data jsonb not null,
  published boolean not null default true,
  clone_count integer not null default 0 check (clone_count >= 0),
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, source_project_id)
);

alter table public.community_projects
  add column if not exists difficulty text not null default 'beginner';

alter table public.community_projects
  add column if not exists recipe_notes text not null default '';

alter table public.community_projects
  add column if not exists featured boolean not null default false;

alter table public.community_projects
  alter column difficulty set default 'beginner';

alter table public.community_projects
  alter column recipe_notes set default '';

alter table public.community_projects
  alter column featured set default false;

update public.community_projects
set
  difficulty = coalesce(difficulty, 'beginner'),
  recipe_notes = coalesce(recipe_notes, ''),
  featured = coalesce(featured, false);

alter table public.community_projects
  alter column difficulty set not null,
  alter column recipe_notes set not null,
  alter column featured set not null;

alter table public.community_projects
  drop constraint if exists community_projects_difficulty_check;

alter table public.community_projects
  add constraint community_projects_difficulty_check
  check (difficulty in ('beginner', 'intermediate', 'advanced'));

grant select on public.community_projects to anon;
grant select, insert, update, delete on public.community_projects to authenticated;
grant select, insert, update, delete on public.community_projects to service_role;

alter table public.community_projects enable row level security;

drop policy if exists "Anyone can read published community projects" on public.community_projects;
create policy "Anyone can read published community projects"
on public.community_projects for select
to anon, authenticated
using (published = true);

drop policy if exists "Users can publish community projects" on public.community_projects;
create policy "Users can publish community projects"
on public.community_projects for insert
to authenticated
with check ((select auth.uid()) = owner_id);

drop policy if exists "Users can update their community projects" on public.community_projects;
create policy "Users can update their community projects"
on public.community_projects for update
to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists "Users can delete their community projects" on public.community_projects;
create policy "Users can delete their community projects"
on public.community_projects for delete
to authenticated
using ((select auth.uid()) = owner_id);

drop index if exists public.community_projects_published_updated_idx;

create index community_projects_published_updated_idx
on public.community_projects (published, featured desc, updated_at desc);

create index if not exists community_projects_published_clone_idx
on public.community_projects (published, clone_count desc, updated_at desc);

create index if not exists community_projects_tags_idx
on public.community_projects using gin (tags);

revoke execute on function public.increment_community_project_clone_count(uuid) from anon;
revoke execute on function public.increment_community_project_clone_count(uuid) from authenticated;
drop function if exists public.increment_community_project_clone_count(uuid);
