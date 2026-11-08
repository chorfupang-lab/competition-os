-- 0004_registration_payments
-- Registration (parent and school), consent, pricing, tax, offer codes,
-- orders, payments through provider adapters, refunds, webhook events and
-- reconciliation.
--
-- Money is integer minor units (bigint) in the competition's fixed currency.
-- Card data never touches this system: checkout is hosted by the provider.
-- The tenant is the merchant (its own provider account); the platform's fee
-- is recorded per order.

-- ---------------------------------------------------------------------------
-- Settings on existing tables
-- ---------------------------------------------------------------------------

alter table tenants add column platform_fee_bps int not null default 0 check (platform_fee_bps between 0 and 10000);

alter table competitions
  add column registration_opens_at  timestamptz,
  add column registration_closes_at timestamptz,
  add column waitlist_enabled       boolean not null default true,
  add column consent_required       boolean not null default true,
  -- Registration needs an offer code with purpose 'invite' (e.g. for unlisted competitions).
  add column requires_invite_code   boolean not null default false,
  add column consent_version        text not null default 'v1' check (length(consent_version) between 1 and 40),
  add column consent_text_i18n      jsonb not null default '{}'::jsonb,
  add column tax_rate_id            uuid,
  -- Minutes a seat is held for an unpaid registration before it is released.
  add column payment_hold_minutes   int not null default 30 check (payment_hold_minutes between 5 and 10080);

-- ---------------------------------------------------------------------------
-- Payment accounts: the tenant's merchant account at a provider
-- ---------------------------------------------------------------------------

create table tenant_payment_accounts (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id),
  provider            text not null check (provider in ('airwallex', 'test')),
  -- Provider-side account id (e.g. an Airwallex connected account). Never a secret.
  external_account_id text not null,
  status              text not null default 'active' check (status in ('active', 'disabled')),
  created_by          uuid references users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index tenant_payment_accounts_one_active on tenant_payment_accounts(tenant_id) where status = 'active';
create trigger tenant_payment_accounts_touch before update on tenant_payment_accounts for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Tax, prices, offer codes
-- ---------------------------------------------------------------------------

create table tax_rates (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  name       text not null check (length(name) between 1 and 100),
  rate_bps   int not null check (rate_bps between 0 and 10000),
  inclusive  boolean not null,
  status     text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
alter table competitions add constraint competitions_tax_rate_fk foreign key (tenant_id, tax_rate_id) references tax_rates(tenant_id, id);

create table competition_prices (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  competition_id uuid not null,
  group_id       uuid,
  label          text not null default '' check (length(label) <= 100),
  amount_minor   bigint not null check (amount_minor >= 0),
  starts_at      timestamptz,
  ends_at        timestamptz,
  status         text not null default 'active' check (status in ('active', 'archived')),
  created_by     uuid references users(id),
  created_at     timestamptz not null default now(),
  foreign key (tenant_id, competition_id) references competitions(tenant_id, id),
  check (starts_at is null or ends_at is null or starts_at < ends_at)
);
create index competition_prices_competition_idx on competition_prices(competition_id) where status = 'active';

create table offer_codes (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id),
  competition_id    uuid,
  code              citext not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$'),
  kind              text not null check (kind in ('percent', 'fixed')),
  percent_bps       int check (percent_bps between 1 and 10000),
  amount_minor      bigint check (amount_minor > 0),
  purpose           text not null default 'promotion' check (purpose in ('promotion', 'scholarship', 'invite', 'trial')),
  valid_from        timestamptz,
  valid_until       timestamptz,
  max_uses          int check (max_uses > 0),
  max_uses_per_user int check (max_uses_per_user > 0),
  status            text not null default 'active' check (status in ('active', 'disabled')),
  created_by        uuid references users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (tenant_id, competition_id) references competitions(tenant_id, id),
  unique (tenant_id, code),
  unique (tenant_id, id),
  check ((kind = 'percent') = (percent_bps is not null) and (kind = 'fixed') = (amount_minor is not null))
);
create trigger offer_codes_touch before update on offer_codes for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Orders, lines, payments, refunds
-- ---------------------------------------------------------------------------

create table orders (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id),
  order_number       text not null,
  competition_id     uuid not null,
  kind               text not null check (kind in ('parent', 'school')),
  buyer_user_id      uuid not null references users(id),
  school_id          uuid,
  status             text not null check (status in ('pending', 'paid', 'failed', 'cancelled', 'refunded', 'partially_refunded')),
  payment_method     text not null check (payment_method in ('online', 'invoice', 'none')),
  currency           char(3) not null,
  subtotal_minor     bigint not null check (subtotal_minor >= 0),
  discount_minor     bigint not null check (discount_minor >= 0),
  tax_minor          bigint not null check (tax_minor >= 0),
  total_minor        bigint not null check (total_minor >= 0),
  refunded_minor     bigint not null default 0 check (refunded_minor >= 0),
  tax_rate_bps       int,
  tax_inclusive      boolean,
  offer_code_id      uuid,
  platform_fee_bps   int not null default 0,
  platform_fee_minor bigint not null default 0,
  invoice_due_at     timestamptz,
  external_reference text,
  expires_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  paid_at            timestamptz,
  cancelled_at       timestamptz,
  foreign key (tenant_id, competition_id) references competitions(tenant_id, id),
  foreign key (tenant_id, school_id) references schools(tenant_id, id),
  foreign key (tenant_id, offer_code_id) references offer_codes(tenant_id, id),
  unique (tenant_id, order_number),
  unique (tenant_id, id),
  check (refunded_minor <= total_minor),
  check ((kind = 'school') = (school_id is not null))
);
create index orders_buyer_idx on orders(buyer_user_id);
create index orders_competition_idx on orders(competition_id, status);
create trigger orders_touch before update on orders for each row execute function app.touch_updated_at();

-- Human-friendly, per-tenant sequential order numbers: ORD-2026-000001.
create table order_counters (
  tenant_id uuid not null references tenants(id),
  year      int not null,
  last      int not null,
  primary key (tenant_id, year)
);

create table registrations (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null,
  competition_id        uuid not null,
  competition_version_id uuid not null,
  group_id              uuid not null,
  student_id            uuid not null references students(id),
  registered_by_user_id uuid not null references users(id),
  channel               text not null check (channel in ('parent', 'school', 'admin')),
  school_id             uuid,
  content_locale        text not null check (content_locale in ('en', 'zh-Hant', 'zh-Hans', 'th')),
  declared_grade        text,
  status                text not null check (status in ('pending_payment', 'confirmed', 'waitlisted', 'cancelled')),
  hold_expires_at       timestamptz,
  waitlisted_at         timestamptz,
  order_id              uuid,
  eligibility           jsonb not null,
  -- Possible duplicate person (same name and date of birth, different student
  -- identity) already registered: flagged for an admin, never silently rejected.
  possible_duplicate_of uuid,
  duplicate_resolution  text check (duplicate_resolution in ('not_duplicate', 'cancelled')),
  needs_attention       text,
  cancel_reason         text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  confirmed_at          timestamptz,
  cancelled_at          timestamptz,
  foreign key (tenant_id, competition_id) references competitions(tenant_id, id),
  foreign key (competition_id, competition_version_id) references competition_versions(competition_id, id),
  foreign key (tenant_id, school_id) references schools(tenant_id, id),
  foreign key (tenant_id, order_id) references orders(tenant_id, id),
  unique (tenant_id, id)
);
-- A student holds at most one live registration per competition.
create unique index registrations_one_live on registrations(competition_id, student_id)
  where status in ('pending_payment', 'confirmed', 'waitlisted');
create index registrations_group_idx on registrations(competition_id, group_id, status);
create index registrations_order_idx on registrations(order_id);
create trigger registrations_touch before update on registrations for each row execute function app.touch_updated_at();

create table order_lines (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  order_id          uuid not null,
  registration_id   uuid not null,
  description       text not null,
  unit_amount_minor bigint not null,
  discount_minor    bigint not null,
  tax_minor         bigint not null,
  total_minor       bigint not null,
  refunded_minor    bigint not null default 0,
  foreign key (tenant_id, order_id) references orders(tenant_id, id),
  foreign key (tenant_id, registration_id) references registrations(tenant_id, id),
  check (refunded_minor <= total_minor)
);
create index order_lines_order_idx on order_lines(order_id);

create table offer_code_redemptions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  offer_code_id uuid not null,
  order_id      uuid not null,
  user_id       uuid not null references users(id),
  uses          int not null check (uses > 0),
  -- Released when the order is cancelled or fails, so the use can be reused.
  status        text not null default 'active' check (status in ('active', 'released')),
  created_at    timestamptz not null default now(),
  foreign key (tenant_id, offer_code_id) references offer_codes(tenant_id, id),
  foreign key (tenant_id, order_id) references orders(tenant_id, id)
);
create index offer_code_redemptions_code_idx on offer_code_redemptions(offer_code_id) where status = 'active';

create table payments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  order_id            uuid not null,
  provider            text not null check (provider in ('airwallex', 'test')),
  provider_payment_id text not null,
  status              text not null check (status in ('pending', 'succeeded', 'failed', 'cancelled')),
  amount_minor        bigint not null check (amount_minor > 0),
  currency            char(3) not null,
  gateway_fee_minor   bigint,
  -- What the client needs to open hosted checkout (no secrets beyond the provider's client token).
  checkout            jsonb not null,
  failure_code        text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  succeeded_at        timestamptz,
  foreign key (tenant_id, order_id) references orders(tenant_id, id),
  unique (provider, provider_payment_id),
  unique (tenant_id, id)
);
create index payments_order_idx on payments(order_id);
create trigger payments_touch before update on payments for each row execute function app.touch_updated_at();

create table refunds (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  order_id           uuid not null,
  payment_id         uuid,
  amount_minor       bigint not null check (amount_minor > 0),
  currency           char(3) not null,
  reason             text not null check (length(reason) >= 3),
  status             text not null check (status in ('pending', 'succeeded', 'failed')),
  provider_refund_id text,
  registration_ids   uuid[] not null default '{}',
  requested_by       uuid references users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  completed_at       timestamptz,
  foreign key (tenant_id, order_id) references orders(tenant_id, id),
  foreign key (tenant_id, payment_id) references payments(tenant_id, id)
);
create unique index refunds_provider_ref on refunds(provider_refund_id) where provider_refund_id is not null;
create trigger refunds_touch before update on refunds for each row execute function app.touch_updated_at();

-- Every webhook delivery, verified or not. (provider, event_id) makes processing idempotent.
create table webhook_events (
  id               uuid primary key default gen_random_uuid(),
  provider         text not null,
  event_id         text not null,
  event_type       text not null,
  tenant_id        uuid references tenants(id),
  payload          jsonb not null,
  received_at      timestamptz not null default now(),
  processed_at     timestamptz,
  processing_error text,
  unique (provider, event_id)
);

-- Settled transactions reported by the gateway, for reconciliation.
create table gateway_transactions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  provider     text not null,
  provider_txn_id text not null,
  kind         text not null check (kind in ('payment', 'refund')),
  provider_ref text not null,
  amount_minor bigint not null,
  fee_minor    bigint not null default 0,
  currency     char(3) not null,
  settled_at   timestamptz not null,
  imported_by  uuid references users(id),
  imported_at  timestamptz not null default now(),
  unique (provider, provider_txn_id)
);
create index gateway_transactions_tenant_idx on gateway_transactions(tenant_id, settled_at);

-- ---------------------------------------------------------------------------
-- Consent (append-only)
-- ---------------------------------------------------------------------------

create table consent_records (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id),
  competition_id   uuid not null,
  student_id       uuid not null references students(id),
  given_by_user_id uuid not null references users(id),
  -- parent: a parent or guardian agreed; school_attestation: a school admin
  -- confirmed the school holds parental consent.
  consent_type     text not null check (consent_type in ('parent', 'school_attestation')),
  consent_version  text not null,
  consent_text_hash text not null,
  granted          boolean not null,
  ip               inet,
  user_agent       text,
  created_at       timestamptz not null default now(),
  foreign key (tenant_id, competition_id) references competitions(tenant_id, id)
);
create index consent_records_student_idx on consent_records(student_id);

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- Next order number for a tenant and year (row lock serializes concurrent orders).
create function app.next_order_number(p_tenant_id uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  y int := extract(year from now() at time zone 'UTC');
  n int;
begin
  insert into order_counters (tenant_id, year, last) values (p_tenant_id, y, 1)
  on conflict (tenant_id, year) do update set last = order_counters.last + 1
  returning last into n;
  return format('ORD-%s-%s', y, lpad(n::text, 6, '0'));
end
$$;

-- Webhooks arrive without a user or tenant: find the tenant that owns a provider payment or refund.
create function app.payment_tenant(p_provider text, p_provider_payment_id text) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select tenant_id from payments where provider = p_provider and provider_payment_id = p_provider_payment_id
$$;
create function app.refund_tenant(p_provider_refund_id text) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select tenant_id from refunds where provider_refund_id = p_provider_refund_id
$$;

-- Possible duplicates: someone else with the same name and date of birth
-- already registered in this competition. Returns ids only.
create function app.registration_possible_duplicate(p_competition_id uuid, p_student_id uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select r.id
  from registrations r
  join students s on s.id = r.student_id
  join students me on me.id = p_student_id
  where r.competition_id = p_competition_id
    and r.student_id <> p_student_id
    and r.status in ('pending_payment', 'confirmed', 'waitlisted')
    and me.date_of_birth is not null
    and s.date_of_birth = me.date_of_birth
    and lower(trim(coalesce(s.given_name, ''))) = lower(trim(coalesce(me.given_name, '')))
    and lower(trim(coalesce(s.family_name, ''))) = lower(trim(coalesce(me.family_name, '')))
  order by r.created_at
  limit 1
$$;

-- Seats taken in a group: confirmed plus unexpired holds.
create function app.group_seats_taken(p_competition_id uuid, p_group_id uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int from registrations
  where competition_id = p_competition_id and group_id = p_group_id
    and (status = 'confirmed' or (status = 'pending_payment' and (hold_expires_at is null or hold_expires_at > now())))
$$;

-- Offer code usage across all buyers (buyers cannot see each other's redemptions).
create function app.offer_code_uses(p_offer_code_id uuid, p_user_id uuid, out total int, out by_user int)
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(uses), 0)::int, coalesce(sum(uses) filter (where user_id = p_user_id), 0)::int
  from offer_code_redemptions where offer_code_id = p_offer_code_id and status = 'active'
$$;

-- Look up an offer code for a buyer by its text, scoped to the competition's tenant.
create function app.find_offer_code(p_tenant_id uuid, p_code text)
returns table (id uuid, competition_id uuid, code text, kind text, percent_bps int, amount_minor bigint, purpose text,
               valid_from timestamptz, valid_until timestamptz, max_uses int, max_uses_per_user int, status text)
language sql stable security definer set search_path = public, pg_temp as $$
  select id, competition_id, code::text, kind, percent_bps, amount_minor, purpose, valid_from, valid_until, max_uses, max_uses_per_user, status
  from offer_codes where tenant_id = p_tenant_id and code = p_code::citext
$$;

-- Prices and tax are needed by parents (outside the tenant) to quote a registration.
create function app.competition_quote_inputs(p_competition_id uuid)
returns table (price_id uuid, group_id uuid, amount_minor bigint, starts_at timestamptz, ends_at timestamptz, tax_rate_bps int, tax_inclusive boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id, p.group_id, p.amount_minor, p.starts_at, p.ends_at, t.rate_bps, t.inclusive
  from competitions c
  left join competition_prices p on p.competition_id = c.id and p.status = 'active'
  left join tax_rates t on t.id = c.tax_rate_id and t.status = 'active'
  where c.id = p_competition_id and c.status = 'published'
$$;

-- The tenant's active payment account (provider + external account id; no secrets stored).
create function app.tenant_payment_account(p_tenant_id uuid) returns table (provider text, external_account_id text, platform_fee_bps int)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.provider, a.external_account_id, t.platform_fee_bps
  from tenants t left join tenant_payment_accounts a on a.tenant_id = t.id and a.status = 'active'
  where t.id = p_tenant_id
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
--   Tenant staff work inside their tenant context. Parents act WITHOUT a
--   tenant context and are limited to their own orders and their children's
--   registrations; they never gain tenant-wide visibility.
-- ---------------------------------------------------------------------------

alter table tenant_payment_accounts enable row level security;
alter table tax_rates enable row level security;
alter table competition_prices enable row level security;
alter table offer_codes enable row level security;
alter table orders enable row level security;
alter table order_counters enable row level security;
alter table registrations enable row level security;
alter table order_lines enable row level security;
alter table offer_code_redemptions enable row level security;
alter table payments enable row level security;
alter table refunds enable row level security;
alter table webhook_events enable row level security;
alter table gateway_transactions enable row level security;
alter table consent_records enable row level security;

create function app.is_my_child(p_student_id uuid) returns boolean
language sql stable as $$
  select exists (select 1 from parent_children where student_id = p_student_id and parent_user_id = app.current_user_id())
$$;

-- An order belongs to the caller (buyer), checked without a tenant context.
create function app.is_my_order(p_order_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from orders where id = p_order_id and buyer_user_id = nullif(current_setting('app.user_id', true), '')::uuid)
$$;

create policy tenant_payment_accounts_select on tenant_payment_accounts for select using (tenant_id = app.current_tenant_id() or app.is_platform_admin());
create policy tenant_payment_accounts_write on tenant_payment_accounts for all using (app.is_platform_admin()) with check (app.is_platform_admin());

create policy tax_rates_all on tax_rates for all using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id());
create policy competition_prices_all on competition_prices for all using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id());
create policy offer_codes_all on offer_codes for all using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id());
create policy order_counters_none on order_counters for all using (false);

create policy orders_select on orders for select using (tenant_id = app.current_tenant_id() or buyer_user_id = app.current_user_id());
create policy orders_insert on orders for insert with check (
  buyer_user_id = app.current_user_id()
  and (
    tenant_id = app.current_tenant_id()
    -- Outside a tenant (parents): only for a published competition of that tenant.
    or (app.current_tenant_id() is null and exists (
      select 1 from competitions c where c.id = orders.competition_id and c.tenant_id = orders.tenant_id and c.status = 'published'))
  )
);
create policy orders_update on orders for update
  using (tenant_id = app.current_tenant_id() or buyer_user_id = app.current_user_id())
  with check (tenant_id = app.current_tenant_id() or buyer_user_id = app.current_user_id());

create policy registrations_select on registrations for select using (
  tenant_id = app.current_tenant_id() or registered_by_user_id = app.current_user_id() or app.is_my_child(student_id)
);
create policy registrations_insert on registrations for insert with check (
  tenant_id = app.current_tenant_id()
  or (app.current_tenant_id() is null and registered_by_user_id = app.current_user_id() and app.is_my_child(student_id))
);
create policy registrations_update on registrations for update
  using (tenant_id = app.current_tenant_id() or (registered_by_user_id = app.current_user_id() and app.is_my_child(student_id)))
  with check (tenant_id = app.current_tenant_id() or (registered_by_user_id = app.current_user_id() and app.is_my_child(student_id)));

create policy order_lines_select on order_lines for select using (tenant_id = app.current_tenant_id() or app.is_my_order(order_id));
create policy order_lines_insert on order_lines for insert with check (tenant_id = app.current_tenant_id() or app.is_my_order(order_id));
create policy order_lines_update on order_lines for update using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id());

create policy offer_code_redemptions_select on offer_code_redemptions for select using (tenant_id = app.current_tenant_id() or user_id = app.current_user_id());
create policy offer_code_redemptions_insert on offer_code_redemptions for insert with check (
  tenant_id = app.current_tenant_id() or (user_id = app.current_user_id() and app.is_my_order(order_id))
);
create policy offer_code_redemptions_update on offer_code_redemptions for update
  using (tenant_id = app.current_tenant_id() or user_id = app.current_user_id())
  with check (tenant_id = app.current_tenant_id() or user_id = app.current_user_id());

create policy payments_select on payments for select using (tenant_id = app.current_tenant_id() or app.is_my_order(order_id));
create policy payments_insert on payments for insert with check (tenant_id = app.current_tenant_id() or app.is_my_order(order_id));
create policy payments_update on payments for update using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id());

create policy refunds_select on refunds for select using (tenant_id = app.current_tenant_id() or app.is_my_order(order_id));
create policy refunds_write on refunds for all using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id());

-- Anyone (the webhook endpoint) may record a delivery; only platform admins and the owning tenant read them.
create policy webhook_events_insert on webhook_events for insert with check (true);
create policy webhook_events_select on webhook_events for select using (app.is_platform_admin() or tenant_id = app.current_tenant_id());
create policy webhook_events_update on webhook_events for update using (true) with check (true);

create policy gateway_transactions_all on gateway_transactions for all using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id());

create policy consent_records_select on consent_records for select using (tenant_id = app.current_tenant_id() or given_by_user_id = app.current_user_id());
create policy consent_records_insert on consent_records for insert with check (
  given_by_user_id = app.current_user_id()
  and (tenant_id = app.current_tenant_id() or (app.current_tenant_id() is null and app.is_my_child(student_id)))
);

-- Registering connects a student to the organizer's tenant. Callers: the
-- tenant itself, or a parent of the student registering for a published
-- competition of that tenant. (A function, because parents cannot read
-- tenant_students and so cannot use INSERT ... ON CONFLICT.)
create function app.connect_student_to_tenant(p_tenant_id uuid, p_student_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not (
    app.current_tenant_id() = p_tenant_id
    or (
      exists (select 1 from parent_children where student_id = p_student_id and parent_user_id = app.current_user_id())
      and exists (select 1 from competitions where tenant_id = p_tenant_id and status = 'published')
    )
  ) then
    raise exception 'not allowed to connect this student to the tenant' using errcode = '42501';
  end if;
  insert into tenant_students (tenant_id, student_id, source) values (p_tenant_id, p_student_id, 'registration')
  on conflict do nothing;
end
$$;

-- Audit: a user may write entries attributed to themselves into the tenant
-- they act on (e.g. a parent registering with an organizer); entries can
-- never be attributed to someone else.
drop policy audit_logs_insert on audit_logs;
create policy audit_logs_insert on audit_logs for insert with check (
  (actor_user_id is null or actor_user_id = app.current_user_id())
  and (
    tenant_id is null
    or tenant_id = app.current_tenant_id()
    or app.is_platform_admin()
    or (actor_user_id is not null and actor_user_id = app.current_user_id())
  )
);

grant select, insert, update on tenant_payment_accounts, tax_rates, competition_prices, offer_codes, orders, registrations,
  order_lines, offer_code_redemptions, payments, refunds, webhook_events, gateway_transactions to cos_app;
grant select, insert on consent_records to cos_app;
grant execute on all functions in schema app to cos_app;
