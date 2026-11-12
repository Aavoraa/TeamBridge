import bcrypt from 'bcryptjs';
import { get, run } from '../db/index.js';
import { uuid, nowIso, slugify, addDays, monthIso } from '../lib/util.js';
import { ensureBroadcastChannel } from './chat.js';
import { conflict } from '../lib/http.js';

/**
 * S7/S8 - tenant self-signup and seed content.
 *
 * A brand new tenant gets its service lines, pipeline, action categories,
 * reason codes, leave types, SOP packs, KPI/KRA sets and document templates
 * pre-populated, so the workspace is usable on day one rather than an empty
 * shell. Every pack below is per-service-line and editable afterwards - this
 * is the "configurable layer on top of the shared core" from D5.
 */

// --------------------------------------------------------------- content packs
export const SERVICE_LINE_PACK = [
  { code: 'branding', name: 'Branding', color: '#8B5CF6', description: 'Identity, positioning, collateral and brand systems' },
  { code: 'digital', name: 'Digital & Performance Marketing', color: '#3B82F6', description: 'Paid media, SEO, content and lifecycle marketing' },
  { code: 'sales', name: 'Sales Consulting', color: '#F59E0B', description: 'Sales process design, enablement and revenue operations' },
  { code: 'tech', name: 'Tech & Automation', color: '#10B981', description: 'Web, product, integrations and workflow automation' },
];

export const PIPELINE_PACK = [
  { code: 'outreach', name: 'Outreach', probability: 5, sla_days: 7 },
  { code: 'pitch', name: 'Pitch', probability: 15, sla_days: 7 },
  { code: 'follow_up', name: 'Follow-up', probability: 30, sla_days: 10 },
  { code: 'proposal', name: 'Proposal', probability: 55, sla_days: 14 },
  { code: 'onboarding', name: 'Onboarding', probability: 85, sla_days: 14, is_won: 1 },
  { code: 'execution', name: 'Execution', probability: 95, sla_days: 90, is_won: 1 },
  { code: 'invoicing', name: 'Invoicing', probability: 100, sla_days: 30, is_won: 1 },
  { code: 'retention', name: 'Retention', probability: 100, sla_days: 90, is_won: 1 },
];

export const ACTION_CATEGORY_PACK = [
  { code: 'outreach_pitch', name: 'Outreach Pitch', escalation_days: 2, color: '#8B5CF6' },
  { code: 'follow_up', name: 'Follow-up', escalation_days: 2, color: '#3B82F6' },
  { code: 'grievance', name: 'Grievance', escalation_days: 1, color: '#EF4444' },
  { code: 'internal', name: 'Internal', escalation_days: 5, color: '#64748B' },
  { code: 'delivery', name: 'Delivery', escalation_days: 3, color: '#10B981' },
];

export const REASON_CODE_PACK = [
  // E7 - retention-risk flags must come from this managed list, never free text.
  { category: 'retention_risk', code: 'PAYMENT_DELAY', label: 'Repeated payment delays', severity: 3 },
  { category: 'retention_risk', code: 'LOW_ENGAGEMENT', label: 'Low engagement / unresponsive', severity: 2 },
  { category: 'retention_risk', code: 'SCOPE_DISPUTE', label: 'Scope or deliverable dispute', severity: 3 },
  { category: 'retention_risk', code: 'BUDGET_CUT', label: 'Client budget reduction', severity: 2 },
  { category: 'retention_risk', code: 'RESULTS_BELOW', label: 'Results below expectation', severity: 3 },
  { category: 'retention_risk', code: 'STAKEHOLDER_CHANGE', label: 'Key stakeholder changed', severity: 2 },
  { category: 'retention_risk', code: 'COMPETITOR', label: 'Competitor approach', severity: 3 },
  { category: 'churn', code: 'IN_HOUSE', label: 'Moved capability in-house', severity: 2 },
  { category: 'churn', code: 'COST', label: 'Cost / pricing', severity: 2 },
  { category: 'churn', code: 'SERVICE', label: 'Service quality', severity: 3 },
  { category: 'churn', code: 'PROJECT_END', label: 'Project completed as planned', severity: 1 },
  { category: 'churn', code: 'CLIENT_CLOSED', label: 'Client wound down operations', severity: 1 },
  { category: 'score_adjust', code: 'STRATEGIC', label: 'Strategic / logo value', severity: 1 },
  { category: 'score_adjust', code: 'REFERRAL_SOURCE', label: 'Strong referral source', severity: 1 },
  { category: 'score_adjust', code: 'KNOWN_SEASONAL', label: 'Known seasonal slowdown', severity: 1 },
  { category: 'grievance', code: 'DELAY', label: 'Delivery delay', severity: 2 },
  { category: 'grievance', code: 'QUALITY', label: 'Quality complaint', severity: 3 },
  { category: 'grievance', code: 'COMMUNICATION', label: 'Communication gap', severity: 2 },
];

/** Module I - what an employee can claim back, and whether a bill is required. */
export const EXPENSE_CATEGORY_PACK = [
  { code: 'travel', name: 'Travel', color: '#3B82F6', description: 'Flights, trains, cabs and fuel for company travel' },
  { code: 'local_conveyance', name: 'Local conveyance', color: '#0EA5E9', description: 'Autos, cabs and mileage within the city', requires_receipt: 0 },
  { code: 'accommodation', name: 'Accommodation', color: '#8B5CF6', description: 'Hotel stays while travelling for work' },
  { code: 'meals', name: 'Meals & entertainment', color: '#F59E0B', description: 'Client meals and team meals on company business' },
  { code: 'client_hosting', name: 'Client hosting', color: '#EC4899', description: 'Hosting a client: venue, gifts, hospitality' },
  { code: 'software', name: 'Software & subscriptions', color: '#10B981', description: 'Tools bought personally and used for work' },
  { code: 'equipment', name: 'Equipment & hardware', color: '#0F766E', description: 'Peripherals, accessories and small hardware' },
  { code: 'office_supplies', name: 'Office supplies', color: '#64748B', description: 'Stationery, printing and consumables' },
  { code: 'training', name: 'Training & certification', color: '#7C3AED', description: 'Courses, exams and conference passes' },
  { code: 'communication', name: 'Phone & internet', color: '#2563EB', description: 'Work share of mobile and broadband bills' },
  { code: 'marketing', name: 'Marketing spend', color: '#DB2777', description: 'Ad spend or campaign costs paid personally' },
  { code: 'other', name: 'Other', color: '#94A3B8', description: 'Anything the categories above do not cover' },
];

export const LEAVE_TYPE_PACK = [
  { code: 'CL', name: 'Casual Leave', annual_quota: 1, color: '#3B82F6' },
  { code: 'SL', name: 'Sick Leave', annual_quota: 8, color: '#EF4444' },
  { code: 'EL', name: 'Earned Leave', annual_quota: 15, color: '#10B981' },
  { code: 'LOP', name: 'Loss of Pay', annual_quota: 0, paid: 0, color: '#64748B' },
  { code: 'PERM', name: 'Hourly Permission', annual_quota: 2, color: '#F59E0B' },
];

/** D1/D5 - SOP packs per service line and per workflow. */
export const SOP_PACK = [
  {
    code: 'SOP-OUT-01', title: 'Outreach Pitch', workflow: 'outreach_pitch', serviceLine: null,
    summary: 'How a cold or warm lead is approached, qualified and logged.',
    content: `## Purpose\nEnsure every outreach is qualified, logged and carries a next action.\n\n## When to use\nAny first contact with a prospective client.\n\n## Steps\n1. Confirm the lead is not already in the CRM (duplicate check).\n2. Research the company: industry, size, current marketing/tech footprint.\n3. Log the lead with industry tag, source and owner.\n4. Send the opening message on the client's preferred channel.\n5. Record the touchpoint as an activity with its outcome.\n6. Set the next action and date before closing the record.\n\n## Escalation\nNo response after 3 touchpoints over 10 days -> move to nurture and inform the manager.`,
    checklist: [
      'Duplicate check completed in CRM',
      'Company researched and industry tag applied',
      'Lead record created with owner assigned',
      'Opening message sent and logged as an activity',
      'Next action + date set',
    ],
  },
  {
    code: 'SOP-FUP-01', title: 'Follow-up Discipline', workflow: 'follow_up', serviceLine: null,
    summary: 'The follow-up ladder that guarantees no lead goes cold silently.',
    content: `## Purpose\nZero missed follow-ups. Every lead always carries a next action and date.\n\n## Cadence\n- Day 0: first touch\n- Day 2: follow-up 1 (different channel)\n- Day 5: follow-up 2 with a value add\n- Day 10: follow-up 3, decision request\n- Day 15: nurture or close-lost with a reason code\n\n## Rules\n1. Log every touchpoint with its outcome.\n2. Update the next action immediately after each touch.\n3. Three no-responses escalate to the reporting manager.\n4. Close-lost always requires a structured reason code.`,
    checklist: [
      'Touchpoint logged with outcome',
      'Next action + date updated',
      'Channel varied from the previous attempt',
      'Escalated to manager if third no-response',
    ],
  },
  {
    code: 'SOP-GRV-01', title: 'Grievance Handling', workflow: 'grievance', serviceLine: null,
    summary: 'Acknowledge fast, resolve visibly, close with a documented root cause.',
    content: `## Purpose\nContain client dissatisfaction before it becomes churn.\n\n## SLA\n- Acknowledge within 4 working hours\n- Resolution plan within 24 hours\n- Closure within 5 working days\n\n## Steps\n1. Log the grievance as an activity with a reason code.\n2. Acknowledge to the client in writing.\n3. Raise an action item with the Grievance category (1-day escalation).\n4. Agree a resolution plan with the client and record it.\n5. Deliver, confirm satisfaction, close.\n6. Record the root cause and any SOP change needed.`,
    checklist: [
      'Grievance logged with reason code',
      'Client acknowledged in writing within 4 hours',
      'Action item raised under Grievance category',
      'Resolution plan agreed and recorded',
      'Client confirmed closure',
      'Root cause documented',
    ],
  },
  {
    code: 'SOP-ONB-01', title: 'Client Onboarding', workflow: 'onboarding', serviceLine: null,
    summary: 'From signed proposal to a running engagement in 7 days.',
    content: `## Purpose\nA consistent first week that sets delivery expectations.\n\n## Steps\n1. Convert the accepted proposal into a project with scope items.\n2. Collect KYC: GSTIN, billing contact, PO process.\n3. Schedule the kickoff call and publish the agenda.\n4. Share the communication plan and escalation matrix.\n5. Set up shared drives, access and reporting cadence.\n6. Create the recurring invoice if the engagement is a retainer.\n7. Set the first month's deliverable action items.`,
    checklist: [
      'Project created with scope items',
      'KYC and billing details collected',
      'Kickoff call held and MOM circulated',
      'Communication plan + escalation matrix shared',
      'Access and tooling set up',
      'Retainer / invoice schedule configured',
      'First month deliverables created',
    ],
  },
  {
    code: 'SOP-INV-01', title: 'Invoicing & Collection', workflow: 'invoicing', serviceLine: null,
    summary: 'Every invoice is generated in-system, approved, sent and chased.',
    content: `## Purpose\n100% of invoices generated in-system with zero numbering errors.\n\n## Rules\n1. Never number an invoice by hand - the system allocates it.\n2. Verify GSTIN, place of supply and SAC codes before approval.\n3. Finance approves before the invoice leaves draft.\n4. Reminder ladder: T-3, T-1, due date, then overdue escalation.\n5. Record every payment against the invoice, never as a note.\n6. Write-offs need owner approval and a reason.`,
    checklist: [
      'Invoice generated from the system (not manual)',
      'GSTIN and place of supply verified',
      'SAC codes present on every line',
      'Finance approval recorded',
      'Invoice dispatched to the billing contact',
      'Payment recorded against the invoice',
    ],
  },
  {
    code: 'SOP-RET-01', title: 'Retention Review', workflow: 'retention', serviceLine: null,
    summary: 'Monthly health check that catches churn before it happens.',
    content: `## Purpose\nCatch a slipping account while it can still be saved.\n\n## Cadence\nMonthly for retainers, at each milestone for projects.\n\n## Steps\n1. Review the client scorecard: conversion, risk, relevancy, retention.\n2. Compare delivered scope against committed scope.\n3. Review payment behaviour and outstanding balance.\n4. Hold the review call and capture satisfaction (1-5).\n5. If retention risk is flagged, select a structured reason code and set a recovery action.\n6. Confirm the renewal date and the next review.`,
    checklist: [
      'Client scorecard reviewed',
      'Delivered vs committed scope compared',
      'Payment behaviour reviewed',
      'Review call held and satisfaction captured',
      'Retention risk reason code set if flagged',
      'Renewal date confirmed',
    ],
  },
  {
    code: 'SOP-EXE-BR', title: 'Branding Execution', workflow: 'execution', serviceLine: 'branding',
    summary: 'Discovery to delivered brand system.',
    content: `## Stages\n1. Discovery workshop and brand audit\n2. Positioning and messaging framework\n3. Identity concepts (3 routes) and internal review\n4. Client presentation and one revision round\n5. Brand system build: logo suite, type, colour, usage rules\n6. Collateral rollout and handover kit\n\n## Quality gates\n- Every route must trace back to the positioning statement.\n- Internal review before any client-facing presentation.\n- Final handover includes source files and a usage guide.`,
    checklist: [
      'Discovery workshop completed',
      'Positioning framework signed off',
      'Three identity routes presented',
      'Internal review passed before client presentation',
      'Brand system documented',
      'Handover kit delivered',
    ],
  },
  {
    code: 'SOP-EXE-DG', title: 'Digital & Performance Execution', workflow: 'execution', serviceLine: 'digital',
    summary: 'Monthly performance marketing operating rhythm.',
    content: `## Monthly rhythm\n- Week 1: plan, creative brief, budget allocation\n- Week 2: launch and QA all tracking\n- Week 3: mid-month optimisation review\n- Week 4: reporting, learnings, next-month plan\n\n## Non-negotiables\n1. Conversion tracking verified before any spend goes live.\n2. Naming conventions applied to every campaign.\n3. Budget pacing checked twice weekly.\n4. Creative refresh at minimum every 30 days.`,
    checklist: [
      'Monthly plan and creative brief approved',
      'Tracking and conversions verified before launch',
      'Naming conventions applied',
      'Mid-month optimisation review held',
      'Budget pacing within 10% of plan',
      'Monthly report delivered with next-month plan',
    ],
  },
  {
    code: 'SOP-EXE-SC', title: 'Sales Consulting Execution', workflow: 'execution', serviceLine: 'sales',
    summary: 'Diagnose, design, enable, measure.',
    content: `## Stages\n1. Diagnostic: pipeline audit, call reviews, CRM hygiene\n2. Design: stage definitions, qualification criteria, cadences\n3. Enable: playbooks, scripts, objection handling, training\n4. Measure: leading and lagging indicators, weekly reviews\n\n## Deliverables\n- Sales process map\n- Qualification framework\n- Playbook and cadence library\n- Dashboard definition`,
    checklist: [
      'Pipeline audit completed',
      'Stage definitions and qualification criteria agreed',
      'Playbook and cadences delivered',
      'Team training session held',
      'Dashboard and review rhythm established',
    ],
  },
  {
    code: 'SOP-EXE-TA', title: 'Tech & Automation Execution', workflow: 'execution', serviceLine: 'tech',
    summary: 'Requirements to deployed, documented automation.',
    content: `## Stages\n1. Requirements and process mapping (as-is / to-be)\n2. Solution design and tool selection\n3. Build in a staging environment\n4. UAT with the client's own data\n5. Deploy, monitor, hand over documentation\n\n## Quality gates\n- No deployment without UAT sign-off.\n- Every automation has an owner and a failure alert.\n- Documentation is delivered with the build, not after it.`,
    checklist: [
      'As-is / to-be process mapped',
      'Solution design approved',
      'Built and tested in staging',
      'UAT sign-off received',
      'Deployed with monitoring and failure alerts',
      'Documentation handed over',
    ],
  },
];

/** D3 - KPI / KRA definitions per role and per service line. */
export const KPI_PACK = [
  { code: 'COMPLETION', name: 'Action item completion rate', kind: 'kpi', applies_role: 'employee', unit: 'percent', source: 'action_items.completion', target_value: 95, cadence: 'monthly', weight: 2 },
  { code: 'ONTIME', name: 'On-time delivery rate', kind: 'kpi', applies_role: 'employee', unit: 'percent', source: 'action_items.on_time', target_value: 90, cadence: 'monthly', weight: 2 },
  { code: 'ATTENDANCE', name: 'Attendance', kind: 'kpi', applies_role: 'employee', unit: 'percent', source: 'attendance.pct', target_value: 95, cadence: 'monthly', weight: 1 },
  { code: 'SOPADH', name: 'SOP adherence', kind: 'kpi', applies_role: 'employee', unit: 'percent', source: 'sop.adherence', target_value: 90, cadence: 'monthly', weight: 1.5 },
  { code: 'FUPRATE', name: 'Follow-up completion rate', kind: 'kra', applies_role: 'employee', unit: 'percent', source: 'crm.follow_up_completion', target_value: 95, cadence: 'weekly', weight: 2 },
  { code: 'TEAMCOMP', name: 'Team completion rate', kind: 'kra', applies_role: 'manager', unit: 'percent', source: 'action_items.completion', target_value: 92, cadence: 'monthly', weight: 2 },
  { code: 'ESCSLA', name: 'Escalations resolved within SLA', kind: 'kra', applies_role: 'manager', unit: 'percent', source: 'escalations.sla', target_value: 90, cadence: 'monthly', weight: 2 },
  { code: 'RETENTION', name: 'Client retention', kind: 'kra', applies_role: 'manager', unit: 'percent', source: 'crm.retention', target_value: 97, cadence: 'monthly', weight: 3 },
  { code: 'DSO', name: 'Days sales outstanding', kind: 'kpi', applies_role: 'finance', unit: 'number', source: 'finance.dso', target_value: 30, direction: 'lower', cadence: 'monthly', weight: 2 },
  { code: 'INVERR', name: 'Invoice error rate', kind: 'kpi', applies_role: 'finance', unit: 'percent', source: 'finance.invoice_errors', target_value: 0, direction: 'lower', cadence: 'monthly', weight: 3 },
  { code: 'MARGIN', name: 'Gross margin', kind: 'kra', applies_role: 'finance', unit: 'percent', source: 'finance.margin', target_value: 45, cadence: 'monthly', weight: 3 },
  { code: 'TTH', name: 'Time to hire (days)', kind: 'kpi', applies_role: 'hr', unit: 'number', source: 'hiring.time_to_hire', target_value: 30, direction: 'lower', cadence: 'monthly', weight: 2 },
  { code: 'ATTRITION', name: 'Attrition rate', kind: 'kra', applies_role: 'hr', unit: 'percent', source: 'hr.attrition', target_value: 10, direction: 'lower', cadence: 'monthly', weight: 2 },
];

export const PROPOSAL_TEMPLATE_PACK = [
  {
    name: 'Branding engagement', serviceLine: 'branding',
    sections: [
      { heading: 'Understanding your brief', body: 'A summary of where the brand stands today, the business outcome you are chasing, and the gap between the two.' },
      { heading: 'Our approach', body: 'Discovery and brand audit, positioning and messaging, identity design across three routes, then a documented brand system with rollout collateral.' },
      { heading: 'Deliverables', body: 'Brand strategy document, positioning framework, logo suite, typography and colour system, brand usage guidelines, and launch collateral.' },
      { heading: 'Timeline', body: 'Six to eight weeks from kickoff, with review gates at the end of discovery, concept presentation, and system build.' },
      { heading: 'Why Phoenixx', body: 'A single team across branding, marketing, sales and technology, so the brand you launch is one your funnel can actually carry.' },
    ],
    items: [
      { description: 'Brand discovery & audit', detail: 'Workshops, stakeholder interviews, competitive audit', qty: 1, rate_minor: 6_000_000 },
      { description: 'Positioning & messaging framework', detail: 'Positioning statement, value pillars, tone of voice', qty: 1, rate_minor: 5_000_000 },
      { description: 'Identity design', detail: 'Three routes, one revision round, final artwork', qty: 1, rate_minor: 9_000_000 },
      { description: 'Brand system & guidelines', detail: 'Usage rules, templates, source files', qty: 1, rate_minor: 5_000_000 },
    ],
    terms: 'Fifty percent advance, balance on delivery. Prices exclude GST. Quotation valid for 30 days. Two revision rounds included per deliverable; additional rounds billed at standard rates.',
  },
  {
    name: 'Digital & performance retainer', serviceLine: 'digital',
    sections: [
      { heading: 'The opportunity', body: 'What your current acquisition looks like, where spend is leaking, and the realistic ceiling once tracking, creative and targeting are corrected.' },
      { heading: 'Scope of work', body: 'Full-funnel paid media management, conversion tracking, landing page conversion support, creative production, and monthly reporting.' },
      { heading: 'Operating rhythm', body: 'Weekly optimisation, mid-month review, monthly report with next-month plan and budget recommendation.' },
      { heading: 'Reporting', body: 'A live dashboard plus a monthly report covering spend, CAC, ROAS, pipeline contribution and the learnings driving next month.' },
    ],
    items: [
      { description: 'Performance marketing retainer', detail: 'Monthly management across paid channels', qty: 1, unit: 'month', rate_minor: 7_500_000 },
      { description: 'Creative production', detail: 'Static and motion creative, monthly refresh', qty: 1, unit: 'month', rate_minor: 3_000_000 },
      { description: 'Analytics & tracking setup', detail: 'One-time: conversion tracking, dashboards', qty: 1, rate_minor: 4_000_000 },
    ],
    terms: 'Retainer billed monthly in advance. Media spend is billed separately and paid directly by the client. Minimum engagement three months. Prices exclude GST.',
  },
  {
    name: 'Sales consulting engagement', serviceLine: 'sales',
    sections: [
      { heading: 'Where revenue is leaking', body: 'A summary of the diagnostic findings across pipeline hygiene, qualification discipline and follow-up consistency.' },
      { heading: 'Engagement design', body: 'Diagnostic, process design, enablement and measurement across a twelve week programme.' },
      { heading: 'What you get', body: 'A documented sales process, qualification framework, playbook and cadence library, and a review rhythm your managers can run without us.' },
    ],
    items: [
      { description: 'Sales diagnostic', detail: 'Pipeline audit, call reviews, CRM hygiene assessment', qty: 1, rate_minor: 5_000_000 },
      { description: 'Process & playbook design', detail: 'Stage definitions, qualification, cadences, scripts', qty: 1, rate_minor: 8_000_000 },
      { description: 'Enablement & training', detail: 'Two workshops plus manager coaching', qty: 1, rate_minor: 4_500_000 },
    ],
    terms: 'Billed in three milestones against diagnostic, design and enablement. Prices exclude GST.',
  },
  {
    name: 'Tech & automation build', serviceLine: 'tech',
    sections: [
      { heading: 'Problem statement', body: 'The manual process being replaced, the time it currently consumes, and the failure modes it creates.' },
      { heading: 'Proposed solution', body: 'Process mapping, solution design, staged build, UAT against your own data, and a monitored deployment.' },
      { heading: 'Support', body: 'Thirty days of post-deployment support, then an optional maintenance retainer.' },
    ],
    items: [
      { description: 'Discovery & process mapping', detail: 'As-is / to-be mapping and solution design', qty: 1, rate_minor: 4_000_000 },
      { description: 'Build & integration', detail: 'Development, integrations, staging environment', qty: 1, rate_minor: 12_000_000 },
      { description: 'UAT, deployment & documentation', detail: 'Testing, go-live, monitoring, handover docs', qty: 1, rate_minor: 4_000_000 },
    ],
    terms: 'Forty percent advance, forty percent on UAT sign-off, twenty percent on deployment. Prices exclude GST. Third-party licences billed at cost.',
  },
];

// ------------------------------------------------------------------ seeding
export async function seedTenantContent(tenantId, { ownerId = null } = {}) {
  const ts = nowIso();
  const slIds = {};

  for (const [i, sl] of SERVICE_LINE_PACK.entries()) {
    const id = uuid();
    slIds[sl.code] = id;
    await run(
      `INSERT INTO service_lines (id, tenant_id, name, code, color, description, sort, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, sl.name, sl.code, sl.color, sl.description, i, ts, ts],
    );
  }

  for (const [i, st] of PIPELINE_PACK.entries()) {
    await run(
      `INSERT INTO pipeline_stages (id, tenant_id, name, code, sort, probability, is_won, is_lost, sla_days, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,0,?,?,?)`,
      [uuid(), tenantId, st.name, st.code, i, st.probability, st.is_won || 0, st.sla_days, ts, ts],
    );
  }

  for (const c of ACTION_CATEGORY_PACK) {
    await run(
      `INSERT INTO action_categories (id, tenant_id, name, code, escalation_days, color, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [uuid(), tenantId, c.name, c.code, c.escalation_days, c.color, ts],
    );
  }

  for (const r of REASON_CODE_PACK) {
    await run(
      `INSERT INTO reason_codes (id, tenant_id, category, code, label, severity, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [uuid(), tenantId, r.category, r.code, r.label, r.severity, ts],
    );
  }

  for (const lt of LEAVE_TYPE_PACK) {
    await run(
      `INSERT INTO leave_types (id, tenant_id, name, code, annual_quota, paid, color, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [uuid(), tenantId, lt.name, lt.code, lt.annual_quota, lt.paid ?? 1, lt.color, ts],
    );
  }

  for (const [i, ec] of EXPENSE_CATEGORY_PACK.entries()) {
    await run(
      `INSERT INTO expense_categories (id, tenant_id, name, code, description, requires_receipt,
         color, sort, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [uuid(), tenantId, ec.name, ec.code, ec.description, ec.requires_receipt ?? 1, ec.color, i, ts],
    );
  }

  for (const sop of SOP_PACK) {
    const sopId = uuid();
    await run(
      `INSERT INTO sops (id, tenant_id, title, code, service_line_id, workflow, summary, owner_id,
         status, current_version, requires_ack, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'published', 1, 1, ?, ?)`,
      [sopId, tenantId, sop.title, sop.code, sop.serviceLine ? slIds[sop.serviceLine] : null,
        sop.workflow, sop.summary, ownerId, ts, ts],
    );
    await run(
      `INSERT INTO sop_versions (id, tenant_id, sop_id, version, content, checklist, change_note,
         status, published_at, created_by, created_at)
       VALUES (?,?,?,1,?,?, 'Initial version from the Phoenixx OS starter pack', 'published', ?, ?, ?)`,
      [uuid(), tenantId, sopId, sop.content,
        JSON.stringify(sop.checklist.map((text, i) => ({ id: `c${i + 1}`, text, required: true }))),
        ts, ownerId, ts],
    );
  }

  for (const k of KPI_PACK) {
    await run(
      `INSERT INTO kpis (id, tenant_id, name, code, kind, applies_role, service_line_id, unit, source,
         target_value, direction, cadence, weight, version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      [uuid(), tenantId, k.name, k.code, k.kind, k.applies_role, null, k.unit, k.source,
        k.target_value, k.direction || 'higher', k.cadence, k.weight, ts, ts],
    );
  }

  for (const t of PROPOSAL_TEMPLATE_PACK) {
    await run(
      `INSERT INTO proposal_templates (id, tenant_id, name, service_line_id, sections, default_items, terms, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [uuid(), tenantId, t.name, slIds[t.serviceLine] || null, JSON.stringify(t.sections),
        JSON.stringify(t.items), t.terms, ts, ts],
    );
  }

  return slIds;
}

/** S7 - the self-signup wizard's first step: tenant + owner + trial. */
export async function provisionTenant({
  agencyName, ownerName, ownerEmail, password, phone = null, city = 'Coimbatore',
  planCode = 'growth', trialDays = 14, seed = true, slug: slugOverride = null,
}) {
  const slug = slugOverride || slugify(agencyName);
  if (await get('SELECT id FROM tenants WHERE slug = ?', [slug])) {
    throw conflict(`The workspace address "${slug}" is already taken`);
  }
  if (await get('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL', [ownerEmail])) {
    throw conflict('An account with that email already exists');
  }

  const ts = nowIso();
  const tenantId = uuid();
  await run(
    `INSERT INTO tenants (id, name, slug, legal_name, city, phone, email, invoice_prefix,
       created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [tenantId, agencyName, slug, agencyName, city, phone, ownerEmail,
      slug.slice(0, 4).toUpperCase(), ts, ts],
  );

  const ownerId = uuid();
  await run(
    `INSERT INTO users (id, tenant_id, email, password_hash, name, phone, whatsapp, role, designation,
       status, date_of_joining, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?, 'owner', 'Founder', 'active', ?, ?, ?)`,
    [ownerId, tenantId, ownerEmail, bcrypt.hashSync(password, 10), ownerName, phone, phone,
      ts.slice(0, 10), ts, ts],
  );

  const plan = await get('SELECT * FROM plans WHERE code = ?', [planCode]) || await get('SELECT * FROM plans ORDER BY sort LIMIT 1');
  const trialEnds = addDays(new Date(), trialDays).toISOString();
  await run(
    `INSERT INTO subscriptions (id, tenant_id, plan_id, status, billing_cycle, seats, trial_ends_at,
       current_period_start, current_period_end, created_at, updated_at)
     VALUES (?,?,?, 'trial', 'monthly', 1, ?, ?, ?, ?, ?)`,
    [uuid(), tenantId, plan.id, trialEnds, ts, trialEnds, ts, ts],
  );

  // Every workspace starts with the company-wide announcements room (Module B).
  await ensureBroadcastChannel(tenantId, ownerId);

  if (seed) await seedTenantContent(tenantId, { ownerId });

  return { tenantId, ownerId, slug };
}
