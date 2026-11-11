import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const profiles = await import('../src/services/companyProfile.js');
const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Profile Co', email: 'owner@profile.test', owner_name: 'Priti Owner' });
const token = owner.access_token;

const long = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const PROFILE = {
  site_readable: true,
  company_name: 'Sunrise Foods',
  tagline: 'Fresh breakfast, delivered',
  overview: long(90),
  industry: 'Food and beverage',
  headquarters: 'Chennai, India',
  founded: '2014',
  size_signals: 'Serves 40 cities; 300 staff.',
  services: Array.from({ length: 6 }, (_, i) => ({ title: `Service ${i + 1}`, detail: long(30) })),
  target_customers: ['Families', 'Offices', 'Cafes'],
  value_proposition: long(50),
  differentiators: ['Farm sourcing', 'Same-day delivery'],
  brand_and_tone: long(45),
  digital_strengths: ['Clear menu', 'Fast pages'],
  digital_gaps: ['No blog', 'No reviews shown'],
  opportunities: Array.from({ length: 4 }, (_, i) => ({ title: `Idea ${i + 1}`, detail: long(35) })),
  talking_points: ['How do you find new office clients?', 'Who runs your social media?'],
  contact_details: ['hello@sunrise.example', '+91 44 0000 0000'],
  pages_reviewed: ['https://sunrise.example/', 'https://sunrise.example/about'],
  confidence_note: 'The site covers products well but says little about the team.',
};

let calls = [];
const waitFor = async (id, status) => {
  for (let i = 0; i < 50; i++) {
    const r = await api.get(`/clients/${id}/profile`, { token });
    if (r.body.data?.status === status) return r.body.data;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`profile never reached ${status}`);
};

describe('company profile from the client website', () => {
  test('a website is optional, and without one nothing is made', async () => {
    const r = await api.post('/clients', { name: 'No Site Ltd' }, { token });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const p = await api.get(`/clients/${r.body.data.id}/profile`, { token });
    assert.equal(p.body.data, null);
  });

  test('a website that is not a public web address is refused', async () => {
    for (const website of ['not a site', 'localhost', 'http://10.0.0.1']) {
      const r = await api.post('/clients', { name: `Bad ${website}`, website }, { token });
      assert.equal(r.status, 400, website);
    }
  });

  let clientId;
  test('adding a client with a website makes a two-page PDF', async () => {
    calls = [];
    profiles.setProfileProvider({ analyze: async (url) => { calls.push(url); return { profile: PROFILE, model: 'stub' }; } });
    const r = await api.post('/clients', { name: 'Sunrise Foods', website: 'sunrise.example' }, { token });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    clientId = r.body.data.id;
    assert.equal(r.body.data.website, 'https://sunrise.example/');

    const ready = await waitFor(clientId, 'ready');
    assert.deepEqual(calls, ['https://sunrise.example/']);
    assert.equal(ready.profile.company_name, 'Sunrise Foods');
    assert.equal(ready.has_pdf, true);

    const res = await fetch(`${api.base}/clients/${clientId}/profile.pdf`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    const pdf = Buffer.from(await res.arrayBuffer()).toString('latin1');
    assert.ok(pdf.startsWith('%PDF-'));
    assert.equal((pdf.match(/\/Type \/Page\b/g) || []).length, 2, 'exactly two pages');

    const detail = await api.get(`/clients/${clientId}`, { token });
    assert.equal(detail.body.data.company_profile.status, 'ready');
  });

  test('changing the website makes a new profile; a site that cannot be read fails with a reason', async () => {
    profiles.setProfileProvider({ analyze: async () => ({ profile: { ...PROFILE, site_readable: false }, model: 'stub' }) });
    const r = await api.patch(`/clients/${clientId}`, { website: 'https://sunrise-new.example' }, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const failed = await waitFor(clientId, 'failed');
    assert.match(failed.error, /could not be read/);
  });

  test('regenerate retries from the current website', async () => {
    profiles.setProfileProvider({ analyze: async () => ({ profile: PROFILE, model: 'stub' }) });
    const r = await api.post(`/clients/${clientId}/profile`, {}, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ready = await waitFor(clientId, 'ready');
    assert.equal(ready.website, 'https://sunrise-new.example/');
  });

  test('clearing the website removes the profile', async () => {
    const r = await api.patch(`/clients/${clientId}`, { website: '' }, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = await api.get(`/clients/${clientId}/profile`, { token });
    assert.equal(p.body.data, null);
    profiles.setProfileProvider(null);
  });
});
