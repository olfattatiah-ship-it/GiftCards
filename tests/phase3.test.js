const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../server/db');
const auth = require('../server/services/auth');
const ben = require('../server/services/beneficiaries');
const { createApp } = require('../server/app');

const PASSWORD = 'correct-horse-battery';
const CARD = (n) => String(n).padStart(20, '0');

let server;
let base;
let db;
let adminCookie;
let ids = {};

function rows() {
  return [
    { excelRow: 2, seq: '1', fileNo: '0038', name: 'أحمد علي', phone: '0531111111', card: CARD(1), legacyBalance: null },
    { excelRow: 3, seq: '2', fileNo: '0039', name: 'فاطمة محمد', phone: '0592261089', card: CARD(2), legacyBalance: null },
    { excelRow: 4, seq: '3', fileNo: '0040', name: 'مريم حسن', phone: '0592261089', card: null, legacyBalance: null },
    { excelRow: 5, seq: '4', fileNo: '0041', name: 'زهراء سعيد', phone: '+97334087022', card: CARD(3), legacyBalance: null },
  ];
}

async function call(method, path, { body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') };
}

before(async () => {
  db = openDatabase(':memory:');
  const admin = auth.createUser(db, null, { username: 'admin', fullName: 'مدير', password: PASSWORD, role: 'admin' });
  ben.importBeneficiaries(db, admin, { rows: rows(), fileName: 'f.xlsx', fileSha256: 'x' });
  for (const r of db.prepare('SELECT id, file_no FROM beneficiaries').all()) ids[r.file_no] = r.id;
  const app = createApp(db);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await call('POST', '/api/login', { body: { username: 'admin', password: PASSWORD } });
  adminCookie = login.setCookie.split(';')[0];
});

after(() => new Promise((resolve) => server.close(resolve)));

test('pages and data require a session', async () => {
  const r = await call('GET', '/api/beneficiaries');
  assert.equal(r.status, 401);
  const s = await call('GET', '/api/summary');
  assert.equal(s.status, 401);
});

test('login sets an HttpOnly, SameSite=Strict session cookie', async () => {
  const r = await call('POST', '/api/login', { body: { username: 'admin', password: PASSWORD } });
  assert.equal(r.status, 200);
  assert.match(r.setCookie, /HttpOnly/);
  assert.match(r.setCookie, /SameSite=Strict/);
});

test('wrong password gives the same message for unknown users', async () => {
  const a = await call('POST', '/api/login', { body: { username: 'admin', password: 'wrong-password-1' } });
  const b = await call('POST', '/api/login', { body: { username: 'nobody', password: 'wrong-password-1' } });
  assert.equal(a.status, 401);
  assert.equal(a.data.error, b.data.error);
});

test('login is locked after repeated failures', async () => {
  for (let i = 0; i < 5; i++) await call('POST', '/api/login', { body: { username: 'locked-user', password: 'x' } });
  const r = await call('POST', '/api/login', { body: { username: 'locked-user', password: 'x' } });
  assert.equal(r.status, 429);
});

test('summary counts beneficiaries, missing cards and flags', async () => {
  const r = await call('GET', '/api/summary', { cookie: adminCookie });
  assert.equal(r.data.total, 4);
  assert.equal(r.data.withoutCard, 1);
  assert.equal(r.data.flagged, 3);
  assert.equal(r.data.activeCards, 3);
});

test('search matches names with alef variants and card numbers', async () => {
  const byName = await call('GET', '/api/beneficiaries?q=' + encodeURIComponent('أحمد'), { cookie: adminCookie });
  assert.deepEqual(byName.data.items.map((i) => i.file_no), ['0038']);
  const byCard = await call('GET', '/api/beneficiaries?q=' + CARD(3), { cookie: adminCookie });
  assert.deepEqual(byCard.data.items.map((i) => i.file_no), ['0041']);
});

test('filters: no card and flagged', async () => {
  const noCard = await call('GET', '/api/beneficiaries?filter=no_card', { cookie: adminCookie });
  assert.deepEqual(noCard.data.items.map((i) => i.file_no), ['0040']);
  const flagged = await call('GET', '/api/beneficiaries?filter=flagged', { cookie: adminCookie });
  assert.equal(flagged.data.total, 3);
});

test('edit saves name, phone and card without a reason and without an audit entry', async () => {
  const id = ids['0038'];
  const ok = await call('PATCH', `/api/beneficiaries/${id}`, {
    cookie: adminCookie, body: { full_name: 'أحمد علي', phone: '0533333333', card_no: CARD(60) },
  });
  assert.equal(ok.status, 200);
  const detail = await call('GET', `/api/beneficiaries/${id}`, { cookie: adminCookie });
  assert.equal(detail.data.beneficiary.phone, '0533333333');
  assert.equal(detail.data.beneficiary.card_no, CARD(60));
  assert.equal(detail.data.history, undefined);
  const ops = await call('GET', '/api/operations', { cookie: adminCookie });
  // تعديل المستفيد لا يُضيف أي عملية إلى السجل
  assert.equal(ops.data.items.length, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'beneficiary.%'`).get().n, 0);
});

test('status colors: every beneficiary is red until a shipment exists', async () => {
  const r = await call('GET', '/api/summary', { cookie: adminCookie });
  assert.equal(r.data.red, 4);
  assert.equal(r.data.green, 0);
  const red = await call('GET', '/api/beneficiaries?filter=red', { cookie: adminCookie });
  assert.equal(red.data.total, 4);
  const hasCard = await call('GET', '/api/beneficiaries?filter=has_card', { cookie: adminCookie });
  assert.ok(hasCard.data.total >= 3);
});

test('profile shows the balance from the file and no shipment date yet', async () => {
  const r = await call('GET', `/api/beneficiaries/${ids['0039']}`, { cookie: adminCookie });
  assert.equal(r.data.beneficiary.last_shipped_at, null);
  assert.equal(r.data.beneficiary.status.color, 'red');
  assert.equal(r.data.beneficiary.status.reason, 'لا يوجد سجل شحن سابق');
});

test('operations log lists the import and is refused to other roles', async () => {
  const ops = await call('GET', '/api/operations', { cookie: adminCookie });
  assert.equal(ops.status, 200);
  assert.ok(ops.data.items.some((o) => o.kind === 'beneficiaries.import' && o.user_name && o.status === 'imported'));
  auth.createUser(db, null, { username: 'importer1', fullName: 'مستورد', password: PASSWORD, role: 'importer' });
  const imp = await call('POST', '/api/login', { body: { username: 'importer1', password: PASSWORD } });
  const r = await call('GET', '/api/operations', { cookie: imp.setCookie.split(';')[0] });
  assert.equal(r.status, 403);
});


test('phone confirmation clears the flag', async () => {
  const id = ids['4985'] || db.prepare(`SELECT id FROM beneficiaries WHERE phone = '+97334087022'`).get().id;
  const r = await call('POST', `/api/beneficiaries/${id}/confirm-phone`, { cookie: adminCookie });
  assert.equal(r.status, 200);
  const detail = await call('GET', `/api/beneficiaries/${id}`, { cookie: adminCookie });
  assert.equal(detail.data.beneficiary.phone_flag, null);
});

test('a card can be added to a beneficiary without one, and card numbers are validated', async () => {
  const id = ids['0040'];
  const bad = await call('POST', `/api/beneficiaries/${id}/cards`, { cookie: adminCookie, body: { card_no: '12' } });
  assert.equal(bad.status, 400);
  const ok = await call('POST', `/api/beneficiaries/${id}/cards`, { cookie: adminCookie, body: { card_no: CARD(77) } });
  assert.equal(ok.status, 201);
  const again = await call('POST', `/api/beneficiaries/${id}/cards`, { cookie: adminCookie, body: { card_no: CARD(78) } });
  assert.equal(again.status, 400);
});

test('receipt data returns the beneficiary and active card', async () => {
  const r = await call('GET', `/api/beneficiaries/${ids['0039']}`, { cookie: adminCookie });
  assert.equal(r.data.beneficiary.file_no, '0039');
  assert.equal(r.data.cards.find((c) => c.status === 'active').card_no, CARD(2));
});

test('unknown beneficiary returns 404 and logout ends the session', async () => {
  const r = await call('GET', '/api/beneficiaries/999999', { cookie: adminCookie });
  assert.equal(r.status, 404);
  const out = await call('POST', '/api/logout', { cookie: adminCookie });
  assert.equal(out.status, 200);
  const after = await call('GET', '/api/me', { cookie: adminCookie });
  assert.equal(after.status, 401);
});

// آخر اختبار: تغيير كلمة المرور ينهي الجلسات الأخرى، لذلك يكون في النهاية
test('password change through the API', async () => {
  const cookie = (await call('POST', '/api/login', { body: { username: 'admin', password: PASSWORD } })).setCookie.split(';')[0];
  const bad = await call('POST', '/api/me/password', { cookie, body: { current_password: 'nope-nope-nope', new_password: 'another-password-1' } });
  assert.equal(bad.status, 400);
  const ok = await call('POST', '/api/me/password', { cookie, body: { current_password: PASSWORD, new_password: 'another-password-1' } });
  assert.equal(ok.status, 200);
  const old = await call('POST', '/api/login', { body: { username: 'admin', password: PASSWORD } });
  assert.equal(old.status, 401);
  const relogin = await call('POST', '/api/login', { body: { username: 'admin', password: 'another-password-1' } });
  assert.equal(relogin.status, 200);
});
