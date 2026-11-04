# Phoenixx OS

Integrated agency operations and tracking suite — action items and MOM, a central
deadline engine, HR, SOP/KPI libraries, CRM through to invoicing, client scoring,
reporting, and an overview traction dashboard. Multi-tenant from day one, with a
web app and a mobile app over one shared API.

Built to the PRD in [`../phoenixx-os-requirements.md`](../phoenixx-os-requirements.md).

---

## Run it

```bash
npm install
npm run seed
npm run dev
```

Then open **http://localhost:5173** and sign in with any of the demo accounts
listed on the login screen (password `Phoenixx@2026`):

| Role | Email | What they see |
|---|---|---|
| Owner | `arun@phoenixxit.com` | Everything |
| Manager | `divya@phoenixxit.com` | Their team, approvals, escalations |
| Finance | `meera@phoenixxit.com` | Invoices, costs, profitability |
| HR | `sanjay@phoenixxit.com` | Attendance, leave, performance, hiring |
| Employee | `priya@phoenixxit.com` | Only their own work |
| Platform admin | `platform@phoenixxit.com` | Tenant console (`Platform@2026`) |

**Forgot your password?** on the login screen recovers an account through its
security question. Every seeded account answers the same one — *"Which city were
you in when you started your first job?"* — with **Coimbatore**. Real accounts
set their own question when they accept an invitation or sign up.

`npm run seed` builds Phoenixx IT as tenant #1 with three months of realistic
history — 15 clients across the pipeline, 26 invoices, costs, attendance, SOP
runs and a hiring pipeline — plus a second tenant so isolation is visible rather
than asserted.

Other commands:

```bash
npm run reset     # drop the database and re-seed from scratch
npm test          # 244 tests
npm run build     # production build of the web app
```

> **Port note.** The API defaults to `4010` and the web app to `5173`. Both can be
> overridden with `PORT`; the Vite dev server proxies `/api` to the API.

---

## What is here

```
phoenixx-os/
├── server/     Node + Express API, SQLite, background job runner
├── web/        React + TypeScript + Tailwind (the full product)
├── mobile/     React Native (Expo) — the six highest-frequency actions
└── docs/       Architecture, workflows, the development cycle, PRD traceability
```

### The nine modules

| | Module | Where it lives |
|---|---|---|
| **A** | Action items, assignment, daily updates, meetings, MOM | `action-items`, `meetings` |
| **B** | Deadline engine, alerts, escalations | `deadlines`, `notifications` |
| **C** | Attendance, leave, performance, hiring | `hr` |
| **D** | SOP library and KPI/KRA definitions | `sop` |
| **E** | CRM pipeline, proposals, client scoring | `crm`, `proposals` |
| **F** | Invoicing, costs, profitability, projects | `invoices`, `finance`, `projects` |
| **G** | Internal and client-facing reporting | `reports` |
| **H** | Overview traction dashboard | `dashboard` |
| **I** | Expense reimbursement, approval chain, payout | `finance/reimbursements` |

Plus **My Day** (`todos`) — each person's own private daily list, which belongs
to nobody's module because it is nobody else's business.

### Documentation

| Document | Answers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the system is built, and every deliberate deviation from the PRD |
| [docs/WORKFLOWS.md](docs/WORKFLOWS.md) | What it does on its own — state machines, the deadline ladder, the scheduled jobs |
| [docs/SDLC.md](docs/SDLC.md) | How a change gets built, tested and shipped, and where the process still has gaps |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Hosting it, on the free tier or with a real disk |
| [docs/PRD-COVERAGE.md](docs/PRD-COVERAGE.md) | Which requirement is satisfied where |

---

## The parts worth knowing about

### Invoice numbering

The PRD names a duplicate-invoice-number defect as the reference bug. Four things
prevent it, and the Settings → Invoicing screen explains them to the user:

1. The sequence is claimed by an atomic `UPDATE … RETURNING` inside the same
   transaction that writes the invoice, so two concurrent saves cannot read the
   same counter.
2. `UNIQUE (tenant_id, number)` means even a bug elsewhere surfaces as a rejected
   save rather than a duplicate on a client's desk.
3. A sent invoice cannot be deleted — corrections go through a credit note or a
   write-off, so the sequence stays continuous.
4. Duplicates and gaps are counted on every load and shown on the invoice list.

The numbering scheme is tenant-editable (`{prefix}/{fy}/{seq:4}` and friends), and
changing it once invoices exist requires an explicit override.

### The deadline engine

Every module that owns a date registers it with one engine rather than writing its
own reminders: action items, invoices, proposals, follow-ups and leave approvals.
One reminder ladder (T-3d, T-1d, due, then daily), one escalation path to the
reporting manager, one delivery log. Escalation windows are configured per action
category, so a grievance escalates after a day and an internal task after five.

### Client scoring

Four independent scores computed from real engagement and payment data —
conversion, risk, relevancy, retention — blended into a health score. Every
component is returned in a `breakdown`, so the Scorecard tab can explain *why* a
number moved rather than showing an unexplained figure. Manual overrides are
possible but always carry a structured reason code, never free text.

### Structured reason codes

Retention-risk flags, churn reasons and score adjustments all draw from a managed
list. That is what makes "why did we lose them" answerable across a year of
records instead of a hundred differently-worded notes. The API rejects a churn
without a reason code.

### Assignment and the daily update

`action_items.owner_id` is the one person **accountable** — the reminder ladder
and every escalation target read that single column, and exactly one name has to
answer for a due date. `action_assignees` holds everyone *else* working the task,
so the effective team is the owner plus those rows. Deliberately additive: no
existing task needed a backfill, and the accountable person cannot drift out of
step with itself. Assigning to a team means picking a project: everyone seated on
it becomes an assignee, and one of them is named accountable.

On top of that sits the **daily update** — the standup, written down. One row per
person per task per day, upserted, with six fields in a fixed order: what moved,
what is moving, what has not started, what is in the way, what happens next, and
anything else. A field left out of a later call keeps its value; only an explicit
null clears it, so adding a blocker at four o'clock cannot wipe what was written
at ten.

Two views read it. The employee sees what is on them, what still owes an update
and what they have written; the manager sees one row per report for a chosen day,
**including the people who wrote nothing** — silence is the thing a manager most
needs to see, so "no update" is reported as loudly as an update is. Somebody with
no open work is not counted as silent.

An end-of-day job (`action_items.update_reminder`, 12:00 UTC / 17:30 IST) sends
one message per person listing what they have not written up — one message, not
one per task, because five nudges is how a reminder becomes noise.

### The reimbursement chain

An expense claim passes two gates before money moves:

```
draft ─▶ submitted ─▶ manager_approved ─▶ approved ─▶ paid
           manager        finance          finance     finance
```

Either gate can reject instead, and a rejection has to carry a reason. The
claimant can withdraw while nobody has decided, and can fix and resubmit a
rejected claim. With no reporting manager on file the first gate is skipped
rather than left in a queue nobody owns.

`status` says where a claim sits now; `reimbursement_events` holds the whole
trail, because a money decision should never have to be reconstructed from a
set of timestamps. Three separate questions decide what a caller may do, and
all three are answered server-side on every request: whose rows they can see
(own / own team / all), whether they may act at the manager gate, and whether
they may act at the finance desk. A receipt is exactly as private as the claim
it hangs off — guessing the file URL does not get round that.

### Read-only projects

Who may run a project is a different question from who may work a deal, so
projects have their own permission module rather than borrowing `crm`. An
employee holds `view`: they see every project and every seat on every team, and
cannot create, edit, restaff or delete one. Both mounts (`/projects` and the
older `/finance/projects`) carry the same guards — hiding the buttons is
presentation, not enforcement.

### Tenant isolation

The access token carries `tenant_id`; a repository layer injects it into every
query so no route hand-writes `tenant_id = ?`. Cross-tenant reads return **404**,
not 403 — another tenant's records simply do not exist for you. There are tests
for this at both the service and API layers.

---

## Tests

```bash
npm test
```

327 tests across GST computation, invoice numbering, client scoring, invoicing,
billing, reimbursement approval and payment, task assignment and daily updates,
project permissions, personal to-do privacy, database snapshots and API
integration (auth, RBAC, tenant isolation, idempotency, mobile sync, audit trail).

The PRD asks for ≥70% coverage on scoring, invoicing and billing logic:

| Module | Line coverage |
|---|---|
| `services/scoring.js` | 100% |
| `services/invoicing.js` | 100% |
| `services/numbering.js` | 100% |
| `services/gst.js` | 100% |
| `routes/billing.routes.js` | 94% |

The uncovered billing lines are the Razorpay and Stripe HTTP calls, which need
real gateway credentials to exercise.

---

## Configuration

Copy `.env.example` to `.env`. Everything has a working default, so the app runs
with no configuration at all; the variables matter when you connect real services.

| Variable | Purpose |
|---|---|
| `PORT` | API port (default 4010) |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | **Change these before deploying.** Production refuses to start with the dev defaults — see [docs/DEPLOY.md](docs/DEPLOY.md) |
| `WHATSAPP_PROVIDER` | `log` (default), `meta`, `gupshup`, `wati` |
| `EMAIL_PROVIDER` | `log` (default) or `smtp` |
| `TEAMS_WEBHOOK_URL` | Incoming webhook for Teams alerts |
| `RAZORPAY_KEY_ID` / `STRIPE_SECRET_KEY` | Subscription billing |
| `JOBS_ENABLED` | Set `false` to stop the background runner |

With the default `log` providers every notification is written to the delivery log
and printed as structured JSON instead of being sent, so the whole reminder and
escalation chain is exercisable without a WhatsApp account.

---

## Deliberate deviations from the PRD

These are documented rather than hidden — see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the reasoning and the migration
path for each.

| PRD says | Built as | Why |
|---|---|---|
| PostgreSQL | PostgreSQL (Neon / Supabase in production, in-process PGlite for local dev and tests) | Done. Local dev still needs zero setup; tenant scoping sits in a repository layer that Postgres RLS can slot under. |
| Redis + BullMQ workers | In-process job runner | Same job keys and handler signatures; moving to BullMQ means registering the same handlers with a queue. |
| S3 object storage | Local filesystem behind a storage path | One module to swap. |
| Meta/Gupshup WhatsApp | Provider interface with a logging default | The interface is the deliverable (AR4); credentials plug in. |

---

## Not built

- **Client portal** — the PRD recommends post-MVP, and the plan matrix already
  carries the feature flag. Portal users exist in the role model and can read
  their own reports, proposals and invoices through the API; there is no separate
  portal UI.
- **Push notifications (FCM/APNs)** — needs device tokens and app-store
  credentials. The channel is modelled and preference-controlled; the sender is
  the missing piece.
- **Tally/Zoho API integration** — CSV export is built, as the PRD specifies for
  v1.
