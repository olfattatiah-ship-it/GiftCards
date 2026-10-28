// اختبارات مسارات الاستحقاقات عبر HTTP: الصلاحيات، والمدخلات الخاطئة، وتسلسل الإجراء، والتراجع عند فشل التصدير.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { openDatabase } = require('../server/db');
const auth = require('../server/services/auth');
const ben = require('../server/services/beneficiaries');
const ent = require('../server/services/entitlements');
const { createApp } = require('../server/app');

const PASSWORD = 'correct-horse-battery';
const CARD = (n) => String(n).padStart(20, '0');

let server, base, db, admin, adminCookie, reviewerCookie;

function xlsxB64(aoa) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'x');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }).toString('base64');
}

async function call(method, path, { body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

before(async () => {
  db = openDatabase(':memory:');
  admin = auth.createUser(db, null, { username: 'admin', fullName: 'مدير', password: PASSWORD, role: 'admin' });
  auth.createUser(db, null, { username: 'rev', fullName: 'مراجع', password: PASSWORD, role: 'reviewer' });
  ben.importBeneficiaries(db, admin, {
    rows: [
      { excelRow: 2, seq: '1', fileNo: '0038', name: 'أحمد علي', phone: '0531111111', card: CARD(1), legacyBalance: null },
      { excelRow: 3, seq: '2', fileNo: '0039', name: 'فاطمة محمد', phone: '0532222222', card: CARD(2), legacyBalance: null },
    ],
    fileName: 'f.xlsx', fileSha256: 'x',
  });
  const app = createApp(db);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
  adminCookie = login.headers.get('set-cookie').split(';')[0];
  const rl = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'rev', password: PASSWORD }) });
  reviewerCookie = rl.headers.get('set-cookie').split(';')[0];
});

after(() => new Promise((resolve) => server.close(resolve)));

test('every entitlement route requires a session', async () => {
  for (const [m, p] of [['GET', '/api/entitlements/open'], ['POST', '/api/entitlements'], ['POST', '/api/entitlements/1/export'], ['POST', '/api/entitlements/1/complete']]) {
    const r = await call(m, p, { body: m === 'POST' ? {} : undefined });
    assert.equal(r.status, 401, `${m} ${p}`);
  }
});

test('a reviewer cannot upload a file (403)', async () => {
  const r = await call('POST', '/api/entitlements', { cookie: reviewerCookie, body: { file_name: 'x.xlsx', file_base64: xlsxB64([['الرمز', 'العائلة', 'القيمة'], ['0038', 'أحمد علي', 5]]) } });
  assert.equal(r.status, 403);
});

test('bad input is refused with a message, never a server error', async () => {
  const empty = await call('POST', '/api/entitlements', { cookie: adminCookie, body: { file_name: 'x.xlsx', file_base64: '' } });
  assert.equal(empty.status, 400);
  const garbage = await call('POST', '/api/entitlements', { cookie: adminCookie, body: { file_name: 'x.xlsx', file_base64: Buffer.from('not an excel file').toString('base64') } });
  assert.equal(garbage.status, 400);
  assert.ok(garbage.data.error);
  const noCols = await call('POST', '/api/entitlements', { cookie: adminCookie, body: { file_name: 'x.xlsx', file_base64: xlsxB64([['الاسم', 'المبلغ'], ['x', 1]]) } });
  assert.equal(noCols.status, 400);
  assert.match(noCols.data.error, /الرمز/);
});

test('the full sequence over HTTP: draft, complete refused while blocked, complete, export, operations', async () => {
  const up = await call('POST', '/api/entitlements', {
    cookie: adminCookie,
    body: { file_name: 'month.xlsx', file_base64: xlsxB64([['الرمز', 'العائلة', 'القيمة'], ['0038', 'أحمد علي', 500], ['0039', 'اسم مختلف', 300], ['0077', 'غير مسجل', 100]]) },
  });
  assert.equal(up.status, 201);
  assert.equal(up.data.batch.isDraft, true);
  const id = up.data.batch.id;

  const early = await call('POST', `/api/entitlements/${id}/complete`, { cookie: adminCookie, body: {} });
  assert.equal(early.status, 400);

  const ops = await call('GET', '/api/operations', { cookie: adminCookie });
  assert.ok(!ops.data.items.some((o) => o.kind === 'entitlements.import'), 'a draft is not in the operations log');

  const unregistered = up.data.rows.find((r) => r.fileNo === '0077');
  const mismatch = up.data.rows.find((r) => r.fileNo === '0039');
  let r = await call('POST', `/api/entitlements/${id}/rows/${unregistered.id}/beneficiary`, { cookie: adminCookie, body: { card_no: CARD(77), phone: '' } });
  assert.equal(r.status, 201);
  r = await call('POST', `/api/entitlements/${id}/rows/${mismatch.id}/name`, { cookie: adminCookie, body: { choice: 'keep_db_name' } });
  assert.equal(r.status, 200);

  const done = await call('POST', `/api/entitlements/${id}/complete`, { cookie: adminCookie, body: {} });
  assert.equal(done.status, 200);
  assert.equal(done.data.batch.isDraft, false);

  const noPhone = await call('POST', `/api/entitlements/${id}/export`, { cookie: adminCookie });
  assert.equal(noPhone.status, 400);
  assert.match(noPhone.data.error, /جوال/);
  assert.equal(noPhone.data.details.length, 1, 'the list of beneficiaries without a phone is shown');

  const phone = await call('POST', `/api/entitlements/${id}/rows/${unregistered.id}/phone`, { cookie: adminCookie, body: { phone: '0503333333' } });
  assert.equal(phone.status, 200);

  const exp = await call('POST', `/api/entitlements/${id}/export`, { cookie: adminCookie });
  assert.equal(exp.status, 200);
  assert.equal(exp.data.files.length, 2);
  assert.ok(exp.data.files.every((f) => f.name.endsWith('.xlsx') && f.base64.length > 100));
  assert.ok(exp.data.template.includes('أسواق المنتزه'));

  // بعد أول تصدير تُغلق العملية تلقائيًا، فلا يمكن التصدير مرة أخرى
  const again = await call('POST', `/api/entitlements/${id}/export`, { cookie: adminCookie });
  assert.equal(again.status, 400);

  const opsAfter = await call('GET', '/api/operations', { cookie: adminCookie });
  const row = opsAfter.data.items.find((o) => o.kind === 'entitlements.import');
  assert.equal(row.status, 'exported');
  assert.ok(row.exportedAt);
  assert.equal(row.files.length, 2, 'both files are listed for download');

  // تنزيل الملف المحفوظ يعطي ملف Excel مطابقًا للملف المصدّر
  const dl = await fetch(base + `/api/exported-files/${row.files[0].id}`, { headers: { Cookie: adminCookie } });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert.equal(bytes.slice(0, 2).toString('latin1'), 'PK', 'a valid xlsx file (zip container)');
  assert.equal(bytes.toString('base64'), exp.data.files[0].base64);

  const missing = await fetch(base + '/api/exported-files/999999', { headers: { Cookie: adminCookie } });
  assert.equal(missing.status, 404);
  const anon = await fetch(base + `/api/exported-files/${row.files[0].id}`);
  assert.equal(anon.status, 401);

  const openNow = await call('GET', '/api/entitlements/open', { cookie: adminCookie });
  assert.equal(openNow.data.batch, null, 'closed automatically, so the next file can be uploaded');
});
test('an importer cannot download saved export files (403), while a reviewer can', async () => {
  const ops = await call('GET', '/api/operations', { cookie: adminCookie });
  const row = ops.data.items.find((o) => o.kind === 'entitlements.import');
  auth.createUser(db, null, { username: 'importer2', fullName: 'مستورد', password: PASSWORD, role: 'importer' });
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'importer2', password: PASSWORD }) });
  const importerCookie = login.headers.get('set-cookie').split(';')[0];
  const url = base + `/api/exported-files/${row.files[0].id}`;

  const denied = await fetch(url, { headers: { Cookie: importerCookie } });
  assert.equal(denied.status, 403);
  const allowed = await fetch(url, { headers: { Cookie: reviewerCookie } });
  assert.equal(allowed.status, 200);
});

test('cancel over HTTP deletes a draft, and a closed batch cannot be cancelled', async () => {
  const up = await call('POST', '/api/entitlements', {
    cookie: adminCookie, body: { file_name: 'tmp.xlsx', file_base64: xlsxB64([['الرمز', 'العائلة', 'القيمة'], ['0038', 'أحمد علي', 5]]) },
  });
  assert.equal(up.status, 201);
  const c = await call('POST', `/api/entitlements/${up.data.batch.id}/cancel`, { cookie: adminCookie, body: {} });
  assert.equal(c.status, 200);
  const open = await call('GET', '/api/entitlements/open', { cookie: adminCookie });
  assert.equal(open.data.batch, null);
  const opsCount = (await call('GET', '/api/operations', { cookie: adminCookie })).data.items.length;
  assert.equal(opsCount, 2, 'only the beneficiaries import and the exported batch remain');
});

test('an export that fails while building files rolls back completely', () => {
  const batchId = ent.createBatch(db, admin, {
    rows: [{ excelRow: 2, fileNo: '0038', name: 'أحمد علي', amount: 9, parseError: null }],
    fileName: 'roll.xlsx', fileSha256: 'x', fileData: Buffer.from('x'),
  });
  ent.completeBatch(db, admin, batchId);
  const shipmentsBefore = db.prepare('SELECT COUNT(*) n FROM shipments').get().n;
  assert.throws(() => ent.exportBatch(db, admin, batchId, { build: () => { throw new Error('فشل البناء'); } }), /فشل البناء/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shipments').get().n, shipmentsBefore, 'no shipment was written');
  const row = db.prepare('SELECT status, exported_at FROM import_batches WHERE id = ?').get(batchId);
  assert.equal(row.status, 'in_review');
  assert.equal(row.exported_at, null);
  ent.exportBatch(db, admin, batchId, { build: () => [] });
});

