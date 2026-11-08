-- 0003_content
-- Content engine: skill frameworks, content banks, learning objectives,
-- items (the editable working set), translations kept apart from items,
-- immutable published Content Bank Versions, and Excel import batches.
--
-- Competitions never copy questions. A round-group references a published
-- content_bank_versions.id; that version's item snapshots never change.

-- ---------------------------------------------------------------------------
-- Skill frameworks (configurable per tenant, hierarchical)
-- ---------------------------------------------------------------------------

create table skill_frameworks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  key         citext not null check (key ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  name        text not null check (length(name) between 1 and 200),
  name_i18n   jsonb not null default '{}'::jsonb,
  status      text not null default 'active' check (status in ('active', 'archived')),
  created_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, key),
  unique (tenant_id, id)
);
create trigger skill_frameworks_touch before update on skill_frameworks for each row execute function app.touch_updated_at();

create table skills (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  framework_id     uuid not null,
  parent_id        uuid,
  key              citext not null check (key ~ '^[a-z0-9][a-z0-9_.-]{0,59}$'),
  name             text not null check (length(name) between 1 and 200),
  name_i18n        jsonb not null default '{}'::jsonb,
  description_i18n jsonb not null default '{}'::jsonb,
  sort_order       int not null default 0,
  status           text not null default 'active' check (status in ('active', 'archived')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (tenant_id, framework_id) references skill_frameworks(tenant_id, id),
  unique (framework_id, key),
  unique (framework_id, id),
  foreign key (framework_id, parent_id) references skills(framework_id, id),
  check (parent_id is null or parent_id <> id)
);
create index skills_framework_idx on skills(framework_id);
create trigger skills_touch before update on skills for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Content banks
-- ---------------------------------------------------------------------------

create table content_banks (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id),
  key                citext not null check (key ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  name               text not null check (length(name) between 1 and 200),
  name_i18n          jsonb not null default '{}'::jsonb,
  description_i18n   jsonb not null default '{}'::jsonb,
  base_locale        text not null check (base_locale in ('en', 'zh-Hant', 'zh-Hans', 'th')),
  -- Locales every published item must have an approved, current translation for.
  required_locales   text[] not null default '{}' check (required_locales <@ array['en', 'zh-Hant', 'zh-Hans', 'th']::text[]),
  skill_framework_id uuid,
  status             text not null default 'active' check (status in ('active', 'archived')),
  created_by         uuid references users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, key),
  unique (tenant_id, id),
  foreign key (tenant_id, skill_framework_id) references skill_frameworks(tenant_id, id)
);
create trigger content_banks_touch before update on content_banks for each row execute function app.touch_updated_at();

create table learning_objectives (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  bank_id     uuid not null,
  key         citext not null check (key ~ '^[a-z0-9][a-z0-9_.-]{0,59}$'),
  title       text not null check (length(title) between 1 and 500),
  title_i18n  jsonb not null default '{}'::jsonb,
  skill_ids   uuid[] not null default '{}',
  status      text not null default 'active' check (status in ('active', 'archived')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (tenant_id, bank_id) references content_banks(tenant_id, id),
  unique (bank_id, key),
  unique (tenant_id, id)
);
create trigger learning_objectives_touch before update on learning_objectives for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Items: the editable working set of a bank
-- ---------------------------------------------------------------------------

create table content_items (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  bank_id           uuid not null,
  external_key      citext not null,
  content_type      text not null check (content_type in (
                      'single_choice', 'multiple_choice', 'true_false', 'matching', 'ordering', 'image_choice',
                      'audio_choice', 'listen_select', 'text_input', 'fill_blank', 'pronunciation', 'drag_drop', 'custom')),
  base_locale       text not null check (base_locale in ('en', 'zh-Hant', 'zh-Hans', 'th')),
  difficulty        text not null check (difficulty in ('easy', 'medium', 'hard', 'expert')),
  points            numeric(10, 3) not null check (points > 0),
  category          text,
  tags              text[] not null default '{}',
  explanation       text,
  explanation_media jsonb not null default '[]'::jsonb,
  source_reference  text,
  -- Skill and objective ids are checked against the tenant by the API on
  -- every save and again at publish (arrays, because cos_app cannot DELETE
  -- join-table rows).
  skill_ids         uuid[] not null default '{}',
  objective_ids     uuid[] not null default '{}',
  body              jsonb not null,
  status            text not null default 'draft' check (status in ('draft', 'ready', 'retired')),
  revision          int not null default 1,
  created_by        uuid references users(id),
  updated_by        uuid references users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (tenant_id, bank_id) references content_banks(tenant_id, id),
  unique (bank_id, external_key),
  unique (tenant_id, id)
);
create index content_items_bank_idx on content_items(bank_id, status);
create trigger content_items_touch before update on content_items for each row execute function app.touch_updated_at();

create table content_item_translations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  item_id     uuid not null,
  locale      text not null check (locale in ('en', 'zh-Hant', 'zh-Hans', 'th')),
  strings     jsonb not null,
  -- Hash of the base strings this translation was made from; differs from
  -- the item's current hash when the source text has changed (stale).
  source_hash text not null,
  status      text not null default 'draft' check (status in ('draft', 'approved')),
  updated_by  uuid references users(id),
  approved_by uuid references users(id),
  approved_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (tenant_id, item_id) references content_items(tenant_id, id),
  unique (item_id, locale)
);
create trigger content_item_translations_touch before update on content_item_translations for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Published Content Bank Versions (immutable)
-- ---------------------------------------------------------------------------

create table content_bank_versions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  bank_id        uuid not null,
  version_number int not null check (version_number >= 1),
  item_count     int not null,
  summary        jsonb not null,
  note           text,
  published_by   uuid references users(id),
  published_at   timestamptz not null default now(),
  foreign key (tenant_id, bank_id) references content_banks(tenant_id, id),
  unique (bank_id, version_number),
  unique (tenant_id, id)
);

create table content_version_items (
  tenant_id    uuid not null,
  version_id   uuid not null,
  item_id      uuid not null,
  external_key citext not null,
  content_type text not null,
  difficulty   text not null,
  category     text,
  tags         text[] not null,
  -- Base locale plus locales with an approved, current translation.
  locales      text[] not null,
  -- Full item, approved translations, and skill/objective keys at publish time.
  snapshot     jsonb not null,
  primary key (version_id, item_id),
  foreign key (tenant_id, version_id) references content_bank_versions(tenant_id, id),
  foreign key (tenant_id, item_id) references content_items(tenant_id, id)
);
create index content_version_items_type_idx on content_version_items(version_id, content_type);

create function app.content_versions_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'published content versions cannot be changed';
end
$$;
create trigger content_bank_versions_immutable before update or delete on content_bank_versions
  for each statement execute function app.content_versions_immutable();
create trigger content_version_items_immutable before update or delete on content_version_items
  for each statement execute function app.content_versions_immutable();

-- ---------------------------------------------------------------------------
-- Excel imports: validate → preview → commit
-- ---------------------------------------------------------------------------

create table content_imports (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  bank_id      uuid not null,
  filename     text,
  status       text not null check (status in ('validated', 'rejected', 'committed')),
  row_count    int not null,
  rows         jsonb not null,
  errors       jsonb not null,
  summary      jsonb not null,
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  committed_by uuid references users(id),
  committed_at timestamptz,
  foreign key (tenant_id, bank_id) references content_banks(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Row-level security: every content table is tenant-scoped
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['skill_frameworks', 'skills', 'content_banks', 'learning_objectives', 'content_items',
                           'content_item_translations', 'content_bank_versions', 'content_version_items', 'content_imports']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id())',
      t || '_tenant', t);
  end loop;
end
$$;

grant select, insert, update on skill_frameworks, skills, content_banks, learning_objectives, content_items,
  content_item_translations, content_imports to cos_app;
grant select, insert on content_bank_versions, content_version_items to cos_app;
