-- 0001_foundation
-- Platform foundation: tenants, users, sessions, memberships, schools,
-- platform-level student identity, parent-child links, and audit logs.
--
-- Isolation model:
--   * Migrations run as the database owner.
--   * The API connects as `cos_app`, which is NOT the owner and has no
--     BYPASSRLS, so row-level security (RLS) always applies to it.
--   * Each API request runs in one transaction that first sets
--     transaction-local settings (app.user_id, app.tenant_id, ...).
--     Policies read them through the app.* helper functions below.
--   * cos_app has no DELETE privilege on any table. Removal is done by
--     status changes or anonymization so history is retained.

create extension if not exists citext;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cos_app') then
    create role cos_app nologin;
  end if;
end
$$;

create schema app;

-- ---------------------------------------------------------------------------
-- Request-context helpers
-- ---------------------------------------------------------------------------

create function app.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create function app.current_tenant_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

create function app.is_platform_admin() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.platform_admin', true), '') = 'on'
$$;

-- True when the current user may see every student linked to the current
-- tenant (e.g. Competition Admin). School Admins are school-scoped instead.
create function app.has_tenant_wide_access() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.tenant_wide', true), '') = 'on'
$$;

create function app.current_school_ids() returns uuid[]
language sql stable as $$
  select coalesce(
    string_to_array(nullif(current_setting('app.school_ids', true), ''), ',')::uuid[],
    '{}'::uuid[]
  )
$$;

create function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------

create table tenants (
  id               uuid primary key default gen_random_uuid(),
  slug             citext not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name             text not null check (length(name) between 1 and 200),
  name_i18n        jsonb not null default '{}'::jsonb,
  status           text not null default 'active' check (status in ('active', 'suspended', 'disabled')),
  default_locale   text not null default 'en' check (default_locale in ('en', 'zh-Hant', 'zh-Hans', 'th')),
  timezone         text not null default 'Asia/Hong_Kong',
  country_code     char(2),
  default_currency char(3),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger tenants_touch before update on tenants for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Users (platform-level; one login can be parent, staff in several tenants,
-- or a student)
-- ---------------------------------------------------------------------------

create table users (
  id                uuid primary key default gen_random_uuid(),
  email             citext unique,
  username          citext unique check (username is null or username ~ '^[a-z0-9][a-z0-9._-]{2,39}$'),
  email_verified_at timestamptz,
  password_hash     text not null,
  display_name      text not null check (length(display_name) between 1 and 200),
  locale            text not null default 'en' check (locale in ('en', 'zh-Hant', 'zh-Hans', 'th')),
  status            text not null default 'active' check (status in ('active', 'disabled')),
  platform_role     text check (platform_role in ('platform_admin')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Children may have no email; they sign in with a username instead.
  check (email is not null or username is not null)
);
create trigger users_touch before update on users for each row execute function app.touch_updated_at();

create table sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id),
  token_hash   bytea not null unique,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  ip           inet,
  user_agent   text
);
create index sessions_user_idx on sessions(user_id);

-- ---------------------------------------------------------------------------
-- Schools (tenant-scoped in the MVP)
-- ---------------------------------------------------------------------------

create table schools (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  name         text not null check (length(name) between 1 and 300),
  name_i18n    jsonb not null default '{}'::jsonb,
  country_code char(2),
  external_ref text,
  status       text not null default 'active' check (status in ('active', 'archived')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id)
);
create index schools_tenant_idx on schools(tenant_id);
create trigger schools_touch before update on schools for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Tenant memberships (tenant roles)
-- ---------------------------------------------------------------------------

create table tenant_memberships (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  user_id     uuid not null references users(id),
  role        text not null check (role in ('competition_admin', 'school_admin', 'judge', 'head_judge')),
  school_id   uuid,
  status      text not null default 'active' check (status in ('active', 'revoked')),
  created_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  foreign key (tenant_id, school_id) references schools(tenant_id, id),
  check ((role = 'school_admin') = (school_id is not null))
);
-- One active grant per (tenant, user, role, school).
create unique index tenant_memberships_active_uniq
  on tenant_memberships (tenant_id, user_id, role, coalesce(school_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status = 'active';
create index tenant_memberships_user_idx on tenant_memberships(user_id);

-- ---------------------------------------------------------------------------
-- Students (platform-level identity that persists across tenants and years)
-- ---------------------------------------------------------------------------

create table students (
  id                 uuid primary key default gen_random_uuid(),
  student_code       text not null unique check (student_code ~ '^S[0-9A-HJKMNP-TV-Z]{9}$'),
  user_id            uuid unique references users(id),
  given_name         text check (length(given_name) <= 200),
  family_name        text check (length(family_name) <= 200),
  preferred_name     text check (length(preferred_name) <= 200),
  nickname           text check (length(nickname) <= 60),
  date_of_birth      date,
  primary_locale     text check (primary_locale in ('en', 'zh-Hant', 'zh-Hans', 'th')),
  created_by_user_id uuid references users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  anonymized_at      timestamptz
);
create trigger students_touch before update on students for each row execute function app.touch_updated_at();

create table parent_children (
  parent_user_id uuid not null references users(id),
  student_id     uuid not null references students(id),
  relationship   text not null default 'parent' check (relationship in ('parent', 'guardian')),
  created_at     timestamptz not null default now(),
  primary key (parent_user_id, student_id)
);
create index parent_children_student_idx on parent_children(student_id);

-- Which tenants a student is connected to (via a school roster now, via
-- registrations in a later stage). Tenant staff only ever see students
-- connected to their own tenant.
create table tenant_students (
  tenant_id  uuid not null references tenants(id),
  student_id uuid not null references students(id),
  source     text not null check (source in ('school_roster', 'registration')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, student_id)
);
create index tenant_students_student_idx on tenant_students(student_id);

create table school_students (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  school_id      uuid not null,
  student_id     uuid not null references students(id),
  grade          text check (length(grade) <= 40),
  class_name     text check (length(class_name) <= 40),
  student_number text check (length(student_number) <= 60),
  status         text not null default 'active' check (status in ('active', 'left')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (tenant_id, school_id) references schools(tenant_id, id),
  foreign key (tenant_id, student_id) references tenant_students(tenant_id, student_id),
  unique (school_id, student_id)
);
create index school_students_student_idx on school_students(student_id);
create trigger school_students_touch before update on school_students for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------

create table audit_logs (
  id            uuid primary key default gen_random_uuid(),
  occurred_at   timestamptz not null default now(),
  tenant_id     uuid references tenants(id),
  actor_user_id uuid references users(id),
  action        text not null check (action ~ '^[a-z][a-z0-9_.]{2,99}$'),
  target_type   text,
  target_id     text,
  reason        text,
  before        jsonb,
  after         jsonb,
  metadata      jsonb not null default '{}'::jsonb
);
create index audit_logs_tenant_idx on audit_logs(tenant_id, occurred_at desc);
create index audit_logs_target_idx on audit_logs(target_type, target_id);

create function app.audit_logs_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_logs is append-only';
end
$$;
create trigger audit_logs_no_update before update or delete on audit_logs
  for each statement execute function app.audit_logs_immutable();
create trigger audit_logs_no_truncate before truncate on audit_logs
  for each statement execute function app.audit_logs_immutable();

-- ---------------------------------------------------------------------------
-- Authentication functions (SECURITY DEFINER: run as owner, bypass RLS).
-- They are the only way to read credentials or resolve a session before a
-- user context exists, and they return only what that step needs.
-- ---------------------------------------------------------------------------

create function app.auth_find_login(p_identifier text)
returns table (user_id uuid, password_hash text, status text)
language sql stable security definer set search_path = public, pg_temp as $$
  select u.id, u.password_hash, u.status
  from users u
  where u.email = p_identifier::citext or u.username = p_identifier::citext
  limit 1
$$;

create function app.auth_resolve_session(p_token_hash bytea)
returns table (session_id uuid, user_id uuid, platform_role text, expires_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.id, u.id, u.platform_role, s.expires_at
  from sessions s
  join users u on u.id = s.user_id
  where s.token_hash = p_token_hash
    and s.revoked_at is null
    and s.expires_at > now()
    and u.status = 'active'
$$;

-- Whether a login identifier is taken, without exposing the user row.
create function app.auth_identifier_taken(p_identifier text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from users where email = p_identifier::citext or username = p_identifier::citext)
$$;

-- Look up a user id by email so a tenant admin can grant a role.
-- Returns only the id; profile details stay behind RLS.
create function app.find_user_id_by_email(p_email text) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from users where email = p_email::citext and status = 'active'
$$;

-- Who created a student; used by policies before any link exists.
create function app.student_created_by(p_student_id uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select created_by_user_id from students where id = p_student_id
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table tenants enable row level security;
alter table users enable row level security;
alter table sessions enable row level security;
alter table schools enable row level security;
alter table tenant_memberships enable row level security;
alter table students enable row level security;
alter table parent_children enable row level security;
alter table tenant_students enable row level security;
alter table school_students enable row level security;
alter table audit_logs enable row level security;

-- tenants: visible in the current tenant context, to members, and to platform admins.
create policy tenants_select on tenants for select using (
  app.is_platform_admin()
  or id = app.current_tenant_id()
  or exists (
    select 1 from tenant_memberships m
    where m.tenant_id = tenants.id and m.user_id = app.current_user_id() and m.status = 'active'
  )
);
create policy tenants_insert on tenants for insert with check (app.is_platform_admin());
create policy tenants_update on tenants for update using (app.is_platform_admin()) with check (app.is_platform_admin());

-- users: self, platform admins, and staff of the current tenant viewing members of that tenant.
create policy users_select on users for select using (
  app.is_platform_admin()
  or id = app.current_user_id()
  or exists (
    select 1 from tenant_memberships m
    where m.user_id = users.id and m.tenant_id = app.current_tenant_id()
  )
);
-- Anyone may sign up; nobody can make themselves platform admin (see grants too).
create policy users_insert on users for insert with check (platform_role is null);
create policy users_update on users for update
  using (id = app.current_user_id() or app.is_platform_admin())
  with check (id = app.current_user_id() or app.is_platform_admin());

create policy sessions_select on sessions for select using (user_id = app.current_user_id());
create policy sessions_insert on sessions for insert with check (user_id = app.current_user_id());
create policy sessions_update on sessions for update
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

-- schools: the current tenant only.
create policy schools_all on schools for all
  using (tenant_id = app.current_tenant_id() or app.is_platform_admin())
  with check (tenant_id = app.current_tenant_id() or app.is_platform_admin());

-- memberships: your own (to list your tenants), or the current tenant's.
create policy memberships_select on tenant_memberships for select using (
  user_id = app.current_user_id()
  or tenant_id = app.current_tenant_id()
  or app.is_platform_admin()
);
create policy memberships_insert on tenant_memberships for insert
  with check (tenant_id = app.current_tenant_id() or app.is_platform_admin());
create policy memberships_update on tenant_memberships for update
  using (tenant_id = app.current_tenant_id() or app.is_platform_admin())
  with check (tenant_id = app.current_tenant_id() or app.is_platform_admin());

-- students: the privacy boundary.
--   * the student themself, and their parents (across all tenants)
--   * tenant-wide staff: only students connected to the current tenant
--   * school admins: only students on their own schools' rosters
--   * platform admins
create policy students_select on students for select using (
  app.is_platform_admin()
  or user_id = app.current_user_id()
  or exists (
    select 1 from parent_children pc
    where pc.student_id = students.id and pc.parent_user_id = app.current_user_id()
  )
  or (
    app.has_tenant_wide_access() and exists (
      select 1 from tenant_students ts
      where ts.student_id = students.id and ts.tenant_id = app.current_tenant_id()
    )
  )
  or exists (
    select 1 from school_students ss
    where ss.student_id = students.id
      and ss.tenant_id = app.current_tenant_id()
      and ss.school_id = any (app.current_school_ids())
  )
);
create policy students_insert on students for insert
  with check (created_by_user_id = app.current_user_id() and user_id is null);
create policy students_update on students for update using (
  app.is_platform_admin()
  or exists (
    select 1 from parent_children pc
    where pc.student_id = students.id and pc.parent_user_id = app.current_user_id()
  )
  or exists (
    select 1 from school_students ss
    where ss.student_id = students.id
      and ss.tenant_id = app.current_tenant_id()
      and (app.has_tenant_wide_access() or ss.school_id = any (app.current_school_ids()))
  )
);

-- parent_children: parents see their own links. A parent may link only a
-- student they just created; claiming an existing student is a separate,
-- verified workflow (later stage).
create policy parent_children_select on parent_children for select
  using (parent_user_id = app.current_user_id() or app.is_platform_admin());
create policy parent_children_insert on parent_children for insert with check (
  parent_user_id = app.current_user_id()
  and app.student_created_by(student_id) = app.current_user_id()
);

create policy tenant_students_select on tenant_students for select
  using (tenant_id = app.current_tenant_id() or app.is_platform_admin());
create policy tenant_students_insert on tenant_students for insert
  with check (tenant_id = app.current_tenant_id());

create policy school_students_select on school_students for select using (
  app.is_platform_admin()
  or (
    tenant_id = app.current_tenant_id()
    and (app.has_tenant_wide_access() or school_id = any (app.current_school_ids()))
  )
);
create policy school_students_insert on school_students for insert with check (
  tenant_id = app.current_tenant_id()
  and (app.has_tenant_wide_access() or school_id = any (app.current_school_ids()))
);
create policy school_students_update on school_students for update using (
  tenant_id = app.current_tenant_id()
  and (app.has_tenant_wide_access() or school_id = any (app.current_school_ids()))
);

-- audit_logs: platform admins see all; tenant entries are visible inside the
-- tenant context (the API additionally requires audit.read); users see
-- their own non-tenant entries (e.g. sign-ins).
create policy audit_logs_select on audit_logs for select using (
  app.is_platform_admin()
  or (tenant_id is not null and tenant_id = app.current_tenant_id())
  or (tenant_id is null and actor_user_id = app.current_user_id())
);
create policy audit_logs_insert on audit_logs for insert with check (
  (tenant_id is null or tenant_id = app.current_tenant_id() or app.is_platform_admin())
  and (actor_user_id is null or actor_user_id = app.current_user_id())
);

-- ---------------------------------------------------------------------------
-- Grants for the application role
-- ---------------------------------------------------------------------------

grant usage on schema public, app to cos_app;
grant execute on all functions in schema app to cos_app;

grant select, insert, update on tenants, schools, tenant_memberships, students, school_students, sessions to cos_app;
grant select, insert on parent_children, tenant_students, audit_logs to cos_app;
grant select, insert on users to cos_app;
-- Users may edit their profile but never their platform role; that is set
-- only by the owner-level admin script.
grant update (display_name, locale, password_hash, email, username, email_verified_at, status, updated_at) on users to cos_app;
