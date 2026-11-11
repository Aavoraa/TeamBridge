import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Docs Co', email: 'owner@docs.test', owner_name: 'Dev Owner' });
const ownerToken = owner.access_token;

async function join(name, email, role = 'employee') {
  const invite = await api.post('/users', { name, email, role }, { token: ownerToken });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const token = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Main Road',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { user: invite.body.data, token: accepted.body.data.access_token };
}

const b64 = (text) => Buffer.from(text).toString('base64');
const upload = (token, body) => api.post('/resources', {
  filename: 'brief.txt', mime: 'text/plain', content_base64: b64('Launch brief: three pages, blue palette.'), ...body,
}, { token });

let onTeam; let offTeam; let accountId; let projectId; let clientDoc; let projectDoc;
before(async () => {
  onTeam = await join('Tara Team', 'tara@docs.test');
  offTeam = await join('Oscar Outside', 'oscar@docs.test');
  const acc = await api.post('/clients', { name: 'Sunrise Foods' }, { token: ownerToken });
  assert.equal(acc.status, 201, JSON.stringify(acc.body));
  accountId = acc.body.data.id;
  const p = await api.post('/projects', { client_name: 'Sunrise Foods', name: 'Website rebuild', owner_ids: [owner.user.id] }, { token: ownerToken });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  projectId = p.body.data.id;
  const m = await api.post(`/projects/${projectId}/members`, { user_id: onTeam.user.id, seat: 'member' }, { token: ownerToken });
  assert.equal(m.status, 201, JSON.stringify(m.body));
});

describe('client and project documents', () => {
  test('an owner files a document on the client and on the project', async () => {
    const c = await upload(ownerToken, { client_account_id: accountId, title: 'Master services agreement', category: 'contract' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    clientDoc = c.body.data;
    assert.equal(clientDoc.client_name, 'Sunrise Foods');
    const p = await upload(ownerToken, { project_id: projectId, category: 'brief' });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    projectDoc = p.body.data;
    assert.equal(projectDoc.title, 'brief');
    assert.equal(projectDoc.project_name, 'Website rebuild');
  });

  test('a document needs exactly one of client or project', async () => {
    assert.equal((await upload(ownerToken, {})).status, 400);
    assert.equal((await upload(ownerToken, { client_account_id: accountId, project_id: projectId })).status, 400);
  });

  test('filtering by client shows its own documents and its projects\'', async () => {
    const r = await api.get(`/resources?client_account_id=${accountId}`, { token: ownerToken });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.map((d) => d.id).sort(), [clientDoc.id, projectDoc.id].sort());
  });

  test('someone on the project sees both; someone off it sees neither', async () => {
    const mine = await api.get('/resources', { token: onTeam.token });
    assert.deepEqual(mine.body.data.map((d) => d.id).sort(), [clientDoc.id, projectDoc.id].sort());
    const theirs = await api.get('/resources', { token: offTeam.token });
    assert.equal(theirs.body.data.length, 0);
    for (const path of [`/resources/${clientDoc.id}/file`, `/resources/${projectDoc.id}/pdf`]) {
      const res = await fetch(`${api.base}${path}`, { headers: { Authorization: `Bearer ${offTeam.token}` } });
      assert.equal(res.status, 404, path);
    }
  });

  test('the team member views it, downloads it, and gets it as a PDF', async () => {
    const auth = { Authorization: `Bearer ${onTeam.token}` };
    const view = await fetch(`${api.base}/resources/${projectDoc.id}/file`, { headers: auth });
    assert.equal(view.status, 200);
    assert.match(view.headers.get('content-disposition'), /^inline/);
    assert.equal(await view.text(), 'Launch brief: three pages, blue palette.');
    const dl = await fetch(`${api.base}/resources/${projectDoc.id}/file?download=1`, { headers: auth });
    assert.match(dl.headers.get('content-disposition'), /^attachment/);
    const pdf = await fetch(`${api.base}/resources/${projectDoc.id}/pdf`, { headers: auth });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.ok(Buffer.from(await pdf.arrayBuffer()).toString('latin1').startsWith('%PDF-'));
  });

  test('an uploaded HTML file is never shown inline', async () => {
    const h = await upload(onTeam.token, { project_id: projectId, filename: 'page.html', mime: 'text/html', content_base64: b64('<script>alert(1)</script>') });
    assert.equal(h.status, 201, JSON.stringify(h.body));
    const res = await fetch(`${api.base}/resources/${h.body.data.id}/file`, { headers: { Authorization: `Bearer ${onTeam.token}` } });
    assert.match(res.headers.get('content-disposition'), /^attachment/);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(res.headers.get('content-security-policy'), 'sandbox');
  });

  test('a team member adds to the project but not to the client, and deletes only their own', async () => {
    assert.equal((await upload(onTeam.token, { client_account_id: accountId })).status, 403);
    assert.equal((await upload(offTeam.token, { project_id: projectId })).status, 404);
    const mine = await upload(onTeam.token, { project_id: projectId, filename: 'notes.txt' });
    assert.equal(mine.status, 201);
    assert.equal(mine.body.data.can_delete, true);
    assert.equal((await api.del(`/resources/${projectDoc.id}`, { token: onTeam.token })).status, 403);
    assert.equal((await api.del(`/resources/${mine.body.data.id}`, { token: onTeam.token })).status, 200);
    assert.equal((await api.del(`/resources/${clientDoc.id}`, { token: ownerToken })).status, 200);
  });

  test('the generic file route does not serve resource files', async () => {
    const res = await fetch(`${api.base}/files/resources/${owner.user.tenant_id || 'x'}/anything`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(res.status, 404);
  });
});

describe('folder view: companies and their projects', () => {
  test('a company with two projects shows both, each with its own count', async () => {
    const second = await api.post('/projects', { client_name: 'Sunrise Foods', name: 'Social media retainer', owner_ids: [owner.user.id] }, { token: ownerToken });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal((await upload(ownerToken, { project_id: second.body.data.id, filename: 'calendar.txt' })).status, 201);
    assert.equal((await upload(ownerToken, { client_account_id: accountId, filename: 'nda.txt' })).status, 201);

    const r = await api.get('/resources/summary', { token: ownerToken });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const sunrise = r.body.data.companies.find((c) => c.id === accountId);
    assert.ok(sunrise, 'company listed');
    assert.equal(sunrise.has_company_folder, true);
    assert.equal(sunrise.doc_count, 1, 'company-level documents');
    const names = sunrise.projects.map((p) => p.name).sort();
    assert.deepEqual(names, ['Social media retainer', 'Website rebuild']);
    const retainer = sunrise.projects.find((p) => p.name === 'Social media retainer');
    assert.equal(retainer.doc_count, 1);
    assert.equal(sunrise.total_docs, sunrise.doc_count + sunrise.projects.reduce((n, p) => n + p.doc_count, 0));
  });

  test('a team member sees the company and only the projects they are on', async () => {
    const r = await api.get('/resources/summary', { token: onTeam.token });
    const sunrise = r.body.data.companies.find((c) => c.id === accountId);
    assert.deepEqual(sunrise.projects.map((p) => p.name), ['Website rebuild']);
    assert.equal(r.body.data.can_add_client_docs, false);
  });

  test('someone on no project sees no companies', async () => {
    const r = await api.get('/resources/summary', { token: offTeam.token });
    assert.deepEqual(r.body.data.companies, []);
  });
});
