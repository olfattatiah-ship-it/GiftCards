const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const XLSX = require('xlsx');
const { openDatabase } = require('../server/db');
const auth = require('../server/services/auth');
const { record, listForEntity } = require('../server/services/audit');
const { parseBeneficiaryWorkbook } = require('../server/services/excel-beneficiaries');
const ben = require('../server/services/beneficiaries');

const PASSWORD = 'correct-horse-battery';
const CARD = (n) => String(n).padStart(20, '0');

function setup() {
  const db = openDatabase(':memory:');
  const admin = auth.createUser(db, null, { username: 'admin', fullName: 'مدير', password: PASSWORD, role: 'admin' });
  return { db, admin };
}

function sampleRows() {
  return [
    { excelRow: 2, seq: '1', fileNo: '0038', name: 'أ ب', phone: '0531111111', card: CARD(1), legacyBalance: '500' },
    { excelRow: 3, seq: '2', fileNo: '0039', name: 'ج د', phone: '0592261089', card: CARD(2), legacyBalance: null },
    { excelRow: 4, seq: '3', fileNo: '0040', name: 'هـ و', phone: '0592261089', card: null, legacyBalance: null },
    { excelRow: 5, seq: '4', fileNo: '0041', name: 'ز ح', phone: '+97334087022', card: CARD(3), legacyBalance: null },
  ];
}

test('password hashing verifies only the right password', () => {
  const h = auth.hashPassword(PASSWORD);
  assert.equal(auth.verifyPassword(PASSWORD, h), true);
  assert.equal(auth.verifyPassword('wrong-password-123', h), false);
  assert.equal(auth.verifyPassword(PASSWORD, 'garbage'), false);
});

test('passwords shorter than 10 characters are rejected', () => {
  const db = openDatabase(':memory:');
  assert.throws(() => auth.createUser(db, null, { username: 'x', fullName: 'x', password: 'short', role: 'admin' }), /10/);
});

test('login issues a session, logout ends it, wrong password fails and is logged', () => {
  const { db } = setup();
  assert.equal(auth.login(db, 'admin', 'wrong-password-123'), null);
  const token = auth.login(db, 'admin', PASSWORD);
  assert.ok(token);
  assert.equal(auth.currentUser(db, token).username, 'admin');
  auth.logout(db, token);
  assert.equal(auth.currentUser(db, token), null);
  const actions = db.prepare('SELECT action FROM audit_log ORDER BY id').all().map((r) => r.action);
  assert.ok(actions.includes('auth.login_failed'));
  assert.ok(actions.includes('auth.login'));
});

test('expired sessions are not accepted', () => {
  const { db } = setup();
  const token = auth.login(db, 'admin', PASSWORD);
  db.exec(`UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'`);
  assert.equal(auth.currentUser(db, token), null);
});

test('audit log cannot be updated or deleted', () => {
  const { db, admin } = setup();
  record(db, { userId: admin.id, action: 'test', entity: 'x', entityId: 1 });
  assert.throws(() => db.exec(`UPDATE audit_log SET action = 'changed'`), /append-only/);
  assert.throws(() => db.exec('DELETE FROM audit_log'), /append-only/);
});

test('parser reads columns by header and keeps leading zeros as text', () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['المعرف', 'id', 'العائلة', 'رقم البطاقة', 'رقم االجوال', 'اخر رصيد شحن', 'تاريخ اخرعملية شحن'],
    [1, '0038', 'أ ب', CARD(1), '0531111111', 500, ''],
    [2, '0039', 'ج د', '', '0530000000', '', ''],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'x');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const { rows } = parseBeneficiaryWorkbook(buf);
  assert.equal(rows[0].fileNo, '0038');
  assert.equal(rows[0].card, CARD(1));
  assert.equal(rows[1].card, null);
  assert.equal(rows[1].excelRow, 3);
});

test('import rejects duplicate file numbers and writes nothing', () => {
  const { db, admin } = setup();
  const rows = sampleRows();
  rows[1].fileNo = '0038';
  assert.throws(
    () => ben.importBeneficiaries(db, admin, { rows, fileName: 'f.xlsx', fileSha256: 'x' }),
    (err) => err.details.some((d) => d.includes('مكرر'))
  );
  assert.equal(db.prepare('SELECT COUNT(*) n FROM beneficiaries').get().n, 0);
});

test('import reports missing cards and flags duplicate and international phones', () => {
  const { db, admin } = setup();
  const r = ben.importBeneficiaries(db, admin, { rows: sampleRows(), fileName: 'f.xlsx', fileSha256: 'x' });
  assert.equal(r.imported, 4);
  assert.deepEqual(r.withoutCard.map((x) => x.fileNo), ['0040']);
  assert.equal(r.duplicatePhones.length, 2);
  assert.equal(r.internationalPhones.length, 1);
  const flagged = ben.findFlagged(db).map((x) => x.phone_flag);
  assert.deepEqual(flagged.sort(), ['duplicate', 'duplicate', 'international']);
  assert.equal(ben.findMissingCards(db).length, 1);
});

test('import refuses to run on a non-empty database', () => {
  const { db, admin } = setup();
  ben.importBeneficiaries(db, admin, { rows: sampleRows(), fileName: 'f.xlsx', fileSha256: 'x' });
  assert.throws(() => ben.importBeneficiaries(db, admin, { rows: sampleRows(), fileName: 'f.xlsx', fileSha256: 'x' }), /خلوّ/);
});

test('beneficiary edit needs no reason and writes no audit entry', () => {
  const { db, admin } = setup();
  ben.importBeneficiaries(db, admin, { rows: sampleRows(), fileName: 'f.xlsx', fileSha256: 'x' });
  const b = db.prepare(`SELECT id FROM beneficiaries WHERE file_no = '0038'`).get();
  const after = ben.updateBeneficiary(db, admin, b.id, { phone: '0533333333' });
  assert.equal(after.phone, '0533333333');
  assert.equal(listForEntity(db, 'beneficiary', b.id).length, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'beneficiary.%'`).get().n, 0);
});

test('editing the card number replaces the active card, and card numbers stay unique', () => {
  const { db, admin } = setup();
  ben.importBeneficiaries(db, admin, { rows: sampleRows(), fileName: 'f.xlsx', fileSha256: 'x' });
  const b = db.prepare(`SELECT id FROM beneficiaries WHERE file_no = '0038'`).get();
  ben.updateBeneficiary(db, admin, b.id, { card_no: CARD(55) });
  assert.equal(ben.activeCard(db, b.id).card_no, CARD(55));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cards WHERE beneficiary_id = ?').get(b.id).n, 1);
  assert.throws(() => ben.updateBeneficiary(db, admin, b.id, { card_no: CARD(2) }), /مسجل/);
});

test('phone confirmation clears the flag without an audit entry', () => {
  const { db, admin } = setup();
  ben.importBeneficiaries(db, admin, { rows: sampleRows(), fileName: 'f.xlsx', fileSha256: 'x' });
  const b = db.prepare(`SELECT id FROM beneficiaries WHERE phone = '+97334087022'`).get();
  const c = ben.confirmPhone(db, admin, b.id);
  assert.equal(c.phone_flag, null);
  assert.equal(listForEntity(db, 'beneficiary', b.id).length, 0);
});

test('shipment status: green up to 2 full months, orange 3, red 4+ or never', () => {
  const { shipmentStatus } = require('../server/services/status');
  const now = new Date(2026, 9, 20); // 20 Oct 2026
  assert.equal(shipmentStatus(null, now).color, 'red');
  assert.equal(shipmentStatus('2026-08-20 10:00:00', now).color, 'green'); // شهران بالضبط
  assert.equal(shipmentStatus('2026-08-21 10:00:00', now).color, 'green');
  assert.equal(shipmentStatus('2026-07-20 10:00:00', now).color, 'orange'); // ثلاثة أشهر
  assert.equal(shipmentStatus('2026-06-20 10:00:00', now).color, 'red');   // أربعة أشهر
});

test('login ignores letter case in the username', () => {
  const { db } = setup();
  assert.ok(auth.login(db, 'ADMIN', PASSWORD));
});

test('password change requires the current password and ends other sessions', () => {
  const { db, admin } = setup();
  const t1 = auth.login(db, 'admin', PASSWORD);
  const t2 = auth.login(db, 'admin', PASSWORD);
  assert.throws(() => auth.changePassword(db, admin, 'wrong-password-1', 'brand-new-password', t1), /الحالية/);
  auth.changePassword(db, admin, PASSWORD, 'brand-new-password', t1);
  assert.ok(auth.currentUser(db, t1));
  assert.equal(auth.currentUser(db, t2), null);
  assert.equal(auth.login(db, 'admin', PASSWORD), null);
  assert.ok(auth.login(db, 'admin', 'brand-new-password'));
});

test('a beneficiary without a card can receive one; a second active card is refused', () => {
  const { db, admin } = setup();
  ben.importBeneficiaries(db, admin, { rows: sampleRows(), fileName: 'f.xlsx', fileSha256: 'x' });
  const b = db.prepare(`SELECT id FROM beneficiaries WHERE file_no = '0040'`).get();
  ben.addCard(db, admin, b.id, CARD(99));
  assert.equal(ben.findMissingCards(db).length, 0);
  assert.throws(() => ben.addCard(db, admin, b.id, CARD(98)), /نشطة/);
});

test('card numbers must be 20 digits and unique', () => {
  const { db, admin } = setup();
  ben.importBeneficiaries(db, admin, { rows: sampleRows(), fileName: 'f.xlsx', fileSha256: 'x' });
  const b = db.prepare(`SELECT id FROM beneficiaries WHERE file_no = '0040'`).get();
  assert.throws(() => ben.addCard(db, admin, b.id, '123'), /20/);
  assert.throws(() => ben.addCard(db, admin, b.id, CARD(1)), /مسجل/);
});


test('real workbook parses to 379 rows when available (read-only)', { skip: !process.env.XLSX_PATH }, () => {
  const buf = fs.readFileSync(process.env.XLSX_PATH);
  const { rows } = parseBeneficiaryWorkbook(buf);
  assert.equal(rows.length, 379);
  assert.equal(rows.filter((r) => !r.card).length, 2);
});
