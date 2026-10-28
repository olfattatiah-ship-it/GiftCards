const { test } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { openDatabase } = require('../server/db');
const auth = require('../server/services/auth');
const ben = require('../server/services/beneficiaries');
const ent = require('../server/services/entitlements');
const { parseEntitlementWorkbook } = require('../server/services/excel-entitlements');
const { buildSupplierFile, buildContactsFile } = require('../server/services/export-files');

const PASSWORD = 'correct-horse-battery';
const CARD = (n) => String(n).padStart(20, '0');
const HEADER = ['الرمز', 'العائلة', 'القيمة'];

function workbook(aoa) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'x');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const readBack = (b64) => {
  const wb = XLSX.read(Buffer.from(b64, 'base64'), { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false });
};

function setup() {
  const db = openDatabase(':memory:');
  const admin = auth.createUser(db, null, { username: 'admin', fullName: 'مدير', password: PASSWORD, role: 'admin' });
  const reviewer = auth.createUser(db, null, { username: 'rev', fullName: 'مراجع', password: PASSWORD, role: 'reviewer' });
  ben.importBeneficiaries(db, admin, {
    rows: [
      { excelRow: 2, seq: '1', fileNo: '0038', name: 'أحمد علي', phone: '0531111111', card: CARD(1), legacyBalance: null },
      { excelRow: 3, seq: '2', fileNo: '0039', name: 'فاطمة محمد', phone: '0592261089', card: CARD(2), legacyBalance: null },
      { excelRow: 4, seq: '3', fileNo: '0040', name: 'مريم حسن', phone: '0592261089', card: null, legacyBalance: null },
      { excelRow: 5, seq: '4', fileNo: '0041', name: 'زهراء سعيد', phone: '+97334087022', card: CARD(3), legacyBalance: null },
      { excelRow: 6, seq: '5', fileNo: '0042', name: 'سلمى خالد', phone: '0555555555', card: CARD(4), legacyBalance: null },
    ],
    fileName: 'f.xlsx', fileSha256: 'x',
  });
  return { db, admin, reviewer };
}

function mainFile() {
  return workbook([
    HEADER,
    ['0038', 'أحمد علي', 500],
    ['0039', 'فاطمة محمد', '750'],
    ['0040', 'مريم حسن', 300],
    ['0041', '  زهراء   سعيد ', '1,200'],
    ['0099', 'نورة صالح', 100],
    ['0042', 'سلمى خالد احمد', 250],
  ]);
}

// يحاكي ما يفعله المسار: قراءة الملف ثم إنشاء المسودة
function upload(db, actor, buf, name = 'entitlements.xlsx') {
  const { rows } = parseEntitlementWorkbook(buf);
  return ent.createBatch(db, actor, { rows, fileName: name, fileSha256: 'sha', fileData: buf });
}

const byFile = (analysis, fileNo) => analysis.rows.find((r) => r.fileNo === fileNo);

// يحل كل ما يحتاج إجراء في ملف الاختبار الأساسي
function resolveMainFile(db, admin, batchId) {
  let a = ent.analyzeBatch(db, batchId);
  ent.addCardForRow(db, admin, batchId, byFile(a, '0040').id, CARD(40));
  ent.decideName(db, admin, batchId, byFile(a, '0042').id, 'keep_db_name');
  ent.addUnregistered(db, admin, batchId, byFile(a, '0099').id, { card_no: CARD(99), phone: '0501111111' });
  return ent.analyzeBatch(db, batchId);
}

test('parser reads the three fields, ignores blank rows, and flags bad amounts', () => {
  const { rows } = parseEntitlementWorkbook(workbook([
    HEADER,
    ['0038', 'أحمد', 500],
    ['', '', ''],
    ['0039', 'فاطمة', 'abc'],
    ['0040', 'مريم', -5],
    ['0041', 'زهراء', ''],
    ['', 'بلا رقم', 10],
    ['0043', 'عدد عشري', '12.5'],
  ]));
  assert.equal(rows.length, 6);
  assert.equal(rows[0].amount, 500);
  assert.match(rows[1].parseError, /ليس رقمًا/);
  assert.match(rows[2].parseError, /سالب/);
  assert.match(rows[3].parseError, /فارغ/);
  assert.match(rows[4].parseError, /رقم ملف/);
  assert.equal(rows[5].amount, 12.5);
});

test('parser refuses a file without the required columns; "الرقم" is never the file number', () => {
  assert.throws(() => parseEntitlementWorkbook(workbook([['العائلة', 'القيمة'], ['x', 1]])), /الرمز/);
  assert.throws(() => parseEntitlementWorkbook(workbook([['الرقم', 'العائلة', 'القيمة'], [1, 'x', 1]])), /الرمز/);
});

test('upload creates only a draft: it is open, flagged as draft, and hidden from the operations log', () => {
  const { db, admin } = setup();
  const batchId = upload(db, admin, mainFile());
  const row = db.prepare('SELECT status, is_draft, row_count, exported_at, file_data FROM import_batches WHERE id = ?').get(batchId);
  assert.equal(row.status, 'in_review');
  assert.equal(row.is_draft, 1);
  assert.equal(row.row_count, 6);
  assert.equal(row.exported_at, null);
  assert.ok(row.file_data, 'the draft keeps the file for later');
  assert.equal(ent.analyzeBatch(db, batchId).batch.isDraft, true);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'import.entitlements%' OR action LIKE 'import.cancel%'`).get().n, 0, 'a draft writes no audit entry');
});

test('analysis classifies rows and totals amounts', () => {
  const { db, admin } = setup();
  const batchId = upload(db, admin, mainFile());
  const a = ent.analyzeBatch(db, batchId);
  assert.equal(byFile(a, '0038').status, 'ready');
  assert.equal(byFile(a, '0039').status, 'ready');
  assert.deepEqual(byFile(a, '0039').warnings, ['جوال مكرر']);
  assert.equal(byFile(a, '0040').status, 'missing_card');
  assert.equal(byFile(a, '0041').status, 'ready');
  assert.equal(byFile(a, '0099').status, 'unregistered');
  assert.equal(byFile(a, '0042').status, 'name_mismatch');
  assert.equal(a.totals.rows, 6);
  assert.equal(a.totals.amount, 500 + 750 + 300 + 1200 + 100 + 250);
  assert.equal(a.readyToExport, false);
  assert.equal(a.totals.blocking, 3);
});

test('a second file cannot be uploaded while one is open (draft or completed)', () => {
  const { db, admin } = setup();
  const batchId = upload(db, admin, mainFile());
  assert.throws(() => upload(db, admin, mainFile(), 'second.xlsx'), /لم تُغلق/);
  resolveMainFile(db, admin, batchId);
  ent.completeBatch(db, admin, batchId);
  assert.throws(() => upload(db, admin, mainFile(), 'second.xlsx'), /لم تُغلق/);
});

test('the reviewer cannot upload entitlements', () => {
  const { db, reviewer } = setup();
  assert.throws(() => upload(db, reviewer, mainFile()), /صلاحية/);
});

test('processing: a new beneficiary may be added without a phone, but export waits for the phone', () => {
  const { db, admin } = setup();
  const batchId = upload(db, admin, mainFile());
  let a = ent.analyzeBatch(db, batchId);
  ent.addCardForRow(db, admin, batchId, byFile(a, '0040').id, CARD(40));
  ent.decideName(db, admin, batchId, byFile(a, '0042').id, 'keep_db_name');
  ent.addUnregistered(db, admin, batchId, byFile(a, '0099').id, { card_no: CARD(99), phone: '' });
  a = ent.analyzeBatch(db, batchId);
  assert.equal(a.totals.blocking, 0);
  assert.equal(a.missingPhones.length, 1);
  assert.equal(a.readyToExport, false);
  ent.completeBatch(db, admin, batchId);
  assert.throws(() => ent.exportBatch(db, admin, batchId), /جوال/);
  ent.setPhoneForRow(db, admin, batchId, byFile(a, '0099').id, '0502222222');
  assert.equal(ent.analyzeBatch(db, batchId).readyToExport, true);
});

test('use_file_name updates the beneficiary name to the name in the file', () => {
  const { db, admin } = setup();
  const batchId = upload(db, admin, mainFile());
  const a = ent.analyzeBatch(db, batchId);
  ent.decideName(db, admin, batchId, byFile(a, '0042').id, 'use_file_name');
  const b = db.prepare(`SELECT full_name FROM beneficiaries WHERE file_no = '0042'`).get();
  assert.equal(b.full_name, 'سلمى خالد احمد');
  assert.equal(ent.analyzeBatch(db, batchId).totals.counts.name_mismatch, 0);
});

test('a card for an unregistered person must be 20 digits and unique', () => {
  const { db, admin } = setup();
  const batchId = upload(db, admin, mainFile());
  const row = byFile(ent.analyzeBatch(db, batchId), '0099');
  assert.throws(() => ent.addUnregistered(db, admin, batchId, row.id, { card_no: '123' }), /20/);
  assert.throws(() => ent.addUnregistered(db, admin, batchId, row.id, { card_no: CARD(1) }), /مسجل/);
});

test('an invalid row blocks completion; the amount cannot be fixed inside the app', () => {
  const { db, admin } = setup();
  const batchId = upload(db, admin, workbook([HEADER, ['0038', 'أحمد علي', 'غير رقم']]));
  const a = ent.analyzeBatch(db, batchId);
  assert.equal(a.rows[0].status, 'invalid');
  assert.equal(a.readyToExport, false);
  assert.throws(() => ent.completeBatch(db, admin, batchId), /خطأ في الملف/);
});

test('duplicates inside one file: flagged, completion and export refused until the user keeps both rows', () => {
  const { db, admin } = setup();
  const batchId = upload(db, admin, workbook([HEADER, ['0038', 'أحمد علي', 500], ['0038', 'أحمد علي', 600]]));
  let a = ent.analyzeBatch(db, batchId);
  assert.deepEqual(a.rows.map((r) => r.status), ['duplicate', 'duplicate']);
  assert.equal(a.duplicates.needsDecision, true);
  assert.throws(() => ent.completeBatch(db, admin, batchId), /تكرار/);
  ent.setDuplicateDecision(db, admin, batchId, 'keep_both');
  a = ent.analyzeBatch(db, batchId);
  assert.equal(a.duplicates.needsDecision, false);
  assert.equal(a.rows[0].status, 'ready');
  assert.ok(a.rows[0].notices[0].includes('مكرر'));
  ent.completeBatch(db, admin, batchId);
  assert.equal(ent.analyzeBatch(db, batchId).batch.isDraft, false);
});

test('the duplicate decision cannot change after completion', () => {
  const { db, admin } = setup();
  const batchId = upload(db, admin, workbook([HEADER, ['0038', 'أحمد علي', 500], ['0038', 'أحمد علي', 600]]));
  ent.setDuplicateDecision(db, admin, batchId, 'keep_both');
  ent.completeBatch(db, admin, batchId);
  assert.throws(() => ent.setDuplicateDecision(db, admin, batchId, 'keep_both'), /إكمال/);
});

test('completion needs every row resolved, then saves the imported file and shows as pending export', () => {
  const { db, admin } = setup();
  const batchId = upload(db, admin, mainFile());
  assert.throws(() => ent.completeBatch(db, admin, batchId), /إجراء/);
  resolveMainFile(db, admin, batchId);
  ent.completeBatch(db, admin, batchId);
  const row = db.prepare('SELECT is_draft, exported_at, file_data, status FROM import_batches WHERE id = ?').get(batchId);
  assert.equal(row.is_draft, 0);
  assert.equal(row.status, 'in_review');
  assert.equal(row.exported_at, null);
  assert.equal(row.file_data.length, mainFile().length);
  assert.throws(() => ent.completeBatch(db, admin, batchId), /مكتملة/);
});

test('cancelling a draft deletes everything: batch, rows and file, with no audit entry', () => {
  const { db, admin, reviewer } = setup();
  const auditBefore = db.prepare('SELECT COUNT(*) n FROM audit_log').get().n;
  const batchId = upload(db, admin, mainFile());
  ent.cancelBatch(db, reviewer, batchId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entitlement_rows WHERE batch_id = ?').get(batchId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM import_batches WHERE id = ?').get(batchId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_log').get().n, auditBefore);
  assert.equal(ent.getOpenBatch(db), null);
  upload(db, admin, mainFile(), 'new.xlsx');
});

test('cancelling a completed (not yet exported) batch also deletes it entirely', () => {
  const { db, admin } = setup();
  const batchId = upload(db, admin, mainFile());
  resolveMainFile(db, admin, batchId);
  ent.completeBatch(db, admin, batchId);
  ent.cancelBatch(db, admin, batchId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM import_batches WHERE id = ?').get(batchId).n, 0);
  assert.equal(ent.getOpenBatch(db), null);
});

test('cancelling keeps beneficiaries created during the batch, but unlinks them', () => {
  const { db, admin } = setup();
  const batchId = upload(db, admin, mainFile());
  const a = ent.analyzeBatch(db, batchId);
  ent.addUnregistered(db, admin, batchId, byFile(a, '0099').id, { card_no: CARD(99), phone: '' });
  ent.cancelBatch(db, admin, batchId);
  const b = db.prepare(`SELECT source_batch_id FROM beneficiaries WHERE file_no = '0099'`).get();
  assert.ok(b);
  assert.equal(b.source_batch_id, null);
});

test('export: one shipment per row dated today, batch closed with export time, and 3-column files', () => {
  const { db, admin } = setup();
  const batchId = upload(db, admin, workbook([HEADER, ['0038', 'أحمد علي', 500], ['0041', 'زهراء سعيد', 1200]]));
  ent.completeBatch(db, admin, batchId);
  const now = new Date(2026, 9, 20, 10, 30, 0);
  const out = ent.exportBatch(db, admin, batchId, { now });
  assert.equal(out.shippedAt, '2026-10-20 10:30:00');
  const ships = db.prepare('SELECT b.file_no, s.amount FROM shipments s JOIN beneficiaries b ON b.id = s.beneficiary_id ORDER BY b.file_no').all();
  assert.deepEqual(ships.map((s) => [s.file_no, s.amount]), [['0038', 500], ['0041', 1200]]);
  const row = db.prepare('SELECT status, exported_at FROM import_batches WHERE id = ?').get(batchId);
  assert.equal(row.status, 'closed', 'the first export closes the batch automatically');
  assert.equal(row.exported_at, '2026-10-20 10:30:00');
  assert.equal(ent.getOpenBatch(db), null);

  const supplier = readBack(buildSupplierFile(out.supplierRows));
  assert.deepEqual(supplier[0], ['رقم الملف', 'رقم البطاقة', 'الرصيد']);
  assert.equal(supplier.length, 3);
  const contacts = readBack(buildContactsFile(out.contactRows));
  assert.deepEqual(contacts[0], ['رقم الملف', 'رقم الجوال', 'الرصيد']);
  assert.equal(contacts[1][1], '0531111111');
  assert.ok(out.template.includes('أسواق المنتزه'));
});

test('export of a draft is refused: the batch must be completed first', () => {
  const { db, admin } = setup();
  const batchId = upload(db, admin, workbook([HEADER, ['0038', 'أحمد علي', 500]]));
  assert.throws(() => ent.exportBatch(db, admin, batchId), /إكمال/);
});

test('the duplicate notice is shown at export as information only', () => {
  const { db, admin } = setup();
  const batchId = upload(db, admin, workbook([HEADER, ['0038', 'أحمد علي', 500], ['0038', 'أحمد علي', 600]]));
  ent.setDuplicateDecision(db, admin, batchId, 'keep_both');
  ent.completeBatch(db, admin, batchId);
  const out = ent.exportBatch(db, admin, batchId, { now: new Date(2026, 9, 20) });
  assert.equal(out.notices.length, 1);
  assert.ok(out.notices[0].includes('0038'));
  assert.equal(ent.analyzeBatch(db, batchId).batch.exportedAt, '2026-10-20 00:00:00');
});

test('a batch cannot be cancelled after it was exported', () => {
  const { db, admin } = setup();
  const batchId = upload(db, admin, mainFile());
  resolveMainFile(db, admin, batchId);
  ent.completeBatch(db, admin, batchId);
  ent.exportBatch(db, admin, batchId, { now: new Date(2026, 9, 20, 9) });
  assert.throws(() => ent.cancelBatch(db, admin, batchId), /مغلقة/);
  const row = db.prepare('SELECT status, exported_at FROM import_batches WHERE id = ?').get(batchId);
  assert.equal(row.exported_at, '2026-10-20 09:00:00');
});

test('the first export closes the batch and stores both files; the stored file matches what was downloaded', () => {
  const { db, admin } = setup();
  const batchId = upload(db, admin, workbook([HEADER, ['0038', 'أحمد علي', 500]]));
  ent.completeBatch(db, admin, batchId);
  const out = ent.exportBatch(db, admin, batchId, {
    now: new Date(2026, 9, 20, 9),
    build: (o) => [
      { kind: 'supplier', name: 'ملف-المورد.xlsx', base64: buildSupplierFile(o.supplierRows) },
      { kind: 'contacts', name: 'ملف-التواصل.xlsx', base64: buildContactsFile(o.contactRows) },
    ],
  });
  assert.equal(out.files.length, 2);
  const listed = ent.listExportedFiles(db, batchId);
  assert.deepEqual(listed.map((f) => f.kind), ['supplier', 'contacts']);
  const stored = ent.getExportedFile(db, listed[0].id);
  assert.equal(Buffer.from(stored.content).toString('base64'), out.files[0].base64, 'the re-downloadable file is identical to the exported one');
  assert.equal(ent.getOpenBatch(db), null, 'the batch is closed, so a new file can be uploaded');
  assert.throws(() => ent.exportBatch(db, admin, batchId), /مغلقة/);
});

test('a closed batch cannot be changed, and no second shipment is recorded', () => {
  const { db, admin } = setup();
  const batchId = upload(db, admin, workbook([HEADER, ['0038', 'أحمد علي', 500]]));
  ent.completeBatch(db, admin, batchId);
  ent.exportBatch(db, admin, batchId);
  const rowId = db.prepare('SELECT id FROM entitlement_rows WHERE batch_id = ?').get(batchId).id;
  assert.throws(() => ent.addCardForRow(db, admin, batchId, rowId, CARD(40)), /مغلقة/);
  assert.throws(() => ent.decideName(db, admin, batchId, rowId, 'keep_db_name'), /مغلقة/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shipments').get().n, 1);
});
test('the shipment date drives the color: an export today is green', () => {
  const { shipmentStatus } = require('../server/services/status');
  assert.equal(shipmentStatus('2026-10-20 10:30:00', new Date(2026, 9, 20, 12)).color, 'green');
});



