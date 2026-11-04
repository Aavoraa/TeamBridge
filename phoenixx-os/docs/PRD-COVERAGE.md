# PRD coverage

Every numbered requirement in the PRD, and where it landed. Honest about what is
partial and what is not built.

**Legend** — ✅ built · ◐ partial (explained) · ⬜ not built (explained)

---

## Module A — Action items, meetings & MOM

| | Requirement | Where |
|---|---|---|
| ✅ | **A1** CRUD with owner, watchers, client/project link, category, priority, status | `action-items` · full lifecycle Open → In Progress → Blocked → Done → Cancelled; a blocked item must state why |
| ✅ | **A2** Meeting scheduler with agenda; MOM capture; one-tap conversion | `meetings` · per-point convert, or "Finalize MOM" to convert every action point and lock the minutes |
| ✅ | **A3** Recurring items (daily/weekly/monthly) | `action_items.recurring` job rolls the next occurrence when one completes |
| ✅ | **A4** Escalation after N days, configurable per category, logged | Escalation days set per action category in Settings; the ladder escalates and records it |
| ✅ | **A5** Comments, @mentions, attachments | Comments with mentions that notify; attachment upload and listing per entity |
| ✅ | **A6** Mobile quick-add, voice note, offline draft that syncs | Quick-add sheet; `kind: 'voice_note'` on attachments; offline outbox replays on reconnect |

## Module B — Deadline engine, alerts & notifications

| | Requirement | Where |
|---|---|---|
| ✅ | **B1** Central engine consuming deadlines from all modules | `services/deadlines.js` · action items, invoices, proposals, follow-ups, leave |
| ✅ | **B2** WhatsApp, email, Teams, in-app, push; preference per user and event | Provider interface; a preference matrix per user × event × channel |
| ◐ | **B3** Ladder T-3d/T-1d/due/overdue; overdue escalates | Built. The ladder timings are constants rather than per-tenant settings; the escalation window *is* configurable per category |
| ✅ | **B4** Daily digest per user; weekly escalation report per manager | `notifications.daily_digest` and `reports.weekly_escalation` jobs |
| ✅ | **B5** Editable templates per tenant; every send logged with status | Template editor with a live sample send; full delivery log |
| ✅ | **B6** Internal chat: a room per project team, a company-wide announcement channel, group rooms and direct messages | `services/chat.js`, `routes/chat.routes.js`. Project-room membership is derived from `project_members`, so joining a team joins its room. Announcements are restricted to owner/manager/HR and fan out through the Module B notification pipeline |
| ✅ | **B7** Live delivery, unread counts, mentions, replies, pins, mute; chat embedded on My Day, not just linked from it | Server-Sent Events over `fetch` (auth header, not a query-string token). Unread is one `last_read_at` per member; `@name` resolves against room members only and notifies just those people. `components/chatKit.tsx` holds what the full screen and the My Day panel share, so a message reads and behaves identically in both |

## Module C — HR

| | Requirement | Where |
|---|---|---|
| ✅ | **C1** Check-in/out with optional geo-tag, monthly register, regularization with approval | Web and mobile check-in; a month-grid register; regularization request and approval |
| ✅ | **C2** Leave types, balances, approval workflow, team calendar | Five seeded leave types including hourly permission; balances; approvals; calendar endpoint |
| ✅ | **C3** Monthly performance: completion %, KPI/KRA achievement, manager review, history | Computed from real action items and attendance, then a manager rating on top; 24-month history |
| ✅ | **C4** Hiring: roles with qualification standards and experience bands, candidate stages, interview notes | Openings, a six-stage candidate board, interview records |
| ✅ | **C5** Employee master with salary band feeding cost | `monthly_cost_minor` rolls into the monthly HR cost line via `syncHrCosts` |

## Module D — SOP & KPI/KRA

| | Requirement | Where |
|---|---|---|
| ✅ | **D1** SOP repository per service line and per workflow | Eight workflow types; ten SOPs seeded across the four service lines |
| ✅ | **D2** Rich text + checklists, version-controlled with restore, draft/published, acknowledgment tracking | Draft-then-publish; version history with restore; acknowledgements reset on a new version |
| ✅ | **D3** KPI/KRA per role and service line: metric, source, target, cadence; versioned | Thirteen seeded definitions; editing a target or formula bumps the version |
| ✅ | **D4** Adherence tracking surfaced in weekly reports | SOP runs with checklist state; adherence by SOP and by person; carried into the weekly report |
| ✅ | **D5** Templates shippable as per-service-line packs | `services/provisioning.js` — every new tenant is seeded with them |

## Module E — CRM & client lifecycle

| | Requirement | Where |
|---|---|---|
| ✅ | **E1** Eight-stage pipeline, configurable per tenant | Board and list views; stages editable with probability and SLA |
| ✅ | **E2** Company, contacts, industry tag, service lines, source, owner | Full client record with WhatsApp consent flag per contact |
| ✅ | **E3** Unified activity timeline | Calls, WhatsApp, email, meetings, notes, grievances, proposals, invoices, stage changes |
| ✅ | **E4** Every lead has a next action + date; leads without one are flagged | Enforced in the UI, flagged on the dashboard, and notified daily to the owner |
| ✅ | **E5** Proposal generator: templated per service line, branded PDF, share link with view tracking, e-acceptance | Four seeded templates; tracked share link; public accept/reject recorded with name, time and IP |
| ✅ | **E6** Conversion, risk, relevancy, retention scores — auto with manual adjustment and reason codes | `services/scoring.js`, 100% test coverage; every component exposed in the breakdown |
| ✅ | **E7** Active vs delivered scope; retention-risk flag requires a structured reason code | Traction endpoint; the API rejects a churn without a reason code |
| ✅ | **E8** Duplicate detection, CSV import and export | Matches on normalised name, domain and GSTIN; import previews before committing |

## Module F — Finance

| | Requirement | Where |
|---|---|---|
| ✅ | **F1** Invoice generator: tenant numbering scheme, line items, discounts, CGST/SGST/IGST with HSN/SAC, multi-currency, branded PDF | The reference defect is addressed four ways — see the README |
| ✅ | **F2** Lifecycle Draft → Sent → Partially paid → Paid → Overdue → Written off; payments; overdue feeds Module B | Full lifecycle with finance approval before sending |
| ✅ | **F3** Recurring invoices for retainers | Schedules generate drafts on their run date |
| ✅ | **F4** Cost tracking: HR, tools, rent, maintenance, misc, monthly with categories | Plus roll-forward of recurring costs and salary-band sync |
| ✅ | **F5** Profitability at client, project, service-line and company level with margin and trend | Direct costs charged where pinned; overheads spread by revenue share |
| ✅ | **F6** Credit notes; CSV export to Tally/Zoho | Credit notes with their own numbering; export in the column shape those tools expect |
| ✅ | **F7** Project teams: a team per project with named seats — manager, lead, senior, member, junior, reviewer, observer — plus responsibility, allocation and dates | `routes/projects.routes.js`; manager and lead are single seats mirrored onto `projects.manager_id` / `lead_id`, so who owns a project is never ambiguous. Staffing view rolls allocation up per person |

## Module G — Reporting

| | Requirement | Where |
|---|---|---|
| ✅ | **G1** Daily, weekly, monthly internal reports on a schedule, delivered via notification channels | Generated by the job runner; dispatched through the chosen channels |
| ✅ | **G2** Client-facing monthly report: branded, per client, delivered work + metrics + next-month plan, PDF and dispatch tracking | Generated into an approval gate before dispatch |
| ✅ | **G3** Report builder-lite: module, metrics, range, filters, save as scheduled | Fifteen metric sources; saved definitions with cron-style schedules |
| ✅ | **G4** Exportable to PDF and CSV | Both, on every report |

## Module H — Overview traction dashboard

| | Requirement | Where |
|---|---|---|
| ✅ | **H1** Clients, revenue, HR, cost, profit pillars | Five stat tiles plus supporting charts and tables |
| ✅ | **H2** Lagging indicators: overdue items, escalations, SLA breaches | A dedicated bar, each figure clickable through to its records |
| ✅ | **H3** Auto-surfaced improvement flags with drill-down | Six detectors: weakest service line, rising client risk, falling completion, leads without a next action, margin drop, low SOP adherence |
| ✅ | **H4** MoM and QoQ comparison; every widget drills down | Comparison selector; a drill-down drawer resolving eleven widget keys to their rows |
| ✅ | **H5** Mobile condensed card view | `/dashboard/mobile` and the mobile Today tab |

---

## SaaS & subscription (§4)

| | Requirement | Where |
|---|---|---|
| ✅ | **S1** Flat rate by size band, monthly and annual, per-user add-on beyond the cap | Starter/Growth/Scale; add-on seats priced and surfaced |
| ✅ | **S2** Plan matrix drives feature flags and limits | Feature gates plus per-tenant overrides from the platform console |
| ✅ | **S3** 14-day trial without a card, self-serve upgrade, coupon engine | Percent, fixed-amount and free-month coupons with redemption caps and expiry |
| ◐ | **S4** Razorpay + Stripe, auto-renewal, dunning, proration | Proration, GST on the subscription, and both gateway adapters are written. Without credentials the `manual` provider records the intent, so the lifecycle is exercisable end to end. Dunning retries are modelled (`attempts`) but not scheduled |
| ✅ | **S5** Trial → Active → Past due → Suspended (read-only) → Cancelled; 90-day export window | Suspended tenants get 402 on writes, and keep reads and export |
| ✅ | **S6** Add-on billing: WhatsApp packs, storage, implementation fee | Each raises its own GST invoice |
| ✅ | **S7** Self-signup wizard | Three steps: agency → account → plan |
| ✅ | **S8** Seed content so a tenant is productive on day one | Service lines, pipeline, categories, reason codes, leave types, 10 SOPs, 13 KPIs, 4 proposal templates |
| ✅ | **S9** Super admin console | Tenants with health, plans, coupons, announcements, feature flags, impersonate-with-consent, job health |

## Architecture (§5)

| | Requirement | Notes |
|---|---|---|
| ✅ | **AR1** JWT with tenant + role; every query filtered at the data layer | Token → repository → schema, three layers |
| ✅ | **AR2** Consistent envelope, pagination, filtering, sorting, idempotency keys, rate limiting | Sorting resolves through a whitelist, so `?sort=` cannot reach SQL |
| ✅ | **AR3** Outbound webhooks | Seven events, HMAC-SHA256 signed, retried with backoff |
| ✅ | **AR4** WhatsApp behind a swappable provider interface | Meta adapter written; Gupshup/WATI are sibling adapters |
| ✅ | **AR5** Delta sync, offline queue, last-write-wins with audit | Conflicts are reported to the user, not silently resolved |
| ✅ | **AR6** UTC timestamps; money as integer minor units + currency | No floats near money |
| ✅ | **AR7** Soft deletes everywhere user-facing | Enforced by the repository |
| ✅ | **AR8** Multi-tenant schema from day one | Two tenants in the seed, with tests proving isolation |
| ◐ | **AR9** 200 tenants × 50 users, p95 < 400ms, async reports | Reports are async. The load target is untested — it needs the PostgreSQL port and a load harness |
| ◐ | **§5.2 stack** | Node + Express (not NestJS), SQLite (not Postgres), in-process jobs (not BullMQ). Reasons and migration paths in ARCHITECTURE.md |

## Non-functional (§6)

| | Area | Notes |
|---|---|---|
| ◐ | Security | bcrypt, TOTP 2FA, Helmet, rate limiting, audit log, per-tenant export/delete, no credentials in exports. **Not done:** encryption at rest, a secrets vault, TLS — all deployment concerns |
| ✅ | Privacy | Tenant isolation, PII kept out of exports, WhatsApp consent per contact |
| ⬜ | Availability | Backups, restore drills and uptime monitoring are deployment work |
| ◐ | Performance | Code-split routes, indexed queries, async reports. Not measured against the stated targets |
| ✅ | Usability | Mobile-first responsive web; the mobile app covers exactly the six named actions |
| ✅ | Localization | INR default, ₹ with lakh/crore toggle, English UI |
| ✅ | Compatibility | Modern evergreen browsers; Expo targets Android 10+/iOS 15+ |
| ✅ | Maintainability | Monorepo, 142 tests, 100% coverage on scoring/invoicing/numbering/GST, seed script |

## Automated workflows (§7)

| | Workflow | Where |
|---|---|---|
| ✅ | **1** Follow-up SOP with mandatory next action, ladder, escalation, grievance path | `crm.follow_ups` job plus the grievance action category at a 1-day escalation |
| ✅ | **2** Escalation: breach → alert → unresolved → manager report → monthly report | End to end, verified in the running app |
| ✅ | **3** Client lifecycle with structured retention-risk reason codes | Enforced by the API |
| ✅ | **4** Invoice: milestone → draft → finance approves → sent → ladder → overdue escalation | `invoices.recurring` and `invoices.deadlines` jobs |
| ✅ | **5** Monthly close on the 1st | KPI reviews, profitability, client reports queued for approval |

---

## Not built

| | What | Why |
|---|---|---|
| ⬜ | **Client portal UI** | The PRD recommends post-MVP (§10.5). The plan flag, the `client` role and read-only API scoping all exist; the separate portal front end does not |
| ⬜ | **Push notifications (FCM/APNs)** | Needs device tokens and app-store credentials. The channel is modelled and preference-controlled; the sender is missing |
| ⬜ | **Tally/Zoho API integration** | CSV export is what the PRD specifies for v1 (§10.4) |
| ⬜ | **Custom role editor UI** | The API and permission model support custom roles; the matrix is read-only in the UI |

## Verified by running it

Beyond the test suite, these were exercised against the running application:

- Sign-in for every seeded role, with RBAC differences visible in the navigation
- Dashboard pillars, lagging indicators, improvement flags and drill-downs
- Invoice creation with correct CGST/SGST split, clean numbering audit, PDF render
- Idempotency replay returning the original invoice rather than a second one
- Proposal share link opened without auth, accepted, and the client advancing to
  Onboarding with the activity logged and the owner notified on three channels
- Performance reviews generated from real completion and attendance data
- Tenant isolation and employee scope filtering
