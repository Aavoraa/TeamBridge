import { get, all, run } from '../db/index.js';
import { uuid, nowIso, todayIso, daysBetween, clamp, round1, parseJson } from '../lib/util.js';

/**
 * Module E6 - client scoring.
 *
 * Four independent scores on a 0-100 scale, computed from real engagement and
 * payment data rather than opinion, then optionally nudged by manual
 * adjustments that must carry a structured reason code (E6/E7).
 *
 *   conversion  higher = more likely to close   (stage velocity, response rate, engagement)
 *   risk        higher = more dangerous          (payment delay, grievances, scope disputes)
 *   relevancy   higher = better ICP fit          (industry, service-line overlap, deal size)
 *   retention   higher = more likely to stay     (engagement trend, renewal, satisfaction, delivery)
 *
 * health = weighted blend, with risk inverted. Every component is returned in
 * `breakdown` so the UI can explain *why* a number moved.
 */

const WEIGHTS = {
  health: { conversion: 0.2, relevancy: 0.15, retention: 0.4, risk: 0.25 },
};

// --------------------------------------------------------------- conversion
function conversionScore(ctx) {
  const { client, stage, activities, stages } = ctx;

  // 1. Stage progress - how deep in the pipeline (0-100 from stage probability).
  const stageProgress = stage?.probability ?? 0;

  // 2. Stage velocity - penalise sitting in a stage past its SLA.
  const daysInStage = client.stage_entered_at ? daysBetween(client.stage_entered_at, new Date()) : 0;
  const slaDays = stage?.sla_days || 14;
  const velocity = clamp(100 - Math.max(0, daysInStage - slaDays) * (100 / (slaDays * 3)), 0, 100);

  // 3. Response rate - share of outbound touchpoints that got a reply.
  const outbound = activities.filter((a) => a.direction === 'outbound' && a.type !== 'note');
  const responded = outbound.filter((a) => ['connected', 'positive'].includes(a.outcome));
  const responseRate = outbound.length ? (responded.length / outbound.length) * 100 : 40;

  // 4. Engagement recency - decays over a 30-day window.
  const lastAt = client.last_activity_at || client.created_at;
  const daysSince = daysBetween(lastAt, new Date());
  const recency = clamp(100 - daysSince * (100 / 30), 0, 100);

  const score = stageProgress * 0.3 + velocity * 0.2 + responseRate * 0.3 + recency * 0.2;
  return {
    score: round1(clamp(score, 0, 100)),
    breakdown: {
      stage_progress: round1(stageProgress),
      stage_velocity: round1(velocity),
      days_in_stage: daysInStage,
      response_rate: round1(responseRate),
      touchpoints: outbound.length,
      recency: round1(recency),
      days_since_contact: daysSince,
    },
  };
}

// --------------------------------------------------------------------- risk
function riskScore(ctx) {
  const { invoices, activities, client } = ctx;

  // 1. Payment delay - average days late across settled invoices.
  const settled = invoices.filter((i) => i.paid_at);
  const avgDaysLate = settled.length
    ? settled.reduce((a, i) => a + Math.max(0, daysBetween(i.due_date, i.paid_at)), 0) / settled.length
    : 0;
  const delayRisk = clamp(avgDaysLate * (100 / 45), 0, 100);   // 45+ days late = maximum

  // 2. Outstanding overdue exposure relative to what the client has ever billed.
  const today = todayIso();
  const overdue = invoices.filter((i) => i.balance_minor > 0 && i.due_date < today);
  const overdueAmt = overdue.reduce((a, i) => a + i.balance_minor, 0);
  const billed = invoices.reduce((a, i) => a + i.total_minor, 0) || 1;
  const exposureRisk = clamp((overdueAmt / billed) * 150, 0, 100);

  // 3. Grievances logged in the last 90 days.
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const grievances = activities.filter((a) => a.type === 'grievance' && a.occurred_at >= cutoff).length;
  const grievanceRisk = clamp(grievances * 25, 0, 100);

  // 4. Scope disputes - delivered well short of committed scope.
  const scopeGap = client.scope_total > 0
    ? clamp((1 - client.scope_delivered / client.scope_total) * 100, 0, 100)
    : 0;

  const score = delayRisk * 0.35 + exposureRisk * 0.3 + grievanceRisk * 0.2 + scopeGap * 0.15;
  return {
    score: round1(clamp(score, 0, 100)),
    breakdown: {
      avg_days_late: round1(avgDaysLate),
      payment_delay_risk: round1(delayRisk),
      overdue_amount_minor: overdueAmt,
      overdue_invoices: overdue.length,
      exposure_risk: round1(exposureRisk),
      grievances_90d: grievances,
      scope_gap_pct: round1(scopeGap),
    },
  };
}

// ---------------------------------------------------------------- relevancy
function relevancyScore(ctx) {
  const { client, icp, tenantServiceLines } = ctx;

  // 1. Industry fit against the tenant's ideal-client-profile list.
  const industries = (icp.industries || []).map((s) => String(s).toLowerCase());
  const industryFit = !industries.length ? 60
    : industries.includes(String(client.industry || '').toLowerCase()) ? 100 : 35;

  // 2. Service-line overlap - engaging more of the agency's lines is a better fit.
  const engaged = parseJson(client.service_lines, []) || [];
  const overlap = tenantServiceLines.length
    ? clamp((engaged.length / tenantServiceLines.length) * 100 + (engaged.length ? 25 : 0), 0, 100)
    : 50;

  // 3. Deal size versus the tenant's target deal value.
  const target = icp.target_deal_value_minor || 15_000_000; // Rs 1.5L default
  const value = client.mrr_minor ? client.mrr_minor * 12 : client.deal_value_minor;
  const sizeFit = value ? clamp((value / target) * 70, 0, 100) : 40;

  // 4. Engagement model - retainers are worth more than one-off projects.
  const modelFit = { retainer: 100, hybrid: 80, project: 55 }[client.engagement_model] ?? 55;

  const score = industryFit * 0.3 + overlap * 0.25 + sizeFit * 0.25 + modelFit * 0.2;
  return {
    score: round1(clamp(score, 0, 100)),
    breakdown: {
      industry: client.industry,
      industry_fit: industryFit,
      service_lines_engaged: engaged.length,
      service_line_overlap: round1(overlap),
      annualised_value_minor: value,
      size_fit: round1(sizeFit),
      model_fit: modelFit,
    },
  };
}

// ---------------------------------------------------------------- retention
function retentionScore(ctx) {
  const { client, activities, invoices } = ctx;
  if (client.status === 'churned') {
    return { score: 0, breakdown: { churned: true, churned_at: client.churned_at } };
  }

  // 1. Engagement trend - last 30 days of touchpoints vs the 30 before that.
  const now = Date.now();
  const d30 = new Date(now - 30 * 86_400_000).toISOString();
  const d60 = new Date(now - 60 * 86_400_000).toISOString();
  const recent = activities.filter((a) => a.occurred_at >= d30).length;
  const prior = activities.filter((a) => a.occurred_at >= d60 && a.occurred_at < d30).length;
  const trendRatio = prior ? recent / prior : recent ? 1.2 : 0.5;
  const trend = clamp(trendRatio * 55, 0, 100);

  // 2. Renewal proximity - the closer the renewal, the more attention it needs.
  let renewal = 70;
  if (client.renewal_date) {
    const daysToRenewal = daysBetween(new Date(), client.renewal_date);
    renewal = daysToRenewal < 0 ? 25
      : daysToRenewal <= 30 ? 40
        : daysToRenewal <= 60 ? 60 : 85;
  }

  // 3. Satisfaction input (1-5 captured at retention reviews).
  const satisfaction = client.satisfaction != null ? (client.satisfaction / 5) * 100 : 65;

  // 4. Delivery ratio - E7 active scope vs delivered scope.
  const delivery = client.scope_total > 0
    ? clamp((client.scope_delivered / client.scope_total) * 100, 0, 100)
    : 70;

  // 5. Payment reliability keeps a paying client sticky.
  const paidOnTime = invoices.filter((i) => i.paid_at && i.paid_at <= `${i.due_date}T23:59:59Z`).length;
  const reliability = invoices.length ? (paidOnTime / invoices.length) * 100 : 65;

  const score = trend * 0.25 + renewal * 0.2 + satisfaction * 0.2 + delivery * 0.2 + reliability * 0.15;
  return {
    score: round1(clamp(score, 0, 100)),
    breakdown: {
      activities_30d: recent,
      activities_prev_30d: prior,
      engagement_trend: round1(trend),
      renewal_date: client.renewal_date,
      renewal_proximity: renewal,
      satisfaction: client.satisfaction,
      delivery_ratio: round1(delivery),
      payment_reliability: round1(reliability),
    },
  };
}

// ----------------------------------------------------------------- assembly
async function loadContext(tenantId, client) {
  const settings = parseJson((await get('SELECT settings FROM tenants WHERE id = ?', [tenantId]))?.settings, {}) || {};
  return {
    client,
    stage: client.stage_id ? await get('SELECT * FROM pipeline_stages WHERE id = ?', [client.stage_id]) : null,
    stages: await all('SELECT * FROM pipeline_stages WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY sort', [tenantId]),
    activities: await all(
      'SELECT * FROM activities WHERE tenant_id = ? AND client_id = ? ORDER BY occurred_at DESC LIMIT 400',
      [tenantId, client.id],
    ),
    invoices: await all(
      "SELECT * FROM invoices WHERE tenant_id = ? AND client_id = ? AND deleted_at IS NULL AND status != 'draft'",
      [tenantId, client.id],
    ),
    tenantServiceLines: await all('SELECT id FROM service_lines WHERE tenant_id = ? AND deleted_at IS NULL AND active = 1', [tenantId]),
    icp: settings.icp || {},
  };
}

/** Manual adjustments (E6) - each one carries a reason code and may expire. */
async function applyAdjustments(tenantId, clientId, scores) {
  const adjustments = await all(
    `SELECT a.*, r.label AS reason_label, r.code AS reason_code
       FROM score_adjustments a JOIN reason_codes r ON r.id = a.reason_code_id
      WHERE a.tenant_id = ? AND a.client_id = ? AND (a.expires_at IS NULL OR a.expires_at > ?)`,
    [tenantId, clientId, nowIso()],
  );
  const applied = [];
  for (const adj of adjustments) {
    if (scores[adj.score_type] == null) continue;
    scores[adj.score_type] = round1(clamp(scores[adj.score_type] + adj.delta, 0, 100));
    applied.push({ type: adj.score_type, delta: adj.delta, reason: adj.reason_label, code: adj.reason_code });
  }
  return applied;
}

/** Compute (and persist) all four scores for one client. */
export async function scoreClient(tenantId, clientOrId, { persist = true, snapshot = false } = {}) {
  const client = typeof clientOrId === 'string'
    ? await get('SELECT * FROM clients WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [clientOrId, tenantId])
    : clientOrId;
  if (!client) return null;

  const ctx = await loadContext(tenantId, client);
  const conversion = conversionScore(ctx);
  const risk = riskScore(ctx);
  const relevancy = relevancyScore(ctx);
  const retention = retentionScore(ctx);

  const scores = {
    conversion: conversion.score,
    risk: risk.score,
    relevancy: relevancy.score,
    retention: retention.score,
  };
  const adjustments = await applyAdjustments(tenantId, client.id, scores);

  const w = WEIGHTS.health;
  const health = round1(clamp(
    scores.conversion * w.conversion
    + scores.relevancy * w.relevancy
    + scores.retention * w.retention
    + (100 - scores.risk) * w.risk,
    0, 100,
  ));

  const breakdown = {
    conversion: conversion.breakdown,
    risk: risk.breakdown,
    relevancy: relevancy.breakdown,
    retention: retention.breakdown,
    adjustments,
    weights: w,
  };

  // E7: a retention-risk flag is raised automatically, but clearing/labelling it
  // still requires a structured reason code chosen by a human.
  const atRisk = scores.retention < 50 || scores.risk > 65 ? 1 : 0;

  if (persist) {
    await run(
      `UPDATE clients SET conversion_score = ?, risk_score = ?, relevancy_score = ?, retention_score = ?,
         health_score = ?, retention_risk = ?, scores_updated_at = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
      [scores.conversion, scores.risk, scores.relevancy, scores.retention, health, atRisk,
        nowIso(), nowIso(), client.id, tenantId],
    );
  }
  if (snapshot) {
    await run(
      `INSERT INTO client_score_history (id, tenant_id, client_id, snapshot_date, conversion, risk,
         relevancy, retention, health, breakdown, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (tenant_id, client_id, snapshot_date) DO UPDATE SET
         conversion = excluded.conversion, risk = excluded.risk, relevancy = excluded.relevancy,
         retention = excluded.retention, health = excluded.health, breakdown = excluded.breakdown`,
      [uuid(), tenantId, client.id, todayIso(), scores.conversion, scores.risk, scores.relevancy,
        scores.retention, health, JSON.stringify(breakdown), nowIso()],
    );
  }

  return { ...scores, health, retention_risk: atRisk, breakdown };
}

/** Nightly recompute for every live client in a tenant. */
export async function scoreAllClients(tenantId, { snapshot = true } = {}) {
  const clients = await all(
    "SELECT * FROM clients WHERE tenant_id = ? AND deleted_at IS NULL AND status != 'lost'",
    [tenantId],
  );
  for (const c of clients) await scoreClient(tenantId, c, { persist: true, snapshot });
  return clients.length;
}
