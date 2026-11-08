-- 0006_results
-- Judging and official results: emergency actions, question adjustments,
-- score history, round cancellation, integrity review, result versions
-- (draft → in_review → approved → published → superseded), judge reviews,
-- and publication / leaderboard settings.
--
-- Result versions and their entries are immutable snapshots; only a
-- version's status moves forward. Every change to an official outcome is a
-- new version, so before/after is always preserved.

alter table competitions
  add column results_publication text not null default 'on_approval'
    check (results_publication in ('on_approval', 'after_competition_ends', 'never')),
  add column leaderboard_privacy text not null default 'nickname'
    check (leaderboard_privacy in ('full_name', 'first_name_initial', 'nickname', 'anonymous_code', 'rank_score_only')),
  -- "Immediate": show a provisional live leaderboard before official results.
  add column live_leaderboard boolean not null default false;

alter table attempt_grants add column available_until timestamptz;

-- ---------------------------------------------------------------------------
-- Emergency actions (Head Judge only), append-only
-- ---------------------------------------------------------------------------

create table emergency_actions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  competition_id uuid not null,
  round_id       uuid,
  group_id       uuid,
  kind           text not null check (kind in ('extend_time', 'reopen_attempt', 'invalidate_attempt', 'makeup_attempt',
                                               'disable_question', 'full_credit', 'replace_question', 'cancel_round')),
  reason         text not null check (length(reason) >= 3),
  actor_user_id  uuid not null references users(id),
  before         jsonb not null,
  after          jsonb not null,
  affected       jsonb not null,
  created_at     timestamptz not null default now(),
  foreign key (tenant_id, competition_id) references competitions(tenant_id, id),
  unique (tenant_id, id)
);
create index emergency_actions_competition_idx on emergency_actions(competition_id, created_at);

create table question_adjustments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  competition_id      uuid not null,
  round_id            uuid not null,
  -- null = every group in the round
  group_id            uuid,
  item_id             uuid not null,
  kind                text not null check (kind in ('disabled', 'full_credit', 'replaced')),
  replacement_item_id uuid,
  emergency_action_id uuid not null,
  created_at          timestamptz not null default now(),
  foreign key (tenant_id, emergency_action_id) references emergency_actions(tenant_id, id),
  check ((kind = 'replaced') = (replacement_item_id is not null))
);
create unique index question_adjustments_one on question_adjustments(round_id, coalesce(group_id, '00000000-0000-0000-0000-000000000000'::uuid), item_id);

create table attempt_score_history (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  attempt_id          uuid not null,
  score               jsonb,
  score_status        text not null,
  reason              text not null,
  emergency_action_id uuid,
  created_at          timestamptz not null default now(),
  foreign key (tenant_id, attempt_id) references attempts(tenant_id, id)
);
create index attempt_score_history_attempt_idx on attempt_score_history(attempt_id, created_at);

create table round_states (
  tenant_id           uuid not null,
  competition_id      uuid not null,
  round_id            uuid not null,
  status              text not null check (status in ('cancelled')),
  emergency_action_id uuid not null,
  created_at          timestamptz not null default now(),
  primary key (competition_id, round_id),
  foreign key (tenant_id, emergency_action_id) references emergency_actions(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Integrity review
-- ---------------------------------------------------------------------------

alter table risk_cases
  add column opened_by       uuid references users(id),
  add column decided_by      uuid references users(id),
  add column decided_at      timestamptz,
  add column decision_reason text;

create table risk_case_reviews (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  risk_case_id     uuid not null references risk_cases(id),
  reviewer_user_id uuid not null references users(id),
  kind             text not null check (kind in ('recommendation', 'decision', 'note')),
  recommendation   text check (recommendation in ('clear', 'warning', 'disqualify')),
  decision         text check (decision in ('cleared', 'warning', 'disqualified')),
  note             text not null check (length(note) >= 3),
  created_at       timestamptz not null default now()
);
create index risk_case_reviews_case_idx on risk_case_reviews(risk_case_id, created_at);

-- ---------------------------------------------------------------------------
-- Result versions
-- ---------------------------------------------------------------------------

create table result_versions (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null,
  competition_id         uuid not null,
  round_id               uuid not null,
  group_id               uuid not null,
  version_number         int not null check (version_number >= 1),
  status                 text not null check (status in ('draft', 'in_review', 'approved', 'published', 'superseded', 'discarded')),
  competition_version_id uuid not null,
  -- What the computation used: overrides, question adjustments, attempt ids.
  inputs                 jsonb not null,
  -- Before/after against the version that was published when this was computed.
  changes                jsonb not null,
  summary                jsonb not null,
  trigger                text not null check (trigger in ('manual', 'recalculation')),
  note                   text,
  created_by             uuid references users(id),
  created_at             timestamptz not null default now(),
  submitted_at           timestamptz,
  approved_by            uuid references users(id),
  approved_at            timestamptz,
  published_at           timestamptz,
  foreign key (tenant_id, competition_id) references competitions(tenant_id, id),
  unique (round_id, group_id, version_number),
  unique (tenant_id, id)
);
create unique index result_versions_one_published on result_versions(round_id, group_id) where status = 'published';
create unique index result_versions_one_open on result_versions(round_id, group_id) where status in ('draft', 'in_review', 'approved');
create index result_versions_competition_idx on result_versions(competition_id, status);

-- Forward-only status; contents never change.
create function app.result_versions_guard() returns trigger
language plpgsql as $$
begin
  if new.inputs is distinct from old.inputs or new.changes is distinct from old.changes or new.summary is distinct from old.summary
     or new.version_number <> old.version_number or new.round_id <> old.round_id or new.group_id <> old.group_id then
    raise exception 'result version % is immutable', old.id;
  end if;
  if not (
    old.status = new.status
    or (old.status = 'draft' and new.status in ('in_review', 'discarded'))
    or (old.status = 'in_review' and new.status in ('approved', 'draft', 'discarded'))
    or (old.status = 'approved' and new.status in ('published', 'discarded'))
    or (old.status = 'published' and new.status = 'superseded')
  ) then
    raise exception 'invalid result status change % -> %', old.status, new.status;
  end if;
  return new;
end
$$;
create trigger result_versions_guard before update on result_versions for each row execute function app.result_versions_guard();

create table result_entries (
  tenant_id           uuid not null,
  result_version_id   uuid not null,
  registration_id     uuid not null,
  student_id          uuid not null,
  attempt_id          uuid,
  status              text not null check (status in ('ok', 'disqualified', 'no_attempt')),
  total_score         numeric(12, 3),
  original_score      numeric(12, 3),
  accuracy            numeric(8, 6),
  time_ms             bigint,
  hard_question_score numeric(12, 3),
  submitted_at        timestamptz,
  rank                int,
  tied_with           int,
  scope_ranks         jsonb not null,
  qualified           boolean not null,
  qualification_basis text,
  overrides           jsonb not null,
  primary key (result_version_id, registration_id),
  foreign key (tenant_id, result_version_id) references result_versions(tenant_id, id)
);
create index result_entries_registration_idx on result_entries(registration_id);

create function app.result_entries_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'result entries are immutable';
end
$$;
create trigger result_entries_no_change before update or delete on result_entries for each statement execute function app.result_entries_immutable();
create trigger emergency_actions_no_change before update or delete on emergency_actions for each statement execute function app.result_entries_immutable();

create table result_reviews (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  result_version_id uuid not null,
  reviewer_user_id  uuid not null references users(id),
  recommendation    text not null check (recommendation in ('approve', 'changes_requested')),
  note              text,
  created_at        timestamptz not null default now(),
  foreign key (tenant_id, result_version_id) references result_versions(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Public leaderboard: published results of visible competitions only, with
-- just the fields a display name may use. Timing (after_competition_ends) is
-- applied by the API.
-- ---------------------------------------------------------------------------

create function app.public_results(p_competition_id uuid, p_round_id uuid, p_group_id uuid)
returns table (
  version_id uuid, version_number int, published_at timestamptz, publication text, privacy text,
  registration_id uuid, student_id uuid, status text, total_score numeric, rank int, tied_with int, qualified boolean,
  given_name text, family_name text, preferred_name text, nickname text
)
language sql stable security definer set search_path = public, pg_temp as $$
  select v.id, v.version_number, v.published_at, c.results_publication, c.leaderboard_privacy,
         e.registration_id, e.student_id, e.status, e.total_score, e.rank, e.tied_with, e.qualified,
         s.given_name, s.family_name, s.preferred_name, s.nickname
  from result_versions v
  join competitions c on c.id = v.competition_id
  join tenants t on t.id = c.tenant_id and t.status = 'active'
  join result_entries e on e.result_version_id = v.id
  join students s on s.id = e.student_id
  where v.competition_id = p_competition_id and v.round_id = p_round_id and v.group_id = p_group_id
    and v.status = 'published' and c.status = 'published' and c.visibility in ('public', 'unlisted')
    and c.results_publication <> 'never'
$$;

-- "Immediate" publication: a provisional live leaderboard from the latest
-- unpublished computation, only when the competition turns it on.
create function app.public_live_results(p_competition_id uuid, p_round_id uuid, p_group_id uuid)
returns table (
  version_id uuid, version_number int, created_at timestamptz, privacy text,
  registration_id uuid, student_id uuid, status text, total_score numeric, rank int, tied_with int,
  given_name text, family_name text, preferred_name text, nickname text
)
language sql stable security definer set search_path = public, pg_temp as $$
  select v.id, v.version_number, v.created_at, c.leaderboard_privacy,
         e.registration_id, e.student_id, e.status, e.total_score, e.rank, e.tied_with,
         s.given_name, s.family_name, s.preferred_name, s.nickname
  from result_versions v
  join competitions c on c.id = v.competition_id
  join tenants t on t.id = c.tenant_id and t.status = 'active'
  join result_entries e on e.result_version_id = v.id
  join students s on s.id = e.student_id
  where v.competition_id = p_competition_id and v.round_id = p_round_id and v.group_id = p_group_id
    and v.status in ('draft', 'in_review', 'approved')
    and c.live_leaderboard and c.status = 'published' and c.visibility in ('public', 'unlisted')
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['emergency_actions', 'question_adjustments', 'attempt_score_history', 'round_states', 'risk_case_reviews', 'result_versions', 'result_reviews']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id())',
      t || '_tenant', t);
  end loop;
end
$$;

alter table result_entries enable row level security;
-- Families see their own published results (unless the competition never publishes).
-- (A function, because families cannot read result_versions or other tenants' competitions directly.)
create function app.result_version_visible_to_family(p_version_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from result_versions v join competitions c on c.id = v.competition_id
    where v.id = p_version_id and v.status in ('published', 'superseded') and c.results_publication <> 'never'
  )
$$;
create policy result_entries_select on result_entries for select using (
  tenant_id = app.current_tenant_id()
  or (app.is_me_or_my_child(student_id) and app.result_version_visible_to_family(result_version_id))
);
create policy result_entries_insert on result_entries for insert with check (tenant_id = app.current_tenant_id());

-- Families need the version row to read their entries (published and superseded only).
create function app.result_version_public(p_version_id uuid) returns table (round_id uuid, group_id uuid, competition_id uuid, status text, version_number int, published_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select round_id, group_id, competition_id, status, version_number, published_at from result_versions
  where id = p_version_id and status in ('published', 'superseded')
$$;

grant select, insert on emergency_actions, question_adjustments, attempt_score_history, round_states, risk_case_reviews, result_entries, result_reviews to cos_app;
grant select, insert, update on result_versions to cos_app;
grant execute on all functions in schema app to cos_app;
