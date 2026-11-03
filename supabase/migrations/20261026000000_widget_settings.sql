-- ============================================================================
-- What each person's home-screen widget shows.
--
-- Chosen in FlowDesk (Settings → Widget) and read by the widget on their
-- phone, so it has to live here rather than in the browser: the phone never
-- sees the browser's storage. One row per person, written only by them.
--
-- sections, in the order they are shown: any of 'tasks', 'todos',
-- 'worklog', 'notes'. No row means the default, today's tasks.
--
-- New table only; nothing existing is read or changed.
-- ============================================================================

create table if not exists public.widget_settings (
  user_id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  sections text[] not null default array['tasks']
    check (sections <@ array['tasks', 'todos', 'worklog', 'notes']),
  updated_at timestamptz not null default now()
);

alter table public.widget_settings enable row level security;

drop policy if exists widget_settings_select on public.widget_settings;
create policy widget_settings_select on public.widget_settings
  for select to authenticated using (user_id = auth.uid());

drop policy if exists widget_settings_insert on public.widget_settings;
create policy widget_settings_insert on public.widget_settings
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists widget_settings_update on public.widget_settings;
create policy widget_settings_update on public.widget_settings
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
