import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Lead Agency', email: 'owner@leads.test' });
const ownerToken = owner.access_token;
const ownerId = (await db.get('SELECT id FROM users WHERE email = ?', ['owner@leads.test'])).id;

async function join(name, email, role = 'employee') {
  const invite = await api.post('/users', { name, email, role }, { token: ownerToken });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const inviteToken = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: inviteToken, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Trichy Road',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { user: invite.body.data, token: accepted.body.data.access_token };
}
const settle = () => new Promise((r) => setTimeout(r, 60));
const inbox = async (userId, key) => await db.all('SELECT * FROM notifications WHERE user_id = ? AND event_key = ?', [userId, key]);
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

let karthik; let nithya; let sundar; let rahul; let project; let delivery;
const client = (await api.post('/crm/clients', { name: 'Phoenixx internal' }, { token: ownerToken })).body.data;

before(async () => {
  karthik = await join('Karthik', 'karthik@leads.test', 'manager');
  nithya = await join('Nithya', 'nithya@leads.test');
  sundar = await join('Sundar', 'sundar@leads.test');
  rahul = await join('Rahul', 'rahul@leads.test');
  let res = await api.post('/projects', {
    client_id: client.id, name: 'Marketing – Inside India', kind: 'marketing',
    manager_id: karthik.user.id, lead_id: nithya.user.id, owner_ids: [ownerId],
  }, { token: ownerToken });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  project = res.body.data;
  await api.post(`/projects/${project.id}/members`, { user_id: sundar.user.id, seat: 'member' }, { token: ownerToken });
  res = await api.post('/projects', { client_id: client.id, name: 'Website build' }, { token: ownerToken });
  delivery = res.body.data;
  await db.run("UPDATE tenants SET week_off_days = '[9]'");
});

const newLead = async (body = {}, token = sundar.token) => {
  const res = await api.post(`/marketing/projects/${project.id}/leads`, { company_name: 'ABC Technologies', phone: '9840012345', ...body }, { token });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};
const timeline = async (id) => (await api.get(`/marketing/leads/${id}`, { token: ownerToken })).body.data.timeline;

describe('leads in a marketing project', () => {
  test('only marketing projects carry leads', async () => {
    const res = await api.get(`/marketing/projects/${delivery.id}/leads`, { token: ownerToken });
    assert.equal(res.status, 404);
    const list = (await api.get('/marketing/projects', { token: ownerToken })).body.data;
    assert.deepEqual(list.map((p) => p.id), [project.id]);
  });

  test('a project member adds a lead; it is created once and logged', async () => {
    const lead = await newLead({ company_name: 'Nova Foods', email: 'imran@novafoods.com', assigned_to: sundar.user.id });
    assert.equal(lead.status, 'new');
    const events = (await timeline(lead.id)).map((a) => a.event_type);
    assert.ok(events.includes('lead_created') && events.includes('assigned'));
  });

  test('the same company and contact cannot be entered twice', async () => {
    const res = await api.post(`/marketing/projects/${project.id}/leads`, { company_name: 'nova foods', email: 'IMRAN@novafoods.com' }, { token: sundar.token });
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /existing lead/);
  });

  test('someone not on the project cannot see or add its leads', async () => {
    assert.equal((await api.get(`/marketing/projects/${project.id}/leads`, { token: rahul.token })).status, 404);
    assert.equal((await api.post(`/marketing/projects/${project.id}/leads`, { company_name: 'X' }, { token: rahul.token })).status, 404);
  });

  test('changing the status from the dropdown is recorded on the timeline', async () => {
    const lead = await newLead({ company_name: 'Vel Textiles', phone: '9840099999' });
    const res = await api.patch(`/marketing/leads/${lead.id}`, { status: 'interested' }, { token: sundar.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const change = (await timeline(lead.id)).find((a) => a.event_type === 'status_changed');
    assert.deepEqual([change.meta.from, change.meta.to], ['new', 'interested']);
  });

  test('a logged call moves a new lead to contacted', async () => {
    const lead = await newLead({ company_name: 'Greenleaf', phone: '9840011111' });
    const res = await api.post(`/marketing/leads/${lead.id}/activities`, { type: 'call', description: 'Intro call', outcome: 'connected' }, { token: sundar.token });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, 'contacted');
  });

  test('CSV import creates leads and reports duplicates instead of creating them', async () => {
    const csv = 'Company,Contact,Phone,Email,Source,Assignee\nSunrise Exports,Fatima,9840022222,fatima@sunrise.com,website,sundar@leads.test\n'
      + '"Bluewave, Logistics",Sanjana,9840033333,,linkedin,\nNova Foods,Imran,,imran@novafoods.com,email,\n,No company,,,,\n';
    const res = await api.post(`/marketing/projects/${project.id}/leads/import`, { csv }, { token: sundar.token });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.created, 2);
    assert.equal(res.body.data.duplicates.length, 1);
    assert.equal(res.body.data.errors.length, 1);
    const names = (await api.get(`/marketing/projects/${project.id}/leads`, { token: ownerToken })).body.data.map((l) => l.company_name);
    assert.ok(names.includes('Bluewave, Logistics'));
  });
});

describe('⭐ progressive leads', () => {
  let lead;
  before(async () => { lead = await newLead({ company_name: 'XYZ Manufacturing', phone: '9840044444', assigned_to: sundar.user.id }); });

  test('only the project manager and lead can star a lead', async () => {
    const body = { on: true, reasons: ['meeting_requested'], priority: 'high', next_action: 'Book the demo', next_followup_date: tomorrow };
    assert.equal((await api.post(`/marketing/leads/${lead.id}/progressive`, body, { token: sundar.token })).status, 403);
    const res = await api.post(`/marketing/leads/${lead.id}/progressive`, body, { token: nithya.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.is_progressive, true);
  });

  test('a star needs reasons, a priority, a next action and a follow-up date', async () => {
    const other = await newLead({ company_name: 'Pinnacle Realty', phone: '9840055555' });
    const res = await api.post(`/marketing/leads/${other.id}/progressive`, { on: true, reasons: [], priority: 'high' }, { token: nithya.token });
    assert.equal(res.status, 400);
  });

  test('a ⭐ lead appears in the progressive view without being copied', async () => {
    const stars = (await api.get(`/marketing/projects/${project.id}/leads?view=progressive`, { token: ownerToken })).body.data;
    assert.deepEqual(stars.map((l) => l.id), [lead.id]);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM leads WHERE company_name = ?', ['XYZ Manufacturing'])).n, 1);
    await settle();
    assert.equal((await inbox(ownerId, 'marketing.progressive_added')).length, 1, 'the project owner was told');
  });

  test('removing the star needs a reason and keeps the history', async () => {
    assert.equal((await api.post(`/marketing/leads/${lead.id}/progressive`, { on: false }, { token: karthik.token })).status, 400);
    const res = await api.post(`/marketing/leads/${lead.id}/progressive`, { on: false, reason: 'Client postponed project' }, { token: karthik.token });
    assert.equal(res.status, 200);
    const detail = (await api.get(`/marketing/leads/${lead.id}`, { token: ownerToken })).body.data;
    assert.deepEqual(detail.progressive_history.map((h) => h.action).sort(), ['disabled', 'enabled']);
    assert.equal(detail.progressive_history.find((h) => h.action === 'disabled').reason, 'Client postponed project');
  });
});

describe('the daily lead update', () => {
  let lead;
  before(async () => { lead = await newLead({ company_name: 'Metro Clinics', phone: '9840066666', status: 'qualified', assigned_to: sundar.user.id }); });

  test('it needs a next action and a follow-up date', async () => {
    const res = await api.post(`/marketing/leads/${lead.id}/updates`, { outcome: 'follow_up_done', progress_note: 'Spoke to Dr. Kavya' }, { token: sundar.token });
    assert.equal(res.status, 400);
  });

  test('an outcome moves the status forward, never back', async () => {
    let res = await api.post(`/marketing/leads/${lead.id}/updates`, {
      outcome: 'proposal_sent', progress_note: 'Sent the proposal', next_action: 'Chase feedback', next_followup_date: tomorrow,
    }, { token: sundar.token });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'proposal');
    res = await api.post(`/marketing/leads/${lead.id}/updates`, {
      outcome: 'interested', progress_note: 'Still keen', next_action: 'Chase', next_followup_date: tomorrow,
    }, { token: sundar.token });
    assert.equal(res.body.data.status, 'proposal', 'not dragged back to interested');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM lead_updates WHERE lead_id = ?', [lead.id])).n, 1, 'one update per person per day');
  });

  test('an owner action reaches the project owners and can be resolved', async () => {
    const res = await api.post(`/marketing/leads/${lead.id}/updates`, {
      outcome: 'negotiation', progress_note: 'Wants 10% off', next_action: 'Revise quote', next_followup_date: tomorrow,
      owner_action_required: true, owner_action_text: 'Approve the discount', owner_action_due: tomorrow, owner_action_priority: 'high',
    }, { token: sundar.token });
    assert.equal(res.body.data.owner_action_required, true);
    await settle();
    assert.equal((await inbox(ownerId, 'marketing.owner_action')).length, 1);
    const attention = (await api.get('/marketing/owner-attention', { token: ownerToken })).body.data;
    assert.ok(attention.some((l) => l.id === lead.id));
    const done = await api.post(`/marketing/leads/${lead.id}/owner-action/resolve`, { note: 'Approved 8%' }, { token: ownerToken });
    assert.equal(done.body.data.owner_action_required, false);
  });

  test('winning a lead converts it into a CRM client', async () => {
    const res = await api.patch(`/marketing/leads/${lead.id}`, { status: 'won' }, { token: sundar.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const converted = await db.get('SELECT * FROM clients WHERE id = ?', [res.body.data.converted_client_id]);
    assert.equal(converted.name, 'Metro Clinics');
    assert.equal(converted.status, 'active');
  });
});

describe('dead leads', () => {
  let lead;
  before(async () => { lead = await newLead({ company_name: 'Orbit Media', phone: '9840077777', status: 'contacted' }); });

  test('only the manager or lead can mark a lead dead, and it needs a reason', async () => {
    assert.equal((await api.post(`/marketing/leads/${lead.id}/dead`, { reason_code: 'no_response' }, { token: sundar.token })).status, 403);
    assert.equal((await api.post(`/marketing/leads/${lead.id}/dead`, { reason_code: 'other' }, { token: nithya.token })).status, 400);
    const res = await api.post(`/marketing/leads/${lead.id}/dead`, { reason_code: 'no_response', note: 'Five follow-ups, no reply' }, { token: nithya.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'dead');
  });

  test('it is stored in the dead lead register and leaves the live list', async () => {
    const dead = (await api.get(`/marketing/projects/${project.id}/dead-leads`, { token: ownerToken })).body.data;
    assert.equal(dead.length, 1);
    assert.equal(dead[0].reason_code, 'no_response');
    assert.equal(dead[0].status_at_death, 'contacted');
    const live = (await api.get(`/marketing/projects/${project.id}/leads`, { token: ownerToken })).body.data;
    assert.ok(!live.some((l) => l.id === lead.id));
  });

  test('a dead lead can be revived, and the register keeps the record', async () => {
    const res = await api.post(`/marketing/leads/${lead.id}/revive`, { note: 'They replied after all' }, { token: karthik.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'contacted');
    const all = (await api.get(`/marketing/projects/${project.id}/dead-leads?include_revived=true`, { token: ownerToken })).body.data;
    assert.ok(all[0].revived_at);
  });
});

describe('health, escalation and reports', () => {
  let lead;
  before(async () => {
    lead = await newLead({ company_name: 'Global Industries', phone: '9840088888', assigned_to: sundar.user.id });
    await api.post(`/marketing/leads/${lead.id}/progressive`,
      { on: true, reasons: ['negotiation'], priority: 'critical', next_action: 'Close', next_followup_date: tomorrow }, { token: nithya.token });
    // Nothing has happened for 8 days.
    await db.run('UPDATE leads SET last_activity_at = ? WHERE id = ?', [new Date(Date.now() - 8 * 86_400_000).toISOString(), lead.id]);
  });

  test('a ⭐ lead with no activity for 5 working days is stalled', async () => {
    const stars = (await api.get(`/marketing/projects/${project.id}/leads?view=progressive`, { token: ownerToken })).body.data;
    const row = stars.find((l) => l.id === lead.id);
    assert.equal(row.health.id, 'stalled');
  });

  test('the watch escalates it to the project owner', async () => {
    const tenantId = (await db.get('SELECT tenant_id FROM users WHERE id = ?', [ownerId])).tenant_id;
    const { watchProgressive } = await import('../src/services/marketing.js');
    await watchProgressive(tenantId);
    await settle();
    assert.equal((await inbox(ownerId, 'marketing.progressive_escalated')).length, 1);
    assert.equal((await inbox(karthik.user.id, 'marketing.progressive_escalated')).length, 1, 'the manager seat too');
    assert.ok(await db.get("SELECT id FROM escalations WHERE source_type = 'lead' AND source_id = ?", [lead.id]));
  });

  test('daily and weekly reports generate, and only the project can see them', async () => {
    let res = await api.post(`/marketing/projects/${project.id}/reports`, { kind: 'marketing_daily' }, { token: nithya.token });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const daily = (await api.get(`/reports/${res.body.data.id}`, { token: ownerToken })).body.data;
    assert.equal(daily.payload.sections[0].heading, 'Lead activity today');
    res = await api.post(`/marketing/projects/${project.id}/reports`, { kind: 'marketing_weekly' }, { token: nithya.token });
    assert.equal(res.status, 201);
    assert.equal((await api.get(`/reports/${res.body.data.id}`, { token: rahul.token })).status, 404);
    const rahulList = (await api.get('/reports', { token: rahul.token })).body.data;
    assert.ok(!rahulList.some((r) => r.id === res.body.data.id));
  });

  test('settings must keep the ladder climbing; only the Owner changes them', async () => {
    const meta = (await api.get('/marketing/meta', { token: ownerToken })).body.data;
    assert.equal(meta.settings.stalled_days, 5);
    assert.equal((await api.put('/marketing/settings', { stalled_days: 2 }, { token: ownerToken })).status, 400);
    assert.equal((await api.put('/marketing/settings', { daily_report_time: '20:00' }, { token: sundar.token })).status, 403);
    const res = await api.put('/marketing/settings', { daily_report_time: '20:00', stalled_days: 4 }, { token: ownerToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.daily_report_time, '20:00');
  });
});
