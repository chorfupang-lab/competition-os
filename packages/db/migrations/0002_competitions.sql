-- 0002_competitions
-- Competitions and their versioned configurations, plus competition-scoped
-- memberships ("Competition Organizer: that competition only").
--
-- A competition's rounds, groups and per-round-group rules live in a
-- versioned configuration document (competition_versions.config), validated
-- by packages/core. Round and group ids inside it are stable across versions.
-- A published version is immutable (enforced by trigger, not only the API).

create table competitions (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id),
  slug               citext not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name               text not null check (length(name) between 1 and 300),
  name_i18n          jsonb not null default '{}'::jsonb,
  description_i18n   jsonb not null default '{}'::jsonb,
  status             text not null default 'draft' check (status in ('draft', 'published', 'cancelled', 'archived')),
  visibility         text not null default 'public' check (visibility in ('public', 'unlisted', 'private')),
  fee_mode           text not null check (fee_mode in ('free', 'paid')),
  -- Fixed per competition; no dynamic FX. Locked once first published (API rule).
  currency           char(3) check (currency ~ '^[A-Z]{3}$'),
  timezone           text not null,
  interface_locales  text[] not null default '{en}',
  content_locales    text[] not null default '{en}',
  current_version_id uuid,
  created_by         uuid references users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  first_published_at timestamptz,
  cancelled_at       timestamptz,
  unique (tenant_id, slug),
  unique (tenant_id, id),
  check (fee_mode = 'free' or currency is not null),
  check (interface_locales <@ array['en', 'zh-Hant', 'zh-Hans', 'th']::text[] and cardinality(interface_locales) > 0),
  check (content_locales <@ array['en', 'zh-Hant', 'zh-Hans', 'th']::text[] and cardinality(content_locales) > 0)
);
create index competitions_tenant_idx on competitions(tenant_id);
create trigger competitions_touch before update on competitions for each row execute function app.touch_updated_at();

create table competition_versions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  competition_id uuid not null,
  version_number int not null check (version_number >= 1),
  status         text not null default 'draft' check (status in ('draft', 'published', 'superseded')),
  config         jsonb not null,
  -- Bumped on every draft save; clients send it back to avoid overwriting each other.
  revision       int not null default 1,
  change_note    text,
  created_by     uuid references users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  published_at   timestamptz,
  published_by   uuid references users(id),
  foreign key (tenant_id, competition_id) references competitions(tenant_id, id),
  unique (competition_id, version_number),
  unique (competition_id, id)
);
create unique index competition_versions_one_draft on competition_versions(competition_id) where status = 'draft';
create unique index competition_versions_one_published on competition_versions(competition_id) where status = 'published';
create trigger competition_versions_touch before update on competition_versions for each row execute function app.touch_updated_at();

alter table competitions
  add constraint competitions_current_version_fk
  foreign key (id, current_version_id) references competition_versions(competition_id, id)
  deferrable initially deferred;

-- Published and superseded versions are frozen. Allowed transitions:
-- draft → published → superseded. Nothing returns to draft.
create function app.competition_versions_guard() returns trigger
language plpgsql as $$
begin
  if old.status <> 'draft' then
    if new.config is distinct from old.config
       or new.version_number <> old.version_number
       or new.competition_id <> old.competition_id
       or new.tenant_id <> old.tenant_id
       or new.change_note is distinct from old.change_note
       or new.published_at is distinct from old.published_at
       or new.published_by is distinct from old.published_by then
      raise exception 'competition version % is % and cannot be changed', old.id, old.status;
    end if;
    if not (old.status = new.status or (old.status = 'published' and new.status = 'superseded')) then
      raise exception 'invalid version status change % -> %', old.status, new.status;
    end if;
  end if;
  return new;
end
$$;
create trigger competition_versions_guard before update on competition_versions
  for each row execute function app.competition_versions_guard();

-- ---------------------------------------------------------------------------
-- Competition-scoped memberships
-- ---------------------------------------------------------------------------

alter table tenant_memberships add column competition_id uuid;
alter table tenant_memberships
  add constraint tenant_memberships_competition_fk
  foreign key (tenant_id, competition_id) references competitions(tenant_id, id);
alter table tenant_memberships
  add constraint tenant_memberships_competition_scope_check
  check (competition_id is null or role in ('competition_admin', 'judge', 'head_judge'));

drop index tenant_memberships_active_uniq;
create unique index tenant_memberships_active_uniq
  on tenant_memberships (
    tenant_id, user_id, role,
    coalesce(school_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(competition_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status = 'active';

-- ---------------------------------------------------------------------------
-- Public catalog helpers (SECURITY DEFINER: tenants are not readable anonymously)
-- ---------------------------------------------------------------------------

create function app.tenant_is_active(p_tenant_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from tenants where id = p_tenant_id and status = 'active')
$$;

-- Organizer name and slug for catalog listings; nothing else about the tenant.
create function app.tenant_public_profile(p_tenant_id uuid)
returns table (slug citext, name text, name_i18n jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select slug, name, name_i18n from tenants where id = p_tenant_id and status = 'active'
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table competitions enable row level security;
alter table competition_versions enable row level security;

-- Published public/unlisted competitions are readable by anyone (the catalog);
-- everything else only inside the owning tenant.
create policy competitions_select on competitions for select using (
  app.is_platform_admin()
  or tenant_id = app.current_tenant_id()
  or (status = 'published' and visibility in ('public', 'unlisted') and app.tenant_is_active(tenant_id))
);
create policy competitions_insert on competitions for insert
  with check (tenant_id = app.current_tenant_id());
create policy competitions_update on competitions for update
  using (tenant_id = app.current_tenant_id() or app.is_platform_admin())
  with check (tenant_id = app.current_tenant_id() or app.is_platform_admin());

-- Outside the tenant, only the current published version of a visible competition.
create policy competition_versions_select on competition_versions for select using (
  app.is_platform_admin()
  or tenant_id = app.current_tenant_id()
  or (
    status = 'published' and exists (
      select 1 from competitions c
      where c.id = competition_versions.competition_id
        and c.current_version_id = competition_versions.id
        and c.status = 'published'
        and c.visibility in ('public', 'unlisted')
        and app.tenant_is_active(c.tenant_id)
    )
  )
);
create policy competition_versions_insert on competition_versions for insert
  with check (tenant_id = app.current_tenant_id());
create policy competition_versions_update on competition_versions for update
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());

grant execute on function app.tenant_is_active(uuid), app.tenant_public_profile(uuid) to cos_app;
grant select, insert, update on competitions, competition_versions to cos_app;
