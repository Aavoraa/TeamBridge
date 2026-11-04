# Phoenixx OS — Product Requirements Document (PRD)

**Product:** Phoenixx OS — Integrated Agency Operations & Tracking Suite
**Company:** Phoenixx IT, Coimbatore
**Version:** 1.0 | **Date:** 21 Aug 2026
**Platforms:** Web app + Mobile app (Android & iOS) sharing a **common API and database**
**Model:** Multi-tenant SaaS with subscription billing (Phase 1: single tenant = Phoenixx IT internal; architecture multi-tenant from day one)

---

## 1. Product Vision & Goals

Replace spreadsheets, WhatsApp threads, and disconnected tools with **one platform** covering action items/MOM, deadlines & alerts, HR (attendance/permissions/performance), KPI/KRA, SOPs per service line, CRM (outreach → onboarding → execution → invoicing → retention), client scoring, proposals & invoices, hiring, and internal + client-facing reporting — rolled up into an **Overview Traction Dashboard**.

**Goals**
- G1: Single source of truth for all agency operations across 4 service lines (Branding; Digital & Performance Marketing; Sales Consulting; Tech & Automation).
- G2: Zero missed follow-ups, deadlines, or invoices via a central alert/escalation engine (WhatsApp-first).
- G3: Quantified client health — conversion, risk, relevancy, retention scores computed from real engagement/payment data.
- G4: SaaS-ready from day one — multi-tenant data model, subscription billing, India-first (INR, GST) with global support.
- G5: Feature parity of core workflows on web and mobile through one shared API.

**Non-goals (v1)**
- Media buying/proofing workflows (Workamajig-style), payroll processing, accounting ledger (integrate, don't build), custom BI query builder.

---

## 2. Users, Tenancy & Roles

### 2.1 Tenancy
- **Tenant = one agency.** All data is isolated per tenant (row-level `tenant_id` on every table + enforced at API middleware; option to move large tenants to schema-per-tenant later).
- Tenant-level settings: branding (logo, colours), timezone, currency, GST/tax profile, invoice numbering scheme, notification channels, service lines.

### 2.2 Roles (RBAC)
| Role | Access summary |
|---|---|
| Super Admin (platform) | Manage tenants, plans, billing, feature flags, platform health |
| Agency Owner / Admin | Full tenant access, billing, user management, settings |
| Manager | Team-level access: assign, approve, escalations, reports |
| Employee | Own tasks, attendance, KPIs, assigned clients/projects |
| Finance | Invoices, costs, profitability, payment tracking |
| HR | Attendance, leave, performance, hiring pipeline |
| Client (portal user) | Read-only: own reports, proposals, invoices, approvals |

- Permissions are granular (module × action: view/create/edit/approve/delete) with role templates; custom roles allowed on higher plans.
- Audit log for every create/update/delete/approval (actor, timestamp, before/after).

---

## 3. Functional Requirements — 8 Core Modules

### Module A — Action Items, Meetings & MOM
- A1: CRUD action items: title, description, owner, watchers, client/project link, category (Outreach Pitch / Follow-up / Grievance / Internal / Custom), priority, due date, status (Open → In Progress → Blocked → Done → Cancelled).
- A2: Meeting scheduler with agenda; MOM capture during/after meeting; each MOM point convertible to an action item in one tap.
- A3: Recurring action items (daily/weekly/monthly).
- A4: Escalation rules: unresolved item auto-escalates after N days (configurable per category) to reporting manager; escalation logged.
- A5: Comments, @mentions, file attachments on every item.
- A6: Mobile: quick-add action item, voice-note attachment, offline draft that syncs.

### Module B — Deadline Engine, Alerts & Notifications
- B1: Central deadline engine consuming deadlines from all modules (action items, proposals, invoices due, deliverables, follow-ups, leave approvals).
- B2: Multi-channel notifications: **WhatsApp (Business API), Email, MS Teams webhook, in-app, mobile push (FCM/APNs)** — channel preference per user + per event type.
- B3: Reminder ladder: T-3d / T-1d / due / overdue (configurable); overdue triggers escalation report to manager.
- B4: Daily digest (morning summary of due/overdue items) per user; weekly escalation report per manager.
- B5: Notification templates editable per tenant; all sends logged with delivery status.

### Module C — HR: Attendance, Permissions & Performance
- C1: Attendance: check-in/out (web + mobile with optional geo-tag), monthly attendance register, regularization requests with approval.
- C2: Leave/permission requests: types, balances, approval workflow, calendar view of team availability.
- C3: Monthly performance: completion % of assigned items, KPI/KRA achievement per role, manager review + rating, history.
- C4: Hiring pipeline: open roles, qualification standards & experience requirements per role, candidate stages (Sourced → Screened → Interview → Offer → Hired), interview notes.
- C5: Employee master: role, service line, reporting manager, cost (salary band) — feeds cost/profitability module.

### Module D — SOP & KPI/KRA Library
- D1: SOP repository organized per service line (Branding / Digital & Performance Marketing / Sales Consulting / Tech & Automation) and per workflow (Outreach Pitch, Follow-up, Grievance Handling, Onboarding, Execution, Invoicing, Retention Review).
- D2: SOP documents: rich text + checklists + attachments; **version-controlled** (view history, restore); publish/draft states; acknowledgment tracking (who has read which SOP version).
- D3: KPI & KRA definitions per role and per service line: metric name, formula/source, target, review cadence; versioned.
- D4: SOP adherence tracking: checklist completion rates surfaced in weekly reports.
- D5: SOP/KPI templates shippable as per-service-line packs (the configurable layer on top of the shared core).

### Module E — CRM & Client Lifecycle
- E1: Pipeline: **Outreach → Pitch → Follow-up → Proposal → Onboarding → Execution → Invoicing → Retention** (stages configurable per tenant).
- E2: Lead/Client records: company, contacts, industry category tag (construction, hospitality/F&B, textiles, ecommerce, HVAC-tech, financial advisory, …), service lines engaged, source, owner.
- E3: Activity timeline: calls, WhatsApp/email touchpoints, meetings, proposals, invoices — unified per client.
- E4: Follow-up engine: every lead must always have a "next action + date"; leads with no next action are flagged.
- E5: **Proposal generator**: templated per service line, auto-populated from CRM data (client, scope, pricing tables), branded PDF output, share link with view tracking, e-acceptance.
- E6: **Client scoring** (auto-computed + manually adjustable, with reason codes):
  - Conversion possibility ratio (stage velocity, response rate, engagement)
  - Risk ratio (payment delays, grievance count, scope disputes)
  - Relevancy ratio (fit to service lines / ideal client profile)
  - Retention/churn metric (engagement trend, renewal proximity, satisfaction inputs)
- E7: Client work traction: active scope vs. delivered scope per client; retention-risk flag requires a structured **reason code** (from a managed list) — no ad-hoc reasons.
- E8: Duplicate detection, import (CSV) and export.

### Module F — Finance: Invoicing, Cost & Profitability
- F1: **Invoice generator** linked to client/project: auto-numbering per tenant scheme (prefix + financial-year + sequence; editable scheme; the Cotton India numbering issue is the reference defect this fixes), line items, discounts, **GST (CGST/SGST/IGST) with HSN/SAC codes**, multi-currency for export clients, branded PDF.
- F2: Invoice lifecycle: Draft → Sent → Partially Paid → Paid → Overdue → Written Off; payment recording; overdue invoices feed the deadline engine (Module B).
- F3: Recurring invoices for retainers.
- F4: Cost tracking: HR cost (from Module C), tools/software, rent, maintenance, miscellaneous — monthly entries with categories.
- F5: Profitability: revenue − allocated cost at **client level, project level, service-line level, and company level**; gross margin and trend.
- F6: Credit notes; export to Tally/Zoho Books via CSV (v1) — accounting integration API (v2).

### Module G — Reporting
- G1: Internal auto-reports: **Daily** (items due/overdue, attendance), **Weekly** (SOP adherence, follow-up completion, pipeline movement, escalations), **Monthly** (KPI/KRA per employee, client profitability, dashboard review) — generated on schedule, delivered via notification channels.
- G2: **Client-facing monthly report**: branded per tenant visual identity, per-client template with delivered work, metrics, next-month plan; PDF + portal view; dispatch tracked.
- G3: Report builder-lite: pick module, metrics, date range, filters; save as scheduled report.
- G4: All reports exportable (PDF/CSV).

### Module H — Overview Traction Dashboard
- H1: Company dashboard with pillars: **Clients** (active, pipeline, conversion ratio, retention risk), **Revenue** (MRR/project revenue, by service line, by model retainer/project/hybrid), **HR** (headcount, utilization, attendance, open roles), **Cost** (HR + tools, rent, maintenance, misc.), **Profit** (gross margin, net profit, trend).
- H2: **Lagging indicators**: overdue action items, escalations, SLA breaches.
- H3: **Improvement flags**: auto-surfaced weak points (e.g., service line with lowest retention, client with rising risk score, employee with falling completion rate) with drill-down.
- H4: Date-range comparison (MoM, QoQ); every widget drills down to underlying records.
- H5: Mobile dashboard: condensed card view of all pillars.

---

## 4. SaaS & Subscription Requirements

### 4.1 Plans & Billing
- S1: **Flat-rate pricing by agency-size band** (primary model): e.g., Starter (up to 15 users), Growth (16–30), Scale (31–50) — unlimited users within band; annual and monthly billing (annual discounted). Per-user add-on beyond band cap.
- S2: Plan matrix controls **feature flags** (e.g., custom roles, client portal, report builder, API access, white-label reports on higher tiers) and **limits** (clients, storage, WhatsApp message credits).
- S3: 14-day free trial (no card) → self-serve upgrade; launch offer support (e.g., first N tenants get 3 months free) via coupon engine.
- S4: Payment gateway: **Razorpay (India — UPI/cards/netbanking, GST invoice for the subscription itself)** + Stripe (international); auto-renewal, dunning (retry + email/WhatsApp on payment failure), proration on plan change.
- S5: Subscription states: Trial → Active → Past Due → Suspended (read-only) → Cancelled; grace period configurable; data export available for 90 days after cancellation.
- S6: Add-on billing: WhatsApp message packs, extra storage, implementation/configuration service fee (invoiced separately).

### 4.2 Onboarding
- S7: Tenant self-signup wizard: agency profile → service lines (pick from templates or custom) → import clients (CSV) → invite team → connect WhatsApp/email → pick plan.
- S8: Seed content: default SOP packs, KPI/KRA sets, proposal & invoice templates per service line so a tenant is productive on day one.

### 4.3 Platform Admin (Super Admin console)
- S9: Tenant list with plan, usage, health; impersonate-with-consent for support; feature-flag management; announcement banners; platform metrics (MRR, churn, activation).

---

## 5. Architecture Requirements (Web + Mobile, Shared API & DB)

### 5.1 Principles
- **One backend, one database, many clients.** Web app and mobile apps are thin clients over the same versioned REST API (`/api/v1/...`); zero business logic duplicated in clients.
- **API-first**: every feature ships as API + web UI + mobile UI; the API is documented (OpenAPI) and is the same API exposed to paying tenants (higher plans) later.

### 5.2 Recommended Stack (adjust to team skills)
| Layer | Recommendation |
|---|---|
| Backend API | Node.js (NestJS) **or** Python (FastAPI/Django) — REST, OpenAPI spec, JWT auth |
| Database | **PostgreSQL** (single DB, row-level tenant isolation; JSONB for flexible SOP/KPI schemas) |
| Cache/queue | Redis (cache, rate limits) + background workers (BullMQ/Celery) for notifications, report generation, score computation |
| Web frontend | React (Next.js) + TypeScript |
| Mobile | **React Native (Expo)** or Flutter — one codebase for Android + iOS, consuming the same API |
| File storage | S3-compatible object storage (proposals, invoices, attachments) |
| Search | Postgres full-text (v1) |
| Infra | Docker; managed cloud (AWS Mumbai / DigitalOcean BLR); CI/CD (GitHub Actions); staging + production |
| Observability | Structured logs, error tracking (Sentry), uptime + queue monitoring |

### 5.3 API & Data Requirements
- AR1: JWT access + refresh tokens; token carries `tenant_id` + role; every query filtered by tenant at the data layer (defense in depth: middleware + repository layer + DB row-level security).
- AR2: Consistent API envelope, pagination, filtering, sorting; idempotency keys on payment/invoice endpoints; rate limiting per tenant.
- AR3: Webhooks (outbound) for invoice.paid, client.stage_changed, escalation.raised — enables tenant automations.
- AR4: WhatsApp Business API integration abstracted behind a provider interface (Meta Cloud API / Gupshup / WATI) so vendors can be swapped.
- AR5: Mobile sync: delta sync endpoints (`updated_since`), offline queue for action-item creation/attendance check-in, conflict = last-write-wins with audit trail.
- AR6: All timestamps UTC in DB, rendered in tenant timezone; money stored as integer minor units + currency code.
- AR7: Soft deletes everywhere user-facing; hard delete only via retention jobs.

### 5.4 Multi-tenancy & Scale
- AR8: Day-one multi-tenant schema even while only Phoenixx IT uses it (Phase 1 = tenant #1) — avoids the costly re-architecture later.
- AR9: Target scale v1: 200 tenants × 50 users; p95 API latency < 400 ms; report generation async (never blocks a request).

---

## 6. Non-Functional Requirements

| Area | Requirement |
|---|---|
| Security | OWASP Top-10 hardening; bcrypt/argon2 passwords; 2FA (TOTP) for Admin/Finance; encrypted at rest (DB + object storage) and in transit (TLS 1.2+); secrets in a vault; per-tenant data export & delete (DPDP Act 2023 compliance) |
| Privacy | Client data never crosses tenants; PII minimization; consent text for WhatsApp messaging |
| Availability | 99.5% uptime target v1; daily automated DB backups, 30-day retention, restore drill quarterly |
| Performance | Dashboard loads < 2 s on 4G; mobile cold start < 3 s; lists virtualized beyond 100 rows |
| Usability | Mobile-first responsive web; mobile app optimized for the 6 highest-frequency actions (check-in, quick action item, approve, follow-up log, notifications, dashboard) |
| Localization | INR default, ₹ + Indian number format (lakh/crore toggle in reports); English UI v1; language framework in place for Tamil/Hindi later |
| Compatibility | Web: last 2 versions Chrome/Edge/Safari/Firefox; Mobile: Android 10+, iOS 15+ |
| Maintainability | Monorepo; ≥70% unit-test coverage on scoring, invoicing, billing logic; API contract tests; seed/demo data script |

---

## 7. Key Automated Workflows (SOP Engine)

1. **Follow-up SOP:** Lead created → next-action mandatory → reminder ladder → no response in N days → auto-escalate to manager → grievance path if client complaint logged.
2. **Escalation:** deadline breach → WhatsApp/Email/Teams alert → unresolved after N hours/days → escalation report to manager → logged into monthly internal report.
3. **Client lifecycle:** Outreach → Onboarding → Execution → Invoicing → Retention review; retention-risk flag requires structured reason code.
4. **Invoice:** Project milestone/retainer date → draft auto-generated → Finance approves → sent → payment reminder ladder → overdue escalation.
5. **Monthly close:** 1st of month — auto-generate KPI/KRA reviews, client profitability, client-facing reports queued for approval → dispatch.

---

## 8. Build Roadmap (12 sprints ≈ 1 quarter to internal-operational)

| Sprint | Deliverable |
|---|---|
| 0 | Foundation: multi-tenant schema, auth/RBAC, API scaffold, web + mobile shells, CI/CD |
| 1–2 | Module A (Action Items/MOM) + Module B (Deadline/Alert engine: WhatsApp/Email/Teams/push) |
| 3–4 | Module E core (CRM pipeline, clients, activities) + Proposal generator |
| 5–6 | Module F (Invoice generator w/ GST + numbering scheme, cost & profitability) |
| 7–8 | Module D (SOP/KPI/KRA library) + Module C (attendance, leave, performance, hiring) |
| 9–10 | Client scoring engine (conversion/risk/relevancy/retention) |
| 11–12 | Module H (Overview Traction Dashboard) + Module G (client-facing report generator) |
| Post-MVP | Subscription billing + self-signup + Super Admin console (Phase 2 productization gate) |

**Phase gate:** Phase 2 (selling to other agencies) proceeds only after ≥1 quarter of internal usage produces before/after metrics (proposal turnaround, follow-up completion, invoice-error rate) for the marketing proof point.

---

## 9. Success Metrics

- 100% of invoices generated in-system with zero numbering errors (baseline defect: Cotton India case).
- ≥95% follow-up completion rate; zero leads without a next action.
- Escalations resolved within SLA ≥90%.
- Monthly internal + client reports generated with <30 min of manual effort.
- (Phase 2) Trial → paid conversion ≥15%; monthly logo churn <3%; MRR by plan band tracked from day one.

---

## 10. Open Decisions

1. Backend stack: NestJS vs FastAPI (decide by team hiring plan).
2. Mobile: React Native (shared skills with web) vs Flutter.
3. WhatsApp provider: Meta Cloud API direct vs Gupshup/WATI (cost per message vs speed to ship).
4. Accounting: CSV export only in v1, or Zoho Books/Tally integration up front.
5. Client portal in MVP or post-MVP (recommended: post-MVP, reports-only first).
