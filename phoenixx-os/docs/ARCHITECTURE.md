# Architecture

How Phoenixx OS is put together, and why. Read alongside the PRD.

---

## 1. Shape

```
            ┌──────────────┐        ┌──────────────┐
            │   Web app    │        │  Mobile app  │
            │ React + TS   │        │ React Native │
            └──────┬───────┘        └──────┬───────┘
                   │      same REST API    │
                   └───────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │   /api/v1  (Express) │
                    │  auth → RBAC → route │
                    └──────────┬───────────┘
                               ▼
              ┌────────────────────────────────┐
              │          services              │
              │  scoring · numbering · gst     │
              │  deadlines · notifications     │
              │  reports · analytics · pdf     │
              └────────────────┬───────────────┘
                               ▼
                    ┌──────────────────────┐
                    │  repository (tenant  │
                    │   scoping enforced)  │
                    └──────────┬───────────┘
                               ▼
                         SQLite / Postgres
                               ▲
                    ┌──────────┴───────────┐
                    │   background jobs    │
                    │ ladder · scores      │
                    │ reports · webhooks   │
                    └──────────────────────┘
```

**No business logic in the clients.** Both apps read and write what the API
exposes. The web app has no scoring maths, no GST rules and no numbering logic —
if it did, the mobile app would have to grow a second copy and they would drift.

---

## 2. Tenancy

The PRD is explicit that multi-tenancy is a day-one decision (AR8), and it is the
one thing that is genuinely painful to retrofit.

Three layers, in order:

1. **Token.** The access token carries `tenant_id`, `role` and any custom role id.
   `authenticate` resolves it to a live user, checks the tenant is not suspended,
   and hangs `req.auth` off the request.
2. **Repository.** `repo(table, tenantId)` injects `tenant_id` into every query it
   builds and validates identifiers against a strict pattern. No route hand-writes
   `tenant_id = ?` for CRUD, so it cannot be forgotten.
3. **Schema.** Every tenant-owned table carries `tenant_id`. In the PostgreSQL
   target these become row-level security policies, so the database enforces the
   same rule the application does.

**Cross-tenant reads return 404, not 403.** A 403 confirms the record exists. A
404 says nothing at all, which is the correct answer to "does agency B have a
client with this id?".

Suspended and cancelled tenants become read-only rather than locked out: reads and
the full data export keep working, writes return `402 subscription_read_only`.
Nobody is ever held hostage by their own data.

---

## 3. Data model notes

**Money** is an integer in minor units plus a currency code (AR6). No floats
anywhere near an invoice. `formatMoney` handles Indian lakh/crore grouping versus
international at render time, per tenant preference.

**Timestamps** are UTC ISO-8601 strings in the database, rendered in the tenant
timezone by the client.

**Soft deletes** (`deleted_at`) on everything user-facing (AR7). The repository
filters them out automatically; a `withDeleted` flag is the only way past.

**Project teams** live in `project_members`: one row per person per project,
carrying the seat they hold (manager, lead, senior, member, junior, reviewer,
observer), what they own, their allocation and their dates. Manager and lead are
single-holder seats, and the holder is mirrored onto `projects.manager_id` and
`projects.lead_id` so a project list renders in one query without a join per row.
The mirror is written by `syncSeatColumn`, and every write path — creating a
project, patching it, adding or reseating a member — goes through it, so the two
representations cannot drift.

**Chat** is three tables: `channels`, `channel_members`, `messages`. A channel's
`kind` decides who is in it. `project` rooms take their membership from
`project_members` and are reconciled by `syncProjectChannel` after every team
change, so there is no second list to drift; `broadcast` has one row per tenant
and everyone in it; `direct` is keyed by the sorted pair of user ids, which is
what makes "open a DM" idempotent. Unread is a single `last_read_at` per member
rather than a read receipt per message, so a badge is one indexed COUNT.

**Task assignment** is `action_items.owner_id` plus `action_assignees`. The owner
column stays the single accountable person because the deadline engine, the
escalation ladder and every overdue counter read it; the join table holds the
rest of the team. Splitting it that way meant no migration on existing tasks and
no way for "the accountable person" to be recorded twice and disagree. Rows are
hard-deleted like `action_watchers` — who was assigned when is already in the
audit trail, and a soft delete would fight the UNIQUE constraint the moment
somebody is taken off a task and put back on.

**Daily updates** (`action_updates`) are keyed
`(tenant, task, user, update_date)`, so the upsert is a constraint rather than a
convention. `update_date` is a stored date, not derived from `created_at`:
writing up yesterday at nine tomorrow morning should still land on yesterday.
`status_at_update` freezes the task status as it stood, so a progress history
still reads correctly once the task has been closed.

**Reimbursements** are three tables. `reimbursements` holds the claim and its
current `status`; `reimbursement_events` holds every transition — who, when,
from which status, to which, and the note — because a money decision should be
readable as a story rather than reconstructed from a scatter of timestamps on
the row. `expense_categories` is per-tenant reference data, seeded at
provisioning and back-filled lazily for workspaces that predate the module.
Bills reuse `attachments` with `entity = 'reimbursement'`; the file routes carry
a per-entity access guard so a receipt is exactly as private as the claim it
hangs off, on the listing and on the raw URL alike.

**Personal to-dos** (`personal_todos`) are their own table rather than a flavour
of `action_items`. Company work is assigned, escalated, reported on and visible
to managers; a personal list is none of those things, and giving the two the
same table would have made every existing action-item query responsible for
excluding it. Privacy here is structural, not a permission: every statement pins
`user_id`, and no role widens it.

**JSON columns** carry the deliberately flexible parts — SOP checklists, KPI
definitions, report metric lists, notification preferences. These map to `jsonb`
in Postgres.

---

## 4. The deadline engine

This is the spine of the product and the reason it is one platform rather than
several.

Every module that owns a date calls `upsertDeadline()` instead of writing its own
reminder logic:

| Source | Registered when |
|---|---|
| Action item | Created or its due date changes |
| Invoice | Sent, and re-synced hourly while unpaid |
| Proposal | Sent, against its validity date |
| Follow-up | A client's next action date is set |
| Leave request | Submitted, against the requested start |

`runDeadlineLadder()` walks every pending deadline and sends the rung that is due
— T-3d, T-1d, on the day, then daily once overdue. Each rung is deduped by
`(deadline, rung)`, so the job is safe to run as often as you like. Past its
configured escalation window, the item escalates to the reporting manager and the
escalation is logged, notified and webhooked.

The consequence: **one place to change how chasing works**, one delivery log to
audit, and a manager report that draws on real escalation records rather than
anecdote.

---

## 5. Notification providers

`services/notifications.js` is a provider interface (AR4). Channels are
`in_app`, `whatsapp`, `email`, `teams`, `push`; providers are `log`, `meta`,
`smtp`, `teams`.

Every send is written to the `notifications` table with its status, provider,
provider reference and any error — that is the delivery log the PRD asks for
(B5), and it is what the Notifications → Delivery log screen reads.

Templates are per tenant and per channel, with a documented placeholder set and a
"send me a sample" button so copy can be checked before it reaches a client.

Channel preferences resolve in three steps: platform defaults → the user's global
channel toggles → their per-event overrides.

---

## 6. Client scoring

Four scores on 0–100, each from real records:

| Score | Built from |
|---|---|
| **Conversion** | Stage probability, stage velocity against its SLA, reply rate on outbound touchpoints, recency |
| **Risk** | Average days late across settled invoices, overdue exposure relative to lifetime billing, grievances in the last 90 days, delivered-versus-committed scope |
| **Relevancy** | Industry against the tenant's ideal-client profile, service-line overlap, deal size against target, engagement model |
| **Retention** | 30-day engagement trend, renewal proximity, satisfaction, delivery ratio, payment reliability |

Health blends them, with risk inverted: `0.2 · conversion + 0.15 · relevancy +
0.4 · retention + 0.25 · (100 − risk)`.

Two design decisions worth stating:

- **Every component is returned.** The `breakdown` carries each input, so the UI
  answers "why is this 43?" instead of asking for trust. A score nobody can
  interrogate gets ignored.
- **Overrides are structured.** Judgement belongs in the model, but it arrives as
  a signed delta with a reason code from a managed list, an optional expiry, and
  the name of whoever applied it — visible in the scorecard.

Scores recompute nightly with a dated snapshot, which is what the trend chart
reads.

---

## 7. Invoice numbering

The full argument is in the README. In code:

- `allocateNumber()` does `INSERT … ON CONFLICT DO NOTHING` then
  `UPDATE … SET last_seq = last_seq + 1 … RETURNING last_seq` against
  `invoice_counters`, keyed on `(tenant, doc_type, financial_year, prefix)`.
- Callers must run it inside the transaction that inserts the invoice.
  `createInvoice()` is the single path both the API and the recurring-invoice job
  use, so this cannot be got wrong in one place and right in another.
- `numberingAudit()` counts duplicates and gaps; it runs on every load of the
  invoice list and on the settings screen.

GST is computed in `services/gst.js` — intrastate splits into CGST + SGST with the
halves reconciled so they always sum to the full rate, interstate charges IGST,
exports are zero-rated, and the invoice total rounds to a whole rupee with the
difference carried as an explicit round-off line.

---

## 8. Background jobs

`services/jobs.js` runs an in-process scheduler with the job keys the production
target would register with BullMQ:

| Job | Cadence | Does |
|---|---|---|
| `deadlines.ladder` | 15 min | Reminder rungs and escalations |
| `invoices.deadlines` | hourly | Marks overdue, re-registers due dates |
| `crm.follow_ups` | hourly | Registers next actions, flags leads without one |
| `webhooks.flush` | 1 min | Delivers queued webhooks with backoff |
| `action_items.recurring` | daily | Rolls recurring items forward |
| `invoices.recurring` | daily | Materialises retainer invoices as drafts |
| `crm.scores` | daily | Recomputes and snapshots client scores |
| `dashboard.intel` | daily | Improvement flags and metric snapshots |
| `notifications.daily_digest` | daily | Per-user morning summary |
| `reports.scheduled` | daily | Daily/weekly/monthly and saved reports |
| `close.monthly` | 1st | Performance reviews, profitability, client reports |

Every run is recorded in `job_runs` with its status, row count and any error —
which is what the platform console's health tab reads. A super admin can force
any job from that screen.

**Why in-process:** the PRD targets Redis and BullMQ, and it should. What matters
for the port is that the handlers are already pure functions with no scheduler
coupling. Swapping the scheduler does not touch them.

---

## 9. Reporting

Reports are generated into `report_runs` as a structured payload, then rendered.
The same payload drives the on-screen report and the PDF, so they cannot disagree.

Client-facing monthly reports (G2) are generated into an `approved` gate before
dispatch — a client report going out unreviewed is worse than one going out late.
Dispatch renders the branded PDF, sends through the chosen channels and records
the outcome.

PDFs are drawn with PDFKit using the tenant's own colours and identity, which is
what "branded per tenant visual identity" requires.

---

## 10. Mobile

The mobile app is deliberately narrow. The PRD asks for the six highest-frequency
actions, and that is exactly what it has: check in/out, quick-add an action item,
approve, log a follow-up, read alerts, glance at the dashboard.

**Offline (AR5).** Writes go through `writeOrQueue()`: it tries the API, and on a
*network* failure — not a validation or permission failure, which are real answers
— queues the operation locally with a device-generated id. `POST /sync/queue`
replays them; the id makes a retried flush idempotent.

Conflicts are last-write-wins **and reported**. When an offline edit overwrites a
newer server version, the response says so and the app tells the user, rather than
silently discarding someone's work.

`GET /sync?updated_since=` is the delta pull. Employees sync only their own slice,
which keeps the payload small on mobile data.

---

## 11. Front-end

React 19, TypeScript, Tailwind v4, TanStack Query, React Router, Recharts.

- **Design tokens in CSS, not Tailwind config.** Every colour is a variable
  defined in both light and dark, so no colour exists in only one theme. The
  tenant's brand colour overrides `--brand` at runtime.
- **Route-level code splitting**, so first paint stays small on 4G.
- **TanStack Query** for server state, with 401/403/404/422 excluded from retries
  — those are answers, not transient faults.
- **Token refresh is single-flight.** Concurrent 401s share one refresh instead of
  racing and invalidating each other's rotated tokens.
- **Accessibility**: visible focus rings, 44px touch targets, labelled icon
  buttons, status conveyed by text as well as colour, `prefers-reduced-motion`
  respected, tables scroll inside their own container so the page never scrolls
  sideways.

---

## 12. Deviations and how to undo them

### SQLite instead of PostgreSQL

`node:sqlite` needs no server and no native build, so `npm install && npm run dev`
works anywhere. The schema is written to port mechanically:

| SQLite | PostgreSQL |
|---|---|
| `TEXT` id | `uuid` |
| `INTEGER` money | `bigint` (already minor units) |
| `TEXT` JSON | `jsonb` |
| Repository tenant scoping | Same, plus RLS policies |
| `INSERT … ON CONFLICT DO NOTHING` | Same syntax |
| `UPDATE … RETURNING` | Same syntax |

The work is the driver in `db/index.js` and the type changes in `schema.sql`.
Everything above the repository layer is untouched.

### In-process SSE fan-out instead of a pub/sub bus

Live chat delivery is an `EventEmitter` in `services/chat.js` that every connected
SSE response subscribes to. That is correct for one node and wrong for two: a
second instance would not see the first one's messages.

*To undo:* replace `bus.emit` / `bus.on` with a Redis (or NATS) pub/sub client.
The call sites do not change — `publish()` and the `/chat/stream` handler are the
only two places that touch the emitter. Nothing else needs to know, because the
stream is an optimisation: clients refetch on each event and see the same rows
they would have seen on their next poll, so a missed event delays a message
rather than losing it.

### In-process jobs instead of BullMQ

Handlers are already independent functions. `startJobRunner()` is the only thing
that would be replaced.

### Local files instead of S3

`config.storageDir` and the file routes are the whole surface.

### Logging notification providers

`services/notifications.js` already has the Meta Cloud API adapter written; it
needs credentials. Gupshup and WATI would be sibling adapters with the same
`send({ channel, to, subject, body })` shape.

---

## 13. Security posture

- Argon2-class hashing via bcrypt with per-user salts.
- Access tokens are short-lived; refresh tokens are stored hashed, rotate on use,
  and are revoked in bulk on password change.
- TOTP two-factor (RFC 6238), implemented against `node:crypto` with a ±1 step
  drift window.
- Helmet security headers, per-tenant rate limiting, idempotency keys on money
  endpoints.
- Sort parameters resolve through a whitelist map, so `?sort=` can never reach SQL.
- File serving checks the tenant prefix on attachments and requires a recorded
  path for generated documents.
- The audit log records actor, entity, action and before/after values for every
  create, update, delete and approval.
- The data export omits password hashes, 2FA secrets and invite tokens even when
  an owner requests it.
