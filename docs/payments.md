# Payments: design and go-live checklist

## Model

- **The tenant is the merchant** (HR28). Each tenant has one active
  `tenant_payment_accounts` row: the provider plus the provider-side account
  id (for Airwallex, a connected account). The platform's API credentials
  live only in environment secrets and are never stored in the database.
- **The platform fee** is set per tenant in basis points
  (`/platform/tenants/:id/platform-fee`) and recorded on every order. SaaS
  plans (stage 9) will replace this setting.
  - Economics per order: gross − gateway fee − platform fee − refunds =
    tenant net.
- **Fixed currency per competition** (HR29). All amounts are integer minor
  units, and there is no foreign-exchange conversion.
- **Hosted checkout only.** Card data never reaches this system. Airwallex
  returns an intent id and client secret, and the web app redirects the
  buyer to Airwallex's Hosted Payment Page.
- **The provider adapter** (`apps/api/src/payments`) means new gateways are
  added without touching registration logic (HR26).

## Lifecycle

Registration and order statuses move as follows.

- **Paid, seat free:** registration `pending_payment` with a hold
  (`payment_hold_minutes`), order `pending` → checkout → webhook
  `payment_intent.succeeded` → order `paid`, registration `confirmed`.
- **Hold lapses:** the seat is released and the waitlist promoted. If the
  payment arrives later, the money is never lost: the registration is
  confirmed if a seat is free, otherwise waitlisted and flagged
  `paid_without_seat` for the organizer to refund or add a seat.
- **Free competition, or 100% scholarship:** confirmed immediately.
  Scholarships still produce a zero-value order, which records the code's
  use.
- **School invoice:** seats confirmed, order `pending` with a due date → an
  admin records the bank transfer or purchase-order payment (`mark-paid`,
  reference and reason required).
- **Refund:**
  - admin-initiated, with a reason, full or partial;
  - listed registrations are cancelled at once, and their seats go to the
    waitlist;
  - an online refund stays pending until the gateway's refund webhook
    arrives;
  - a failed refund is marked `failed`, and its amount becomes refundable
    again.

Webhooks are checked against the raw body (HMAC-SHA256 over
`x-timestamp` + body, with a 5-minute tolerance). Each delivery is stored
once per `(provider, event_id)`, so retries are harmless. Each delivery is
applied inside its own tenant, by the system actor, and audited.

Reconciliation compares our successful payments and refunds with the
gateway's settled transactions, imported from a settlement report or pulled
with `sync`. Each row is `matched`, `unsettled` or `mismatch`.

## Airwallex go-live checklist

The Airwallex adapter follows Airwallex's public API reference, but it has
**not yet been exercised against the Airwallex sandbox**. Before taking real
payments:

1. In the Airwallex sandbox (demo) account, create API credentials and a
   webhook endpoint pointing to `https://<api-host>/webhooks/payments/airwallex`.
   Subscribe to `payment_intent.*`, `payment_attempt.*` and `refund.*`.
2. Store `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY` and
   `AIRWALLEX_WEBHOOK_SECRET` in the secrets manager. Set
   `AIRWALLEX_BASE_URL=https://api-demo.airwallex.com` and
   `AIRWALLEX_ENV=demo`. **Never paste keys into chat or commit them.**
3. Connect each tenant: `POST /platform/tenants/:id/payment-accounts`
   with `{ "provider": "airwallex", "externalAccountId": "<connected account id>" }`.
   Use `platform` to charge on the platform's own account.
4. Run a sandbox payment, a failed payment, a partial refund and a full
   refund. Confirm the webhook event names and payload fields that
   `airwallex-format.ts` maps. Adjust the mapping if Airwallex's current
   names differ.
5. Confirm the field names of `listSettledTransactions`
   (`/api/v1/financial_transactions`) against a real settlement, then run
   reconciliation for a test day.
6. Switch to production credentials and `AIRWALLEX_ENV=prod`. The test
   provider is always disabled when `NODE_ENV=production`.
