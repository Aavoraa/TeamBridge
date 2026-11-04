# Workflows

What the system actually *does* when nobody is watching it. `ARCHITECTURE.md`
explains how the parts are built; this document explains how they behave over
time — the state machines, the automated ladders, and the scheduled jobs that
move records from one state to the next.

For the process by which this software gets changed and shipped, see
[`SDLC.md`](SDLC.md).

---

## 1. The two kinds of workflow

Everything below is one of two things:

| | Driven by | Where it lives |
|---|---|---|
| **Actor workflows** | A person clicking something | `server/src/routes/*.routes.js` |
| **System workflows** | The clock | `server/src/services/jobs.js` |

The important design decision is that no actor workflow schedules its own
reminders. When a route creates something with a date on it, it registers that
date with the deadline engine (`upsertDeadline`) and stops caring. One engine
owns every reminder, escalation and delivery record in the product.

---

## 2. The scheduled job table

`startJobRunner()` ticks every `JOB_TICK_MS` (default 60s) and runs whatever is
due. Times are UTC; the daily digest lands at 08:30 IST.

| Job key | Cadence | What it does |
|---|---|---|
| `webhooks.flush` | every 1 min | Drains the outbound webhook queue |
| `deadlines.ladder` | every 15 min | Reminder rungs + escalations for every pending deadline |
| `invoices.deadlines` | hourly | Registers/refreshes deadlines for unpaid invoices |
| `crm.follow_ups` | hourly | Registers follow-up deadlines; flags leads with no next action |
| `action_items.recurring` | 00:00 | Rolls completed recurring items to their next occurrence |
| `invoices.recurring` | 01:00 | Issues invoices from recurring templates |
| `crm.scores` | 02:00 | Recomputes all four client scores and snapshots them |
| `dashboard.intel` | 02:00 | Improvement flags + metric snapshots |
| `notifications.daily_digest` | 03:00 | Per-user digest of what is due |
| `reports.scheduled` | 03:00 | Runs and dispatches subscribed reports |
| `reports.weekly_escalation` | 04:00 Mon | Manager report of unresolved escalations |
| `close.monthly` | 04:00 on the 1st | Monthly close (§8 below) |

Every run writes a row to `job_runs` with status, duration and a processed
count, so a job that silently stopped working is visible rather than inferred.
A failing job records the error and does not block the others in the tick.

`JOB_REGISTRY` exposes the same handlers by key so the Super Admin console can
force any job on demand — which is also how you test a monthly workflow without
waiting a month.

**Turn it off with `JOBS_ENABLED=false`.** Note the coupling: with the runner
off, deadlines are still *registered* by the routes but no reminder is ever
sent and nothing ever escalates. The test suite runs with it off deliberately.

---

## 3. The deadline ladder

The single mechanism behind every reminder in the product.

```
register        →  pending
                     │
   ┌─────────────────┼─────────────────┐
   ▼                 ▼                 ▼
 T-3d              T-1d               due          (reminder rungs)
                                       │
                                       ▼
                                    overdue  ──── daily reminders
                                       │
                        past `escalation_days`
                                       ▼
                              escalation level 1  → owner's manager
                                       │
                          unresolved past SLA (24h)
                                       ▼
                              escalation level 2  → and upward
```

Properties worth knowing:

- **Idempotent.** `runDeadlineLadder()` is safe to run repeatedly; each rung is
  deduped by `(deadline, rung)` in `ladder_sent`. A restart mid-ladder does not
  double-send.
- **A moved due date resets the ladder.** `upsertDeadline` clears `ladder_sent`
  when `due_at` changes, so pushing a deadline out re-arms the reminders rather
  than silently skipping them.
- **Escalation is time-gated, not tick-gated.** A new level is only raised once
  the previous one has aged past its `sla_hours`, so a 15-minute tick cannot
  ratchet an item to level 6 in an afternoon.
- **Escalation windows are per action category.** A grievance escalates after
  1 day, an internal task after 5. The default is 3.
- **Resolution is explicit.** `resolveDeadline(..., 'met' | 'cancelled')` is
  called by the owning module when the underlying record closes. A deadline
  nobody resolves keeps escalating — which is the intended behaviour.

Registered sources: `action_item`, `invoice`, `proposal`, `follow_up`, `leave`.

---

## 4. Action items

```
open → in_progress → done
  │                    ▲
  └──── blocked ───────┘
```

- Creation registers a deadline with the owner's manager as the escalation
  target and the category's escalation window.
- Completion resolves the deadline as `met`.
- A `done` item carrying a recurrence rule is a **template**: the
  `action_items.recurring` job creates the next occurrence at 00:00 UTC,
  registers its deadline, and links it to the original through
  `recurrence_parent_id`. Occurrences are only created up to 30 days ahead,
  and an existing occurrence for that date is never duplicated.
- Meeting minutes (MOM) create action items directly, which is what makes a
  meeting produce tracked work rather than a document.

### 4b. Assignment and the daily update

Every task carries one **accountable** person (`owner_id`) and, when several
people work it, a list of co-assignees (`action_assignees`). Assigning to a team
means choosing a project: everyone seated on it is assigned, and one of them is
named accountable. Only the accountable column drives the deadline ladder — an
escalation needs one name, not four.

```
create ──▶ assign ──▶ the assignee works it ──▶ daily update ──▶ manager reviews ──▶ done
             │                                       │                  │
      individual or a                        six fields, one            team board,
      project team, one                      per person per             including who
      accountable                            task per day               said nothing
```

The update is upserted per person per task per day: logging at noon and again at
six leaves one entry, not two, and the second call **merges** — a field left out
keeps its value, only an explicit null clears it. Sending `status` alongside
moves the task on in the same action, which is what stops "I finished it" sitting
next to a task still marked open.

- **Blockers are the one part somebody else must act on**, so writing one notifies
  the accountable owner and the reporting manager the same day, deduped per
  person per task per day.
- **Silence is reported.** The manager board lists a report with open work and no
  update as `silent`, and names the tasks they said nothing about. Somebody with
  no open work is `no_open_tasks`, not silent — a quiet day is not a missed one.
- **The reminder** (`action_items.update_reminder`, 12:00 UTC / 17:30 IST) sends
  one message per person naming what is unwritten, deduped on the date so a
  restart or a forced re-run cannot send it twice.
- **Scope.** An employee sees only their own; a manager sees direct reports plus
  themselves; an admin sees the workspace. The employee view and the team view
  are the same data read through that filter.

---

## 5. CRM: lead to client

```
lead ──► follow_up ──► proposal ──► onboarding ──► execution ──► invoicing ──► retention
                          │                                                        │
                          └── rejected / lost ──► churn (structured reason code) ◄──┘
```

**The follow-up SOP (PRD workflow 1).** Every lead and active client must carry
a `next_action` and a `next_action_date`. The hourly `crm.follow_ups` job does
two things with that rule:

1. For records that have one — registers it as a `follow_up` deadline owned by
   the next-action owner, escalating to their manager after 3 days.
2. For records that do not — notifies the owner (`lead.no_next_action`), deduped
   to once per day per client. A lead with no next action is treated as a defect,
   not a neutral state.

**Proposals.**

```
draft ──► sent ──► viewed ──► accepted
                     │
                     ├──► rejected
                     └──► expired
```

Sending generates a PDF and a share token. `/p/:token` opens without
authentication and flips `sent → viewed` on first open. Acceptance is
captured with name, IP and timestamp, advances the client to **Onboarding**,
resolves the proposal deadline as `met`, and logs a positive engagement event
that feeds the conversion score. A `draft` proposal 404s on the public link —
it does not exist until it is sent.

**Client scoring.** Nightly, `crm.scores` recomputes conversion, risk,
relevancy and retention from engagement and payment history, blends them into a
health score, and snapshots the result so movement is visible over time. Every
score returns a `breakdown` — the Scorecard tab explains *why* a number moved.
Manual overrides are allowed but must carry a structured reason code.

**Churn.** The API rejects a churn without a reason code drawn from the managed
list. That constraint is the whole point: it makes "why did we lose them"
answerable across a year of records instead of a hundred differently-worded notes.

---

## 6. Invoicing (PRD workflow 4)

```
milestone/manual ──► draft ──► (finance approves) ──► sent ──► partially_paid ──► paid
                       │                               │
                       │                               └──► overdue ──► escalation
                       │
                       └──► deleted            sent ──► written_off / credit note
```

Rules the state machine enforces:

- **Only a `draft` can be edited or deleted.** Once sent, a correction is a
  credit note or a write-off, so the number sequence stays continuous.
- **Only a `draft` needs approval.** Re-sending is allowed from `draft`, `sent`
  or `overdue`, and never regresses a paid invoice.
- **A fully paid invoice cannot be written off.**
- **Numbering is claimed inside the write transaction** by an atomic
  `UPDATE … RETURNING`, backed by `UNIQUE (tenant_id, number)`. Two concurrent
  saves cannot take the same number; a bug elsewhere surfaces as a rejected save
  rather than a duplicate on a client's desk. Duplicates and gaps are counted on
  every list load.
- **Payment endpoints honour `Idempotency-Key`.** A replayed request returns the
  stored response rather than creating a second invoice or a second payment.

Two jobs keep it moving without anyone opening the app: `invoices.recurring`
(01:00) issues from templates and advances `next_run_date` by the frequency, and
`invoices.deadlines` (hourly) keeps every unpaid invoice registered with the
deadline engine so the overdue ladder and manager escalation apply to money the
same way they apply to tasks.

---

## 7. HR

- **Attendance** — self-service check-in; managers approve and export.
- **Leave** — request → manager approval, registered as a `leave` deadline so a
  request nobody actions escalates like anything else.
- **Performance** — not hand-written. `close.monthly` generates a review per
  active employee from real data: action items assigned, completed, completed
  on time, and attendance in the period. Existing reviews for a period are never
  overwritten.
- **Hiring** — a pipeline of candidates and stages; manager-approved.

---

## 8. Reimbursement (PRD workflow I)

An employee spends their own money on company business and asks for it back.
Two gates stand between the claim and the payout.

```
draft ──▶ submitted ──▶ manager_approved ──▶ approved ──▶ paid
  │          │  gate 1        │  gate 2          │  finance
  │          │  manager       │  finance         │
  │          ▼                ▼                  │
  │      rejected         rejected               │
  └──▶ deleted        (with a reason, always)    └── payment recorded:
       (draft only)                                  method, reference, date
```

- **Routing.** On submit the claim takes a number (`REIMB-<year>-<seq>`, so a
  draft never burns one) and goes to the claimant's reporting manager. With no
  manager on file it skips straight to the finance desk rather than sitting in
  a queue nobody owns — and the trail records that it did.
- **Gate 1, the manager.** Holding `reimbursements:approve` is not enough on its
  own: the claim has to be routed to them or belong to one of their reports.
  Nobody decides their own claim. Finance-side admins can step in, which is what
  keeps a claim moving while a manager is away.
- **Gate 2, finance.** Verifies the bills, then approves — optionally for less
  than was claimed — or rejects. A payment can never exceed the approved amount.
- **Rejection always carries a reason**, because the claimant is the one who has
  to act on it. They can fix the claim and send it round again; resubmitting
  clears the old rejection.
- **Withdrawal** is the claimant's own escape hatch while nobody has decided.
- **Editing stops at submission.** Once a claim is in a queue the numbers an
  approver is looking at must not move under them.
- **Documents.** Bills hang off the claim as attachments. A category can require
  one, in which case submission is refused until a bill is attached. A receipt
  is exactly as private as the claim: the claimant, the approving manager and
  the finance desk, and nobody else — enforced on the listing *and* on the raw
  file URL, so guessing the path is not a way round it.
- **Every transition is logged** to `reimbursement_events` with who, when, from
  which status, to which, and any note. `status` answers "where is it now";
  the events answer "how did it get there".
- **Notifications** at each hand-off: to the manager on submit, to the finance
  desk on manager approval, to the claimant on every decision and on payment.

---

## 9. My Day

Each person's own daily to-do list — call the client back, write the EOD report.
Deliberately not action items: nothing here is assigned, escalated, reported on
or rolled into anyone's dashboard.

Privacy is structural rather than a permission. Every statement pins
`user_id = <the caller>`, and no query parameter, role or module action widens
it — an owner reading someone else's list would need a new endpoint, not a new
permission. Unfinished items carry forward onto the next day so they are visible
rather than quietly lost, and are counted separately so it is obvious they did.

---

## 10. Monthly close

Runs 04:00 UTC on the 1st, over the previous month, for every active tenant:

1. Performance reviews generated from completion and attendance data.
2. KPI reviews raised.
3. Profitability computed per client and project.
4. Client monthly reports generated and queued **for approval** — a client-facing
   report is never dispatched by a job without a human approving it.

Idempotent per tenant per period: a second run creates nothing that already
exists, so it is safe to force from the admin console.

---

## 11. Notifications

One delivery path for everything above.

```
event ──► preference check (per user, per channel, per event key)
            ──► dedupe key ──► provider ──► delivery log
```

- **Channels:** in-app, email, WhatsApp, Teams webhook. Push (FCM/APNs) is
  modelled and preference-controlled but has no sender.
- **Providers are pluggable and default to `log`.** With `WHATSAPP_PROVIDER=log`
  and `EMAIL_PROVIDER=log`, every notification is written to the delivery log and
  printed as structured JSON instead of being sent — the entire reminder and
  escalation chain is exercisable without a WhatsApp account.
- **Dedupe keys are mandatory on recurring notifications.** They are what stops
  a 15-minute ladder tick from sending the same overdue nudge 96 times a day.
- Every attempt lands in the delivery log whether it succeeded or not, which is
  what makes "did the client actually get told" answerable.

---

## 12. Access and tenancy

Every workflow above runs inside a tenant.

- The access token carries `tenant_id`; a repository layer injects it into every
  query, so no route hand-writes `tenant_id = ?`.
- **Cross-tenant reads return 404, not 403** — another tenant's records do not
  exist for you rather than existing-and-refused.
- Permissions are `module × action` (26 modules × 6 actions) driven by role
  templates: `super_admin`, `owner`, `manager`, `finance`, `hr`, `employee`,
  `client`. Higher plans overlay `custom_roles.permissions` on top.
- Employees are additionally scope-filtered to their own records inside the
  modules they can see.
- **`projects` is its own module, not part of `crm`.** Who may run a project is
  a different question from who may work a deal. An employee holds `view` only:
  they see every project and every seat on every team, and cannot create, edit,
  restaff or delete one. Both `/projects` and the older `/finance/projects`
  mount carry the same guards.
- **`reimbursements` and `reimbursement_finance` are separate modules**, so
  approving your team's claims and running the finance desk are distinct
  powers. A manager holds the first and not the second.

**Onboarding paths.** Signup provisions a tenant. Team invites send a tokenised
`/accept-invite` link. Password recovery goes through a per-account security
question. All three build their links from `WEB_BASE_URL` — if that is unset in
production, every invite you send points at the recipient's own machine.

---

## 13. Sync and offline

Mobile uses the same API. `sync.routes.js` exposes a delta endpoint keyed on a
cursor; the client replays queued mutations with idempotency keys on reconnect,
so a mutation made on a train is applied once, not twice or never.

---

## 14. Where a workflow can silently stop

Honest list of the failure modes, since none of them raise an alarm on their own:

| Symptom | Look at |
|---|---|
| No reminders anywhere | `JOBS_ENABLED`, then `job_runs` for `deadlines.ladder` |
| Nobody is nudged for daily updates | `job_runs` for `action_items.update_reminder`; it only fires at 12:00 UTC |
| A task never asks for an update | It is `done`/`cancelled`, or nobody is assigned to it |
| Reminders but no escalations | `users.manager_id` unset — escalation with no target is a no-op |
| Nothing escalates in one category | `action_categories.escalation_days` |
| Notifications "sent" but nobody got them | Provider still `log`; check the delivery log |
| Invite and share links point at localhost | `WEB_BASE_URL` |
| Recurring invoices stopped | `recurring_invoices.active`, `next_run_date` in the future |
| Data lost after a restart | Free-tier ephemeral disk; see `DEPLOY.md` and the snapshot service |
| Claims stuck at "awaiting manager" | `users.manager_id` unset, or the manager is inactive — finance can step in |
| A claim will not submit | Its category requires a bill and none is attached |
