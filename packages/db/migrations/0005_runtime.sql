-- 0005_runtime
-- Competition runtime: attempts with server-authoritative deadlines, device
-- sessions, autosaved answers, integrity events, risk cases, and make-up
-- grants.
--
-- Participants (students, or parents for young children) are authorized by
-- the API in their personal context; the runtime then acts as the system
-- inside the competition's tenant. RLS lets participants read their own
-- attempts directly, and confines everything to the tenant.

create table attempts (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null,
  competition_id         uuid not null,
  competition_version_id uuid not null,
  round_id               uuid not null,
  group_id               uuid not null,
  registration_id        uuid not null,
  student_id             uuid not null references students(id),
  started_by_user_id     uuid not null references users(id),
  attempt_number         int not null check (attempt_number >= 1),
  kind                   text not null check (kind in ('official', 'practice')),
  status                 text not null check (status in ('in_progress', 'paused', 'submitted', 'invalidated')),
  content_version_id     uuid not null,
  content_locale         text not null,
  -- Seed of the deterministic question/option order; the frozen question set.
  seed                   text not null,
  question_set           jsonb not null,
  started_at             timestamptz not null,
  deadline_at            timestamptz not null,
  extension_seconds      int not null default 0,
  submitted_at           timestamptz,
  submit_reason          text check (submit_reason in ('participant', 'time_up', 'integrity_policy', 'admin')),
  score                  jsonb,
  score_status           text not null default 'not_scored' check (score_status in ('not_scored', 'scored', 'pending_ai', 'pending_manual')),
  risk_score             int not null default 0,
  invalidated_at         timestamptz,
  invalidated_reason     text,
  makeup_of              uuid,
  last_activity_at       timestamptz not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  foreign key (tenant_id, registration_id) references registrations(tenant_id, id),
  foreign key (competition_id, competition_version_id) references competition_versions(competition_id, id),
  foreign key (tenant_id, content_version_id) references content_bank_versions(tenant_id, id),
  unique (tenant_id, id),
  unique (registration_id, round_id, attempt_number)
);
-- At most one running attempt per registration and round.
create unique index attempts_one_running on attempts(registration_id, round_id) where status in ('in_progress', 'paused');
create index attempts_round_idx on attempts(competition_id, round_id, group_id, status);
create index attempts_deadline_idx on attempts(deadline_at) where status in ('in_progress', 'paused');
create trigger attempts_touch before update on attempts for each row execute function app.touch_updated_at();

create table attempt_sessions (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  attempt_id       uuid not null,
  -- Random id the browser keeps in local storage; fingerprint is a hash the client computes.
  device_id        text not null check (length(device_id) between 8 and 100),
  fingerprint_hash text,
  ip               inet,
  user_agent       text,
  status           text not null default 'active' check (status in ('active', 'superseded', 'closed')),
  started_at       timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  foreign key (tenant_id, attempt_id) references attempts(tenant_id, id)
);
create index attempt_sessions_attempt_idx on attempt_sessions(attempt_id);
create index attempt_sessions_device_idx on attempt_sessions(device_id);

create table attempt_answers (
  tenant_id      uuid not null,
  attempt_id     uuid not null,
  item_id        uuid not null,
  response       jsonb,
  -- Highest client sequence applied; older syncs never overwrite newer answers.
  client_seq     int not null,
  client_saved_at timestamptz,
  saved_at       timestamptz not null,
  time_spent_ms  int not null default 0 check (time_spent_ms >= 0),
  change_count   int not null default 1,
  late_sync      boolean not null default false,
  grade          jsonb,
  primary key (attempt_id, item_id),
  foreign key (tenant_id, attempt_id) references attempts(tenant_id, id)
);

create table integrity_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  attempt_id  uuid not null,
  session_id  uuid,
  source      text not null check (source in ('client', 'server')),
  type        text not null check (type ~ '^[a-z_]{2,40}$'),
  details     jsonb not null default '{}'::jsonb,
  client_time timestamptz,
  server_time timestamptz not null default now(),
  foreign key (tenant_id, attempt_id) references attempts(tenant_id, id)
);
create index integrity_events_attempt_idx on integrity_events(attempt_id, server_time);

-- A risk case opens when an attempt's risk score reaches the threshold.
-- Workflow: flagged → under_review → cleared | warning | disqualified.
-- Judges review; only a Head Judge disqualifies (stage 6).
create table risk_cases (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  attempt_id uuid not null unique,
  status     text not null default 'flagged' check (status in ('flagged', 'under_review', 'cleared', 'warning', 'disqualified')),
  risk_score int not null,
  signals    jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, attempt_id) references attempts(tenant_id, id)
);
create trigger risk_cases_touch before update on risk_cases for each row execute function app.touch_updated_at();

-- Extra attempts granted for a registration and round (make-up attempts).
create table attempt_grants (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  registration_id uuid not null,
  round_id        uuid not null,
  replaces_attempt_id uuid,
  reason          text not null check (length(reason) >= 3),
  granted_by      uuid references users(id),
  created_at      timestamptz not null default now(),
  foreign key (tenant_id, registration_id) references registrations(tenant_id, id)
);
create index attempt_grants_reg_idx on attempt_grants(registration_id, round_id);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table attempts enable row level security;
alter table attempt_sessions enable row level security;
alter table attempt_answers enable row level security;
alter table integrity_events enable row level security;
alter table risk_cases enable row level security;
alter table attempt_grants enable row level security;

create function app.is_me_or_my_child(p_student_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from students where id = p_student_id and user_id = nullif(current_setting('app.user_id', true), '')::uuid)
      or exists (select 1 from parent_children where student_id = p_student_id and parent_user_id = nullif(current_setting('app.user_id', true), '')::uuid)
$$;

create policy attempts_select on attempts for select using (tenant_id = app.current_tenant_id() or app.is_me_or_my_child(student_id));
create policy attempts_write on attempts for insert with check (tenant_id = app.current_tenant_id());
create policy attempts_update on attempts for update using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id());

do $$
declare t text;
begin
  foreach t in array array['attempt_sessions', 'attempt_answers', 'integrity_events', 'risk_cases', 'attempt_grants']
  loop
    execute format(
      'create policy %I on %I for all using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id())',
      t || '_tenant', t);
  end loop;
end
$$;

-- Participants see their registrations to find rounds; this lets a student
-- (not only a parent) read their own registrations.
drop policy registrations_select on registrations;
create policy registrations_select on registrations for select using (
  tenant_id = app.current_tenant_id() or registered_by_user_id = app.current_user_id() or app.is_me_or_my_child(student_id)
);

-- Background worker: find due work across tenants (ids only); the work itself
-- runs inside each tenant as the system actor.
create function app.due_attempts(p_grace_seconds int, p_limit int) returns table (id uuid, tenant_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, tenant_id from attempts
  where status in ('in_progress', 'paused') and deadline_at + make_interval(secs => p_grace_seconds) < now()
  order by deadline_at limit p_limit
$$;

create function app.competitions_with_expired_holds(p_limit int) returns table (competition_id uuid, tenant_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct competition_id, tenant_id from registrations
  where status = 'pending_payment' and hold_expires_at <= now()
  limit p_limit
$$;

grant select, insert, update on attempts, attempt_sessions, attempt_answers, risk_cases to cos_app;
grant select, insert on integrity_events, attempt_grants to cos_app;
grant execute on all functions in schema app to cos_app;
