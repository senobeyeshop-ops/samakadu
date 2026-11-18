-- Parole — schéma Supabase (idempotent : peut être réexécuté).
-- Ordre : schema.sql puis seed.sql.

create extension if not exists pgcrypto;

-- ───────────── Catalogue ─────────────
create table if not exists public.modules (
  id text primary key check (id ~ '^[a-z]{1,8}$'),
  name text not null,
  intro text not null,
  color text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  coach_angle text not null,            -- consigne donnée au coach IA pour ce module
  position int not null default 0
);

create table if not exists public.lessons (
  id text primary key check (id ~ '^[a-z]{1,8}[0-9]{1,2}$'),
  module_id text not null references public.modules on delete cascade,
  position int not null,
  title text not null,
  premium boolean not null default true,
  duration_sec int check (duration_sec between 15 and 900)   -- exercice chronométré (facultatif)
);
create index if not exists lessons_module_idx on public.lessons (module_id, position);

-- Le contenu est séparé du titre : on peut afficher le catalogue sans révéler le contenu payant.
create table if not exists public.lesson_content (
  lesson_id text primary key references public.lessons on delete cascade,
  body jsonb not null check (jsonb_typeof(body) = 'array'),
  task text not null
);

-- ───────────── Offres, commandes, abonnements ─────────────
create table if not exists public.plans (
  id text primary key,
  label text not null,
  amount int not null check (amount between 100 and 5000000),   -- FCFA, sans décimales
  days int not null check (days between 1 and 800),
  active boolean not null default true,
  position int not null default 0
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  plan_id text not null references public.plans,
  amount int not null check (amount > 0),
  currency text not null default 'XOF',
  provider text not null check (provider in ('wave','paytech')),
  method text not null check (method in ('wave','orange_money')),
  status text not null default 'pending' check (status in ('pending','paid','failed','expired')),
  provider_ref text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists orders_user_idx on public.orders (user_id, created_at desc);
create index if not exists orders_plan_idx on public.orders (plan_id);
create unique index if not exists orders_provider_ref_uq on public.orders (provider, provider_ref) where provider_ref is not null;

create table if not exists public.memberships (
  user_id uuid primary key references auth.users on delete cascade,
  access_until timestamptz not null,
  updated_at timestamptz not null default now()
);

-- ───────────── Activité des apprenants ─────────────
create table if not exists public.progress (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  lesson_id text not null,
  done_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);

create table if not exists public.submissions (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  lesson_id text not null,
  body text not null check (char_length(body) <= 4000),
  feedback text check (char_length(feedback) <= 4000),
  created_at timestamptz not null default now()
);
create index if not exists submissions_user_lesson_idx on public.submissions (user_id, lesson_id, created_at desc);
create index if not exists submissions_lesson_idx on public.submissions (lesson_id);
create index if not exists progress_lesson_idx on public.progress (lesson_id);

create table if not exists public.coach_usage (
  user_id uuid not null references auth.users on delete cascade,
  day date not null default current_date,
  calls int not null default 0,
  primary key (user_id, day)
);
create index if not exists coach_usage_day_idx on public.coach_usage (day);

-- Rattacher progression et textes aux leçons (ajouté seulement s'il n'existe pas)
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'progress_lesson_fk') then
    alter table public.progress add constraint progress_lesson_fk foreign key (lesson_id) references public.lessons on delete cascade not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'submissions_lesson_fk') then
    alter table public.submissions add constraint submissions_lesson_fk foreign key (lesson_id) references public.lessons on delete cascade not valid;
  end if;
end $$;

-- ───────────── Fonctions ─────────────
create or replace function public.has_premium()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m
                 where m.user_id = (select auth.uid()) and m.access_until > now());
$$;
revoke all on function public.has_premium() from public, anon;
grant execute on function public.has_premium() to authenticated;

-- Statut d'abonnement de l'utilisateur connecté
create or replace function public.my_access()
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('premium', coalesce(m.access_until > now(), false), 'until', m.access_until)
  from (select 1) x left join public.memberships m on m.user_id = (select auth.uid());
$$;
revoke all on function public.my_access() from public, anon;
grant execute on function public.my_access() to authenticated;

-- Crée une commande : le montant vient TOUJOURS de la table plans, jamais du navigateur.
create or replace function public.create_order(p_plan text, p_method text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  pl public.plans;
  recent int;
  o public.orders;
begin
  if uid is null then raise exception 'auth required' using errcode = '28000'; end if;
  if p_method not in ('wave','orange_money') then raise exception 'bad method' using errcode = '22023'; end if;
  select * into pl from public.plans where id = p_plan and active;
  if not found then raise exception 'unknown plan' using errcode = '22023'; end if;
  select count(*) into recent from public.orders
    where user_id = uid and created_at > now() - interval '1 hour';
  if recent >= 6 then raise exception 'too many orders' using errcode = '54000'; end if;
  insert into public.orders (user_id, plan_id, amount, provider, method)
  values (uid, pl.id, pl.amount, case when p_method = 'wave' then 'wave' else 'paytech' end, p_method)
  returning * into o;
  return json_build_object('id', o.id, 'amount', o.amount, 'label', pl.label, 'provider', o.provider);
end $$;
revoke all on function public.create_order(text, text) from public, anon;
grant execute on function public.create_order(text, text) to authenticated;

-- Valide un paiement (appelée uniquement par le serveur avec la clé de service). Idempotente.
create or replace function public.mark_order_paid(p_order uuid, p_amount int, p_provider_ref text)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  o public.orders;
  d int;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then return 'not_found'; end if;
  if o.status = 'paid' then return 'already_paid'; end if;
  if o.amount <> p_amount then
    update public.orders set status = 'failed' where id = o.id;
    return 'amount_mismatch';
  end if;
  select days into d from public.plans where id = o.plan_id;
  update public.orders set status = 'paid', paid_at = now(),
         provider_ref = coalesce(p_provider_ref, provider_ref)
   where id = o.id;
  insert into public.memberships (user_id, access_until) values (o.user_id, now() + make_interval(days => d))
  on conflict (user_id) do update
    set access_until = greatest(public.memberships.access_until, now()) + make_interval(days => d),
        updated_at = now();
  return 'paid';
end $$;
revoke all on function public.mark_order_paid(uuid, int, text) from public, anon, authenticated;
grant execute on function public.mark_order_paid(uuid, int, text) to service_role;

create or replace function public.mark_order_failed(p_order uuid)
returns void language sql volatile security definer set search_path = '' as $$
  update public.orders set status = 'failed' where id = p_order and status = 'pending';
$$;
revoke all on function public.mark_order_failed(uuid) from public, anon, authenticated;
grant execute on function public.mark_order_failed(uuid) to service_role;

-- Quota du coach : 3 retours/jour en gratuit, 15 en premium, 300/jour au total.
create or replace function public.consume_coach_credit()
returns json language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  per_user int;
  global_cap constant int := 300;
  total int;
  n int;
begin
  if uid is null then return json_build_object('ok', false, 'reason', 'auth'); end if;
  per_user := case when public.has_premium() then 15 else 3 end;
  select coalesce(sum(calls), 0) into total from public.coach_usage where day = current_date;
  if total >= global_cap then return json_build_object('ok', false, 'reason', 'global'); end if;
  insert into public.coach_usage (user_id, day, calls) values (uid, current_date, 1)
  on conflict (user_id, day) do update set calls = public.coach_usage.calls + 1
  returning calls into n;
  if n > per_user then
    update public.coach_usage set calls = calls - 1 where user_id = uid and day = current_date;
    return json_build_object('ok', false, 'reason', case when per_user = 3 then 'free' else 'user' end);
  end if;
  return json_build_object('ok', true, 'remaining', per_user - n);
end $$;
revoke all on function public.consume_coach_credit() from public, anon;
grant execute on function public.consume_coach_credit() to authenticated;

-- ───────────── Règles d'accès (RLS) ─────────────
alter table public.modules        enable row level security;
alter table public.lessons        enable row level security;
alter table public.lesson_content enable row level security;
alter table public.plans          enable row level security;
alter table public.orders         enable row level security;
alter table public.memberships    enable row level security;
alter table public.progress       enable row level security;
alter table public.submissions    enable row level security;
alter table public.coach_usage    enable row level security;

drop policy if exists "own progress"    on public.progress;
drop policy if exists "own submissions" on public.submissions;

drop policy if exists modules_read on public.modules;
create policy modules_read on public.modules for select to authenticated using (true);
drop policy if exists lessons_read on public.lessons;
create policy lessons_read on public.lessons for select to authenticated using (true);
drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans for select to anon, authenticated using (active);

-- Contenu : leçons gratuites pour tous les inscrits, leçons premium pour les abonnés seulement
drop policy if exists lesson_content_read on public.lesson_content;
create policy lesson_content_read on public.lesson_content for select to authenticated using (
  exists (select 1 from public.lessons l where l.id = lesson_id and (not l.premium or (select public.has_premium())))
);

drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists progress_select on public.progress;
drop policy if exists progress_insert on public.progress;
drop policy if exists progress_delete on public.progress;
create policy progress_select on public.progress for select to authenticated using ((select auth.uid()) = user_id);
create policy progress_insert on public.progress for insert to authenticated with check ((select auth.uid()) = user_id);
create policy progress_delete on public.progress for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists submissions_select on public.submissions;
drop policy if exists submissions_insert on public.submissions;
drop policy if exists submissions_delete on public.submissions;
create policy submissions_select on public.submissions for select to authenticated using ((select auth.uid()) = user_id);
create policy submissions_insert on public.submissions for insert to authenticated with check ((select auth.uid()) = user_id);
create policy submissions_delete on public.submissions for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists coach_usage_select on public.coach_usage;
create policy coach_usage_select on public.coach_usage for select to authenticated using ((select auth.uid()) = user_id);
-- Aucune règle d'écriture sur orders, memberships, coach_usage, catalogue : seules les fonctions ci-dessus écrivent.

-- Droits explicites (au cas où les droits par défaut du projet seraient restreints)
grant usage on schema public to anon, authenticated;
grant select on public.plans to anon, authenticated;
grant select on public.modules, public.lessons, public.lesson_content, public.orders,
                public.memberships, public.coach_usage to authenticated;
grant select, insert, delete on public.progress, public.submissions to authenticated;
revoke insert, update, delete on public.modules, public.lessons, public.lesson_content, public.plans,
                public.orders, public.memberships, public.coach_usage from anon, authenticated;
revoke all on public.progress, public.submissions from anon;
drop index if exists public.submissions_user_id_lesson_id_created_at_idx;

-- Rend un crédit du coach quand il n'a pas pu répondre (serveur uniquement)
create or replace function public.refund_coach_credit(p_user uuid)
returns void language sql volatile security definer set search_path = '' as $$
  update public.coach_usage set calls = calls - 1
  where user_id = p_user and day = current_date and calls > 0;
$$;
revoke all on function public.refund_coach_credit(uuid) from public, anon, authenticated;
grant execute on function public.refund_coach_credit(uuid) to service_role;
