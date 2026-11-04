# Marketing Projects & Lead Management

How the marketing lead system works in Phoenixx OS. It implements
*Phoenixx OS — Marketing Lead Progressive Tracking System* (phases 1–5),
fitted to the parts of the product that already exist.

> **Status:** built. Phase 6 (AI summary) is not - it needs an AI provider
> decision first (section 13).

**Where to find it:** sidebar → **Clients → Marketing leads**, or the
**Lead pipeline** button on any marketing project under Projects & teams.

---

## 1. The rules

1. **A lead is entered once.** ⭐ Progressive, My leads, New, Follow-up today,
   Won and Owner attention are all filters over the same rows - never copies.
   Adding or importing a lead that matches an existing one (same email, or the
   same company and phone) is refused with the existing lead named.
2. **Everything is recorded.** Every change - created, status moved,
   reassigned, called, emailed, met, starred, unstarred, owner action raised or
   closed, marked dead, revived, converted - is written to the lead's
   timeline (`lead_activities`, append-only). Reports are built from it.
3. **Status moves by dropdown**, in the list and in the lead drawer.
4. **⭐ is an attention flag, not a status.** Only the **project manager and
   team lead** (and the workspace Owner) can add or remove it.
5. **Dead, not deleted.** A lead given up on is marked dead with a reason and
   recorded in the **dead lead register** (`dead_leads`). Its history stays,
   and it can be revived.
6. **Health is computed, never stored**, so it is never out of date.

---

## 2. Marketing projects

A project becomes a marketing project by setting **Project type → Marketing**
(on creation, or later in the project's details). It keeps everything a
project has - team, owners, daily project updates - and gains a lead pipeline.

| Who | Can |
|---|---|
| Workspace Owner, finance, any project owner, anyone on the team | see the project's leads (same visibility rule as projects: employees and managers see only projects they are on or own) |
| Anyone on the project team, its owners, a lead's assignee | add and import leads, edit them, move status, log activities, file daily updates, raise owner actions, generate reports |
| Project **manager** and **team lead** (and the workspace Owner) | ⭐ on/off and priority, mark dead, revive, delete |
| Workspace Owner | change Settings → Marketing |

### Screens (tabs on the project)

| Tab | Shows |
|---|---|
| **Overview** | campaign progress, totals, leads by status, ⭐ health counts, today's activity, team table |
| **Leads** | the pipeline with sub-views *All · My leads · New · Follow-up today · ⭐ Progressive · Won*, search and filters (status, assignee, temperature, health), **Add lead**, **Import CSV** |
| **⭐ Progressive** | open ⭐ leads only, priority first |
| **Owner attention** | every open owner action, critical first, then by due date |
| **Activity** | every event on every lead, newest first |
| **Dead leads** | the dead lead register: reason, status at death, who and when, revived or not, and a "why leads die" summary |
| **Reports** | daily and weekly marketing reports, plus *Generate now* |
| **Settings** | thresholds and report times (workspace Owner only) |

Clicking any lead opens its **drawer**: status dropdown, assignee, value, last
activity, next action and follow-up, health and why, ⭐ reasons, the open
owner action, the full timeline, daily updates, editable details and ⭐
history, with buttons **Add update · Log activity · Mark ⭐ / Remove ⭐ ·
Owner action · Mark dead · Revive**.

---

## 3. The lead

| Field | Notes |
|---|---|
| Company name * | |
| Contact person, designation, phone, email, website, location, industry | |
| Lead source | email, linkedin, website, referral, campaign, cold call, event, other |
| Assigned to | |
| Status | New → Contacted → Interested → Qualified → Proposal → Negotiation → Won (plus **Dead**, set only through *Mark dead*) |
| Temperature | cold, warm, hot |
| Expected value, expected close date | |
| Next action, next follow-up | required on every daily update and every ⭐ |
| Notes | |

**Import CSV** — header row, then one lead per row. Recognised columns:
Company (required), Contact, Designation, Phone, Email, Website, Location,
Industry, Source, Assignee (email), Notes. Duplicates are skipped and listed,
rows with no company are reported, the rest are created.

**Won** — moving a lead to Won closes its ⭐ as *converted* and, unless you
untick it, creates the company as an active **CRM client** with its contact,
so proposals and invoices can follow. The lead links to the client.

---

## 4. Statuses move automatically too

The dropdown is always there, but common steps move the status on their own -
**forwards only**, never back:

| Happens | Status becomes |
|---|---|
| A call, email, WhatsApp or meeting is logged on a **New** lead | Contacted |
| Daily update: *Follow-up completed* | Contacted |
| Daily update: *Client interested* | Interested |
| Daily update: *Proposal sent* | Proposal |
| Daily update: *Negotiation* | Negotiation |
| Daily update: *Converted* | Won |

---

## 5. ⭐ Progressive leads

**Marking ⭐** asks for, and requires:

- at least one reason — requested quotation, requested meeting, asked for
  pricing, decision maker engaged, proposal requested, negotiation, strong
  buying signal, other (with text);
- a priority — critical, high, normal;
- a next action and a next follow-up date.

The project's manager, lead and owners are notified.

**Removing ⭐** requires a reason (e.g. *Client postponed project*). The lead
stays in the pipeline.

**History** (`progressive_lead_history`) is never edited: every *added*,
*removed*, *priority changed*, *converted* (won) and *closed - dead* entry is
kept with who, when and why.

---

## 6. The daily lead update

| Question | |
|---|---|
| What happened today? | No response · Follow-up completed · Client interested · Meeting completed · Proposal sent · Negotiation · Converted · Waiting on the client · Other |
| Progress / update | required unless *No response* |
| Next action, next follow-up | required unless *Converted* |
| Owner action required? | yes → what, by when, priority |

One update per person per lead per day; saving again the same day edits it.
Saving updates the lead's last activity, next action and follow-up, moves the
status (section 4), writes the timeline, and raises the owner action if asked.

---

## 7. Lead health

Checked in this order - the first match wins:

| Health | When |
|---|---|
| 🔴 **Stalled** | no activity for **5 working days** (configurable) |
| 🟠 **Needs follow-up** | no next action recorded, no follow-up date, or the follow-up is today or overdue |
| 🟡 **Waiting** | the latest update was *No response* or *Waiting on the client*, and the follow-up is still ahead |
| 🟢 **Moving** | recent activity and a future follow-up |

Working days skip the workspace's weekly off. Any logged activity, update,
status change or ⭐ change counts as activity and resets the clock.

---

## 8. Escalation of ⭐ leads

Once a day, at the **watch time** (default 10:00), every open ⭐ lead is
checked. Working days without activity decide the rung:

| Days inactive (default) | Who is told |
|---|---|
| 1 — or the follow-up is due | the assignee: *follow-up pending* |
| 3 | the assignee: *inactive* |
| 5 | the assignee, project manager and lead: *stalled* |
| 6+ | all of them **and the project owners**, and an escalation is raised to the owner |

At **6:30 PM** anyone with a ⭐ lead and no update on it today gets one
reminder. All of these are in-app, at most once per lead per day.

---

## 9. Owner action

Raised from a daily update or the drawer: *what*, *by when*, *priority*. The
project owners are told at once. It shows on the lead (red box), in the
**Owner attention** tab, and in the daily report. Anyone on the project or an
owner closes it with **Mark done** and an optional note - both moments are on
the timeline.

---

## 10. Dead leads

**Mark dead** (project manager or lead) requires a reason:

```text
No response after repeated follow-ups · Not interested · No budget ·
Went with a competitor · No current requirement · Project postponed indefinitely ·
Wrong or invalid contact · Duplicate lead · Other (with a note)
```

This is marketing's own list. The CRM's reason codes describe why a paying
client left, which is a different question from why a prospect never became one.

Marking dead writes a row to the **dead lead register** - reason, note, the
status it died at, whether it was ⭐, who, when, and a snapshot of the lead -
and takes it out of the live pipeline. Its ⭐ (if any) is closed in the ⭐
history, and its owner action (if any) is cleared.

**Revive** (project manager or lead) needs a note, returns the lead to the
status it died at, and stamps the register entry as revived - nothing is
deleted.

---

## 11. Reports

Both appear in the project's **Reports** tab and in the main **Reports**
module, and are sent (in-app) to the project's owners, manager and lead. Only
people who can see the project can open them.

**Daily marketing update** — default **7:15 PM**:
lead activity today (new leads, follow-ups, responses, interested, ⭐ added,
proposals, meetings, won, dead); every open ⭐ lead with status, priority,
health, last activity, next action and owner; and **management attention** -
stalled ⭐ leads, ⭐ leads with no next action, open owner actions.

**Weekly marketing report** — default **Monday 9:30 AM**, for the seven days
ending yesterday: lead metrics (starting leads, new, contacted, responses,
interested, ⭐, qualified, proposals, negotiations, won, dead); ⭐ metrics
(created, active, converted, dead, stalled, average hours between follow-ups);
and the team table (leads assigned, follow-ups, responses, ⭐ leads, meetings,
proposals, conversions).

How the counts are made, from the timeline: *follow-ups* = logged calls,
emails, WhatsApps, meetings and daily updates; *responses* = daily updates
whose outcome was interested, meeting, proposal, negotiation or converted;
status counts = moves **into** that status in the period. Nothing is estimated.

---

## 12. Settings → Marketing

Workspace Owner only; applies to every marketing project. Times are the
workspace's own clock.

| Setting | Default |
|---|---|
| Remind the assignee after | 1 working day |
| Warn the assignee after | 3 working days |
| Stalled after | **5 working days** |
| Escalate to project owners after | 6 working days |
| Daily ⭐ watch | 10:00 |
| Missing-update reminder | 18:30 |
| Daily marketing report | **19:15** |
| Weekly report | **Monday 09:30** |

The ladder must climb (remind < warn < stalled < escalate) or it is refused.

---

## 13. AI summary (not built)

When an AI provider is chosen, a short summary can sit above the daily report.
Its input will be only the records above, and every sentence must trace to a
record - no invented activity, responses, revenue, meetings or probabilities.

---

## 14. Under the hood

| | |
|---|---|
| Tables | `leads`, `lead_activities`, `lead_updates`, `progressive_lead_history`, `dead_leads` (`server/src/db/schema.sql`) |
| New columns | `projects.kind`, `tenants.marketing_settings`, `report_runs.project_id` |
| Rules, health, reports, watch | `server/src/services/marketing.js` |
| API | `server/src/routes/marketing.routes.js`, mounted at `/api/v1/marketing` |
| Job | `marketing.tick`, every 15 minutes, decides per workspace what is due |
| Screens | `web/src/pages/Marketing.tsx` |
| Tests | `server/tests/marketing.test.js` |

### Success criteria — where each answer is

| Question | Where |
|---|---|
| How many leads are active? | Overview → Total leads / open |
| Which leads are progressing? | Leads, health 🟢 |
| Which leads are ⭐? | ⭐ Progressive tab |
| Why are they ⭐? | lead drawer → ⭐ Why; ⭐ History |
| What happened today? | Overview → Today; daily report |
| What is the next action? | Leads → Next; drawer |
| Who is responsible? | Assigned, on every lead |
| Which follow-ups are due? | Leads → Follow-up today; health 🟠 |
| Which ⭐ leads are stalled? | health 🔴; stalled and escalation notices |
| Which need owner intervention? | Owner attention tab |
| How is each marketing project progressing? | Marketing leads home; Overview; weekly report |
| What changed since yesterday? | Activity tab; daily report |
| Why do leads die? | Dead leads tab → "why leads die" |
