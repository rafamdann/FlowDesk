-- ============================================================================
-- A dictionary for dictation, shared by the whole team.
--
-- Speech-to-text spells names it has never heard however they sound to it:
-- "Dinamene" comes out as "Gyna Many". Two kinds of row fix that:
--
--   word only           — vocabulary. Sent with every recording as a hint, so
--                         the model knows the name exists and how it is spelt.
--   word + heard        — a correction. Whatever was written as `heard` is
--                         replaced with `word` before the text reaches the box.
--
-- Corrections are mostly learned, not typed: when someone fixes a dictated
-- name by hand, FlowDesk records what it heard and what they wrote instead.
--
-- Shared rather than per person: a client's name is spelt the same for
-- everyone, and whoever teaches it once teaches it for the team.
--
-- New table only; nothing existing is read or changed.
-- ============================================================================

create table if not exists public.dictation_words (
  id uuid primary key default gen_random_uuid(),
  word text not null check (length(trim(word)) between 1 and 80),
  -- Lowercased by the app; null for plain vocabulary.
  heard text check (heard is null or length(trim(heard)) between 1 and 120),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

-- The same lesson twice is one row.
create unique index if not exists dictation_words_uniq
  on public.dictation_words (lower(word), coalesce(lower(heard), ''));

alter table public.dictation_words enable row level security;

-- Everyone signed in reads, adds and removes: it is a shared word list, and a
-- wrong entry should be as easy to take out as it was to put in.
drop policy if exists dictation_words_select on public.dictation_words;
create policy dictation_words_select on public.dictation_words
  for select to authenticated using (true);

drop policy if exists dictation_words_insert on public.dictation_words;
create policy dictation_words_insert on public.dictation_words
  for insert to authenticated with check (auth.uid() is not null);

drop policy if exists dictation_words_delete on public.dictation_words;
create policy dictation_words_delete on public.dictation_words
  for delete to authenticated using (true);
