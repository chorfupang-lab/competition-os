-- 0007_passport_ai
-- Learning Passport and AI: voice recordings with retention, the AI job
-- queue, AI usage and cost, pronunciation assessments, validated AI feedback,
-- per-skill observations, and practice sets.
--
-- AI never decides official outcomes: pronunciation assessments produce a
-- SUGGESTED grade that a judge confirms for official attempts.

alter table content_banks add column practice_enabled boolean not null default false;

alter table competitions
  -- Raw voice is deleted right after analysis unless the organizer keeps it (30 or 90 days).
  add column voice_retention_days int not null default 0 check (voice_retention_days in (0, 30, 90)),
  add column passport_comparisons text[] not null default '{group_average,percentile,previous_attempt}'
    check (passport_comparisons <@ array['group_average', 'age_benchmark', 'percentile', 'previous_attempt']::text[]),
  add column ai_feedback_enabled boolean not null default true;

-- ---------------------------------------------------------------------------
-- Practice sets (never part of official results)
-- ---------------------------------------------------------------------------

create table practice_sets (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id),
  student_id         uuid not null references students(id),
  created_by_user_id uuid not null references users(id),
  content_version_id uuid not null,
  target_skill_ids   uuid[] not null default '{}',
  locale             text not null,
  question_set       jsonb not null,
  answers            jsonb not null default '{}'::jsonb,
  grades             jsonb not null default '{}'::jsonb,
  score              jsonb,
  status             text not null default 'open' check (status in ('open', 'submitted')),
  created_at         timestamptz not null default now(),
  submitted_at       timestamptz,
  foreign key (tenant_id, content_version_id) references content_bank_versions(tenant_id, id),
  unique (tenant_id, id)
);
create index practice_sets_student_idx on practice_sets(student_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Recordings and retention
-- ---------------------------------------------------------------------------

create table recordings (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id),
  attempt_id       uuid,
  practice_set_id  uuid,
  item_id          uuid not null,
  student_id       uuid not null references students(id),
  storage_key      text not null,
  mime_type        text not null,
  bytes            int not null check (bytes > 0),
  status           text not null default 'stored' check (status in ('stored', 'deleted')),
  retain_until     timestamptz,
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  deleted_reason   text,
  foreign key (tenant_id, attempt_id) references attempts(tenant_id, id),
  foreign key (tenant_id, practice_set_id) references practice_sets(tenant_id, id),
  check ((attempt_id is null) <> (practice_set_id is null)),
  unique (tenant_id, id)
);
create index recordings_retention_idx on recordings(retain_until) where status = 'stored';

-- ---------------------------------------------------------------------------
-- AI job queue
-- ---------------------------------------------------------------------------

create table ai_jobs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  competition_id uuid,
  kind           text not null check (kind in ('pronunciation', 'feedback')),
  dedupe_key     text not null unique,
  payload        jsonb not null,
  status         text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),
  attempts       int not null default 0,
  max_attempts   int not null default 5,
  run_after      timestamptz not null default now(),
  locked_until   timestamptz,
  result         jsonb,
  last_error     text,
  provider       text,
  model          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  finished_at    timestamptz
);
create index ai_jobs_due_idx on ai_jobs(run_after) where status in ('pending', 'running');
create trigger ai_jobs_touch before update on ai_jobs for each row execute function app.touch_updated_at();

create table ai_usage (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  competition_id uuid,
  job_id         uuid references ai_jobs(id),
  kind           text not null,
  provider       text not null,
  model          text,
  units          jsonb not null,
  -- Estimated cost in millionths of a US dollar.
  cost_micros    bigint not null default 0,
  created_at     timestamptz not null default now()
);
create index ai_usage_tenant_idx on ai_usage(tenant_id, created_at);

-- ---------------------------------------------------------------------------
-- AI results
-- ---------------------------------------------------------------------------

create table pronunciation_assessments (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id),
  recording_id       uuid not null,
  attempt_id         uuid,
  practice_set_id    uuid,
  competition_id     uuid,
  round_id           uuid,
  group_id           uuid,
  item_id            uuid not null,
  student_id         uuid not null references students(id),
  speech_language    text not null,
  provider           text not null,
  model              text,
  overall            numeric(6, 2) not null,
  aspects            jsonb not null,
  units              jsonb not null,
  suggested_fraction numeric(6, 4) not null,
  created_at         timestamptz not null default now(),
  foreign key (tenant_id, recording_id) references recordings(tenant_id, id)
);
create index pronunciation_assessments_student_idx on pronunciation_assessments(student_id, created_at);
create index pronunciation_assessments_cohort_idx on pronunciation_assessments(competition_id, round_id, group_id);

create table ai_feedback (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  attempt_id      uuid,
  practice_set_id uuid,
  student_id      uuid not null references students(id),
  locale          text not null,
  source          text not null check (source in ('ai', 'fallback')),
  feedback        jsonb not null,
  reasons         jsonb not null default '[]'::jsonb,
  provider        text not null,
  model           text,
  created_at      timestamptz not null default now(),
  check ((attempt_id is null) <> (practice_set_id is null))
);
create unique index ai_feedback_attempt on ai_feedback(attempt_id) where attempt_id is not null;
create unique index ai_feedback_practice on ai_feedback(practice_set_id) where practice_set_id is not null;

-- ---------------------------------------------------------------------------
-- Learning Passport: per-skill evidence from attempts and practice
-- ---------------------------------------------------------------------------

create table skill_observations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  student_id      uuid not null references students(id),
  skill_id        uuid not null,
  attempt_id      uuid,
  practice_set_id uuid,
  competition_id  uuid,
  source          text not null check (source in ('official', 'practice')),
  correct         numeric(10, 4) not null,
  total           numeric(10, 4) not null check (total > 0),
  observed_at     timestamptz not null,
  check ((attempt_id is null) <> (practice_set_id is null))
);
-- Re-scoring replaces an attempt's observations in place.
create unique index skill_observations_source on skill_observations(coalesce(attempt_id, practice_set_id), skill_id);
create index skill_observations_student_idx on skill_observations(student_id, observed_at);

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- Worker: lease due jobs across tenants (expired leases are re-claimed).
create function app.claim_ai_jobs(p_limit int, p_lease_seconds int) returns table (id uuid, tenant_id uuid, kind text)
language sql volatile security definer set search_path = public, pg_temp as $$
  update ai_jobs j set status = 'running', attempts = j.attempts + 1, locked_until = now() + make_interval(secs => p_lease_seconds)
  where j.id in (
    select id from ai_jobs
    where (status = 'pending' and run_after <= now()) or (status = 'running' and locked_until < now())
    order by run_after
    limit p_limit
    for update skip locked
  )
  returning j.id, j.tenant_id, j.kind
$$;

create function app.expired_recordings(p_limit int) returns table (id uuid, tenant_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, tenant_id from recordings where status = 'stored' and retain_until is not null and retain_until < now() limit p_limit
$$;

-- Skill names for a family's Passport (skills live in each organizer's framework).
create function app.skill_labels(p_ids uuid[]) returns table (id uuid, key text, name text, name_i18n jsonb, framework_key text, framework_name text, tenant_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.id, s.key::text, s.name, s.name_i18n, f.key::text, f.name, s.tenant_id
  from skills s join skill_frameworks f on f.id = s.framework_id where s.id = any(p_ids)
$$;

-- Aggregated, privacy-safe cohort statistics for one published result version.
-- Returns counts and averages only; callers hide them below the minimum cohort size.
create function app.result_cohort_stats(p_version_id uuid, p_score numeric, p_student_id uuid)
returns table (cohort int, average numeric, at_or_below int, age_cohort int, age_average numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  with v as (select id from result_versions where id = p_version_id and status in ('published', 'superseded')),
  e as (select e.total_score, s.date_of_birth from result_entries e join v on v.id = e.result_version_id join students s on s.id = e.student_id where e.status = 'ok'),
  me as (select date_of_birth from students where id = p_student_id)
  select count(*)::int, avg(total_score), count(*) filter (where total_score <= p_score)::int,
         count(*) filter (where extract(year from e.date_of_birth) = extract(year from (select date_of_birth from me)))::int,
         avg(total_score) filter (where extract(year from e.date_of_birth) = extract(year from (select date_of_birth from me)))
  from e
$$;

create function app.pronunciation_cohort(p_competition_id uuid, p_round_id uuid, p_group_id uuid)
returns table (cohort int, aspects jsonb, overall numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  with a as (
    select distinct on (student_id) student_id, aspects, overall from pronunciation_assessments
    where competition_id = p_competition_id and round_id = p_round_id and group_id = p_group_id
    order by student_id, created_at desc
  ),
  kv as (select key, avg((value)::numeric) as v from a, jsonb_each_text(a.aspects) group by key)
  select (select count(*)::int from a), coalesce((select jsonb_object_agg(key, round(v, 1)) from kv), '{}'::jsonb), (select avg(overall) from a)
$$;

-- Practice items: latest published version of each practice-enabled bank in tenants the student belongs to.
create function app.practice_pool(p_student_id uuid)
returns table (tenant_id uuid, version_id uuid, item_id uuid, external_key text, content_type text, skill_ids jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  with latest as (
    select distinct on (v.bank_id) v.id, v.tenant_id
    from content_bank_versions v join content_banks b on b.id = v.bank_id
    where b.practice_enabled and b.status = 'active'
      and exists (select 1 from tenant_students ts where ts.tenant_id = v.tenant_id and ts.student_id = p_student_id)
    order by v.bank_id, v.version_number desc
  )
  select l.tenant_id, l.id, i.item_id, i.external_key::text, i.content_type, i.snapshot->'item'->'skillIds'
  from latest l join content_version_items i on i.version_id = l.id
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['recordings', 'ai_jobs', 'ai_usage']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for all using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id())', t || '_tenant', t);
  end loop;
  -- Families read their own Passport data across organizers.
  foreach t in array array['practice_sets', 'pronunciation_assessments', 'ai_feedback', 'skill_observations']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select using (tenant_id = app.current_tenant_id() or app.is_me_or_my_child(student_id))', t || '_select', t);
    execute format('create policy %I on %I for insert with check (tenant_id = app.current_tenant_id())', t || '_insert', t);
    execute format('create policy %I on %I for update using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id())', t || '_update', t);
  end loop;
end
$$;

grant select, insert, update on practice_sets, recordings, ai_jobs, pronunciation_assessments, ai_feedback, skill_observations to cos_app;
grant select, insert on ai_usage to cos_app;
grant execute on all functions in schema app to cos_app;
