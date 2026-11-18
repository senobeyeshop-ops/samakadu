-- Parole — espace administrateur. Idempotent. À exécuter après schema.sql.
-- Toute la protection est dans la base : chaque fonction vérifie is_admin() avant de répondre.

create table if not exists public.admins (
  user_id uuid primary key references auth.users on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists public.admin_log (
  id bigint generated always as identity primary key,
  admin_id uuid not null references auth.users on delete cascade,
  action text not null,
  target_email text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists admin_log_admin_idx on public.admin_log (admin_id);
create index if not exists orders_status_idx on public.orders (status, created_at desc);
alter table public.admins enable row level security;     -- aucune règle : illisible depuis l'API
alter table public.admin_log enable row level security;  -- idem
revoke all on public.admins, public.admin_log from anon, authenticated;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a where a.user_id = (select auth.uid()));
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Tableau de bord : chiffres clés
create or replace function public.admin_overview()
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return json_build_object(
    'users',          (select count(*) from auth.users),
    'users_7d',       (select count(*) from auth.users where created_at > now() - interval '7 days'),
    'premium',        (select count(*) from public.memberships where access_until > now()),
    'revenue_total',  (select coalesce(sum(amount), 0) from public.orders where status = 'paid'),
    'revenue_month',  (select coalesce(sum(amount), 0) from public.orders where status = 'paid' and paid_at >= date_trunc('month', now())),
    'pending',        (select count(*) from public.orders where status = 'pending' and created_at > now() - interval '1 day'),
    'texts_7d',       (select count(*) from public.submissions where created_at > now() - interval '7 days'),
    'coach_today',    (select coalesce(sum(calls), 0) from public.coach_usage where day = current_date),
    'top_lessons',    (select coalesce(json_agg(t), '[]'::json) from (
                         select l.title, count(*) as done from public.progress p join public.lessons l on l.id = p.lesson_id
                         group by l.title order by count(*) desc limit 5) t)
  );
end $$;

-- Liste paginée des apprenants (recherche par e-mail). Une seule requête pour toute la page.
create or replace function public.admin_learners(p_search text default '', p_limit int default 20, p_offset int default 0)
returns json language plpgsql stable security definer set search_path = '' as $$
declare lim int := least(greatest(coalesce(p_limit, 20), 1), 100); off int := greatest(coalesce(p_offset, 0), 0);
        q text := '%' || replace(replace(coalesce(p_search, ''), '%', ''), '_', '') || '%';
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return json_build_object(
    'total', (select count(*) from auth.users u where u.email ilike q),
    'rows', (select coalesce(json_agg(r order by r.created_at desc), '[]'::json) from (
      select u.id, u.email, u.created_at, u.last_sign_in_at, (u.email_confirmed_at is not null) as confirmed,
             m.access_until,
             (select count(*) from public.progress p where p.user_id = u.id) as lessons_done,
             (select count(*) from public.submissions s where s.user_id = u.id) as texts,
             (select max(s.created_at) from public.submissions s where s.user_id = u.id) as last_text
      from auth.users u left join public.memberships m on m.user_id = u.id
      where u.email ilike q
      order by u.created_at desc limit lim offset off) r)
  );
end $$;

create or replace function public.admin_orders(p_limit int default 20, p_offset int default 0)
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return (select coalesce(json_agg(r), '[]'::json) from (
    select o.created_at, u.email, pl.label as plan, o.amount, o.method, o.status, o.paid_at
    from public.orders o join auth.users u on u.id = o.user_id join public.plans pl on pl.id = o.plan_id
    order by o.created_at desc
    limit least(greatest(coalesce(p_limit, 20), 1), 100) offset greatest(coalesce(p_offset, 0), 0)) r);
end $$;

-- Offrir ou retirer le Premium (ex. : membres d'une promotion NECOM payée en espèces)
create or replace function public.admin_set_premium(p_email text, p_days int)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare uid uuid; until timestamptz;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_days is null or p_days < 0 or p_days > 800 then raise exception 'bad days' using errcode = '22023'; end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then return json_build_object('ok', false, 'error', 'Aucun compte avec cet e-mail.'); end if;
  if p_days = 0 then
    update public.memberships set access_until = now(), updated_at = now() where user_id = uid;
    until := now();
  else
    insert into public.memberships (user_id, access_until) values (uid, now() + make_interval(days => p_days))
    on conflict (user_id) do update
      set access_until = greatest(public.memberships.access_until, now()) + make_interval(days => p_days), updated_at = now()
    returning access_until into until;
  end if;
  insert into public.admin_log (admin_id, action, target_email, detail)
  values ((select auth.uid()), case when p_days = 0 then 'revoke_premium' else 'grant_premium' end, lower(trim(p_email)), json_build_object('days', p_days)::jsonb);
  return json_build_object('ok', true, 'until', until);
end $$;

revoke all on function public.admin_overview() from public, anon;
revoke all on function public.admin_learners(text, int, int) from public, anon;
revoke all on function public.admin_orders(int, int) from public, anon;
revoke all on function public.admin_set_premium(text, int) from public, anon;
grant execute on function public.admin_overview(), public.admin_learners(text, int, int),
                          public.admin_orders(int, int), public.admin_set_premium(text, int) to authenticated;
