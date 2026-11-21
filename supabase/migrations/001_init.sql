-- StudyDeck schema
-- Every row belongs to exactly one user. Row Level Security makes sure a
-- signed-in user can only ever read or change their own rows; nobody can see
-- anybody else's notes, cards or quizzes through the app or the public API.
-- Deletes are hard deletes (no "trash", no soft-delete flags): once a user
-- removes something, or resets / deletes their account, it is gone.

-- ---------- helpers ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------- profiles ----------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  quick_note text default '',
  daily_goal int not null default 20,
  updated_at timestamptz not null default now()
);

-- ---------- folders (subjects) ----------
create table public.folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  color text not null default '#4f7cff',
  created_at timestamptz not null default now()
);

-- ---------- notes ----------
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  folder_id uuid references public.folders (id) on delete set null,
  title text not null default 'Untitled note',
  content text not null default '',
  tags text[] not null default '{}',
  pinned boolean not null default false,
  source_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger notes_updated_at before update on public.notes
  for each row execute function public.set_updated_at();

-- ---------- documents (uploaded PDFs / books) ----------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  folder_id uuid references public.folders (id) on delete set null,
  title text not null,
  file_path text,
  file_type text,
  size_bytes bigint,
  page_count int,
  text_content text not null default '',
  created_at timestamptz not null default now()
);

-- ---------- flashcard decks & cards ----------
create table public.decks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  folder_id uuid references public.folders (id) on delete set null,
  title text not null,
  description text default '',
  color text not null default '#4f7cff',
  source_label text,
  created_at timestamptz not null default now()
);

create table public.cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  deck_id uuid not null references public.decks (id) on delete cascade,
  front text not null,
  back text not null,
  ease real not null default 2.5,
  interval_days real not null default 0,
  reps int not null default 0,
  lapses int not null default 0,
  due_at timestamptz not null default now(),
  last_reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------- quizzes / exams ----------
create table public.quizzes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  folder_id uuid references public.folders (id) on delete set null,
  title text not null,
  kind text not null default 'quiz' check (kind in ('quiz', 'exam')),
  time_limit_min int,
  questions jsonb not null default '[]',
  source_label text,
  created_at timestamptz not null default now()
);

create table public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  quiz_id uuid not null references public.quizzes (id) on delete cascade,
  score int not null,
  total int not null,
  duration_s int,
  answers jsonb not null default '[]',
  created_at timestamptz not null default now()
);

-- ---------- review log (powers streaks + activity chart) ----------
create table public.study_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  deck_id uuid references public.decks (id) on delete cascade,
  card_id uuid references public.cards (id) on delete cascade,
  rating smallint not null,
  created_at timestamptz not null default now()
);

-- ---------- indexes ----------
create index on public.folders (user_id);
create index on public.notes (user_id, updated_at desc);
create index on public.notes (folder_id);
create index on public.documents (user_id, created_at desc);
create index on public.documents (folder_id);
create index on public.decks (user_id);
create index on public.decks (folder_id);
create index on public.cards (user_id, due_at);
create index on public.cards (deck_id);
create index on public.quizzes (user_id, created_at desc);
create index on public.quizzes (folder_id);
create index on public.quiz_attempts (user_id, created_at desc);
create index on public.quiz_attempts (quiz_id);
create index on public.study_logs (user_id, created_at desc);
create index on public.study_logs (deck_id);
create index on public.study_logs (card_id);

-- ---------- Row Level Security: owner-only on every table ----------
alter table public.profiles enable row level security;
create policy "own profile" on public.profiles for all to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

do $$
declare t text;
begin
  foreach t in array array['folders','notes','documents','decks','cards','quizzes','quiz_attempts','study_logs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated
         using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;

-- ---------- private file storage: users/<uid>/... only ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('study-files', 'study-files', false, 52428800)
on conflict (id) do nothing;

create policy "own files read" on storage.objects for select to authenticated
  using (bucket_id = 'study-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own files insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'study-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own files update" on storage.objects for update to authenticated
  using (bucket_id = 'study-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own files delete" on storage.objects for delete to authenticated
  using (bucket_id = 'study-files' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------- reset: wipe all of the caller's study data, keep the login ----------
create or replace function public.reset_my_data()
returns void language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.study_logs    where user_id = auth.uid();
  delete from public.quiz_attempts where user_id = auth.uid();
  delete from public.quizzes       where user_id = auth.uid();
  delete from public.cards         where user_id = auth.uid();
  delete from public.decks         where user_id = auth.uid();
  delete from public.documents     where user_id = auth.uid();
  delete from public.notes         where user_id = auth.uid();
  delete from public.folders       where user_id = auth.uid();
  update public.profiles set quick_note = '' where id = auth.uid();
end $$;

-- ---------- delete account: removes the login and (via cascade) every row ----------
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  delete from auth.users where id = auth.uid();
end $$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
revoke all on function public.reset_my_data() from public, anon;
grant execute on function public.reset_my_data() to authenticated;
