create table public.progress (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  lesson_id text not null,
  done_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);
create table public.submissions (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  lesson_id text not null,
  body text not null check (char_length(body) <= 4000),
  feedback text,
  created_at timestamptz not null default now()
);
create index on public.submissions (user_id, lesson_id, created_at desc);
alter table public.progress enable row level security;
alter table public.submissions enable row level security;
create policy "own progress" on public.progress for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own submissions" on public.submissions for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
