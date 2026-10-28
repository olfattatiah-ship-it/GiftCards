const { transaction } = require('../db');
const { record } = require('./audit');
const { requireRole, ROLES } = require('./auth');

const SAUDI_MOBILE = /^05\d{8}$/;
const CARD_NO = /^\d{20}$/;

function phoneFlagFor(phone, { duplicate }) {
  if (!phone) return null;
  if (duplicate) return 'duplicate';
  if (!SAUDI_MOBILE.test(phone)) return 'international';
  return null;
}

// Phones shared by more than one beneficiary are flagged; the user confirms or edits them.
function countPhone(db, phone, excludeId = -1) {
  return db.prepare('SELECT COUNT(*) AS n FROM beneficiaries WHERE phone = ? AND id <> ?').get(phone, excludeId).n;
}

function getBeneficiary(db, id) {
  return db.prepare('SELECT * FROM beneficiaries WHERE id = ?').get(id);
}

function activeCard(db, beneficiaryId) {
  return db.prepare(`SELECT * FROM cards WHERE beneficiary_id = ? AND status = 'active'`).get(beneficiaryId) || null;
}

// Initial load from a parsed workbook. Either everything is imported or nothing is.
// Problems that block the import: duplicate file numbers, duplicate card numbers, or
// file numbers / card numbers already in the database. Missing cards and phone issues
// are not blocking; they are returned as a report and flagged for the user.
function importBeneficiaries(db, actor, { rows, fileName, fileSha256 }) {
  requireRole(actor, ...ROLES);

  const fileNos = new Map();
  const cards = new Map();
  const errors = [];
  for (const r of rows) {
    if (fileNos.has(r.fileNo)) errors.push(`رقم الملف ${r.fileNo} مكرر في الصفوف ${fileNos.get(r.fileNo)} و${r.excelRow}`);
    else fileNos.set(r.fileNo, r.excelRow);
    if (r.card) {
      if (!CARD_NO.test(r.card)) errors.push(`رقم بطاقة غير صالح في الصف ${r.excelRow}: ${r.card}`);
      if (cards.has(r.card)) errors.push(`رقم البطاقة ${r.card} مكرر في الصفوف ${cards.get(r.card)} و${r.excelRow}`);
      else cards.set(r.card, r.excelRow);
    }
  }
  if (errors.length) throw Object.assign(new Error('الملف يحتوي على أخطاء تمنع الاستيراد'), { details: errors });

  const phoneCounts = new Map();
  for (const r of rows) if (r.phone) phoneCounts.set(r.phone, (phoneCounts.get(r.phone) || 0) + 1);

  return transaction(db, () => {
    const existing = db.prepare('SELECT COUNT(*) AS n FROM beneficiaries').get().n;
    if (existing > 0) throw new Error('الاستيراد الأولي متاح فقط عند خلوّ قاعدة البيانات من المستفيدين');

    const batch = db.prepare(`
      INSERT INTO import_batches (kind, file_name, file_sha256, row_count, imported_by)
      VALUES ('beneficiaries', ?, ?, ?, ?)`).run(fileName, fileSha256, rows.length, actor.id);
    const batchId = Number(batch.lastInsertRowid);

    const insB = db.prepare(`
      INSERT INTO beneficiaries (file_no, sequence_no, full_name, phone, phone_flag, legacy_balance, source_batch_id, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insC = db.prepare(`
      INSERT INTO cards (beneficiary_id, card_no, status, created_by) VALUES (?, ?, 'active', ?)`);

    const report = { imported: 0, withoutCard: [], duplicatePhones: [], internationalPhones: [] };

    for (const r of rows) {
      const seq = /^\d+$/.test(r.seq || '') ? Number(r.seq) : null;
      const flag = phoneFlagFor(r.phone, { duplicate: (phoneCounts.get(r.phone) || 0) > 1 });
      const info = insB.run(r.fileNo, seq, r.name, r.phone, flag, r.legacyBalance, batchId, actor.id);
      const beneficiaryId = Number(info.lastInsertRowid);
      report.imported++;

      if (r.card) insC.run(beneficiaryId, r.card, actor.id);
      else report.withoutCard.push({ row: r.excelRow, fileNo: r.fileNo, name: r.name });

      if (flag === 'duplicate') report.duplicatePhones.push({ row: r.excelRow, fileNo: r.fileNo, name: r.name, phone: r.phone });
      if (flag === 'international') report.internationalPhones.push({ row: r.excelRow, fileNo: r.fileNo, name: r.name, phone: r.phone });
    }

    record(db, {
      userId: actor.id,
      action: 'import.beneficiaries',
      entity: 'import_batch',
      entityId: batchId,
      after: { fileName, fileSha256, rows: rows.length, withoutCard: report.withoutCard.length },
    });
    return { batchId, ...report };
  });
}

// Edits name, phone and/or the active card number. No reason and no audit entry, by request.
// Only the current values are kept.
function updateBeneficiary(db, actor, id, changes) {
  requireRole(actor, ...ROLES);
  const keys = Object.keys(changes || {}).filter((k) => ['full_name', 'phone', 'card_no'].includes(k) && changes[k] !== undefined);
  if (!keys.length) throw new Error('لا توجد بيانات للتعديل');

  return transaction(db, () => {
    const before = getBeneficiary(db, id);
    if (!before) throw new Error('المستفيد غير موجود');

    const fullName = changes.full_name !== undefined ? String(changes.full_name ?? '').trim() : before.full_name;
    if (!fullName) throw new Error('الاسم مطلوب');
    const phone = changes.phone !== undefined ? (String(changes.phone ?? '').trim() || null) : before.phone;
    const flag = phoneFlagFor(phone, { duplicate: phone !== null && countPhone(db, phone, id) > 0 });

    db.prepare(`
      UPDATE beneficiaries SET full_name = ?, phone = ?, phone_flag = ?, updated_at = datetime('now'), updated_by = ?
      WHERE id = ?`).run(fullName, phone, flag, actor.id, id);

    if (changes.card_no !== undefined) {
      const newCard = String(changes.card_no ?? '').trim();
      const current = activeCard(db, id);
      if (!newCard) {
        if (current) throw new Error('لا يمكن إزالة البطاقة النشطة من هنا');
      } else if (!current || current.card_no !== newCard) {
        if (!CARD_NO.test(newCard)) throw new Error('رقم البطاقة يجب أن يتكون من 20 رقمًا');
        const used = db.prepare('SELECT beneficiary_id FROM cards WHERE card_no = ? AND id <> ?').get(newCard, current ? current.id : -1);
        if (used) throw new Error('رقم البطاقة مسجل مسبقًا');
        if (current) db.prepare('UPDATE cards SET card_no = ? WHERE id = ?').run(newCard, current.id);
        else db.prepare(`INSERT INTO cards (beneficiary_id, card_no, status, created_by) VALUES (?, ?, 'active', ?)`).run(id, newCard, actor.id);
      }
    }
    return getBeneficiary(db, id);
  });
}

// The user confirms a flagged phone as correct. The flag is cleared. No audit entry.
function confirmPhone(db, actor, id) {
  requireRole(actor, ...ROLES);
  const before = getBeneficiary(db, id);
  if (!before) throw new Error('المستفيد غير موجود');
  if (before.phone_flag) {
    db.prepare(`UPDATE beneficiaries SET phone_flag = NULL, updated_at = datetime('now'), updated_by = ? WHERE id = ?`)
      .run(actor.id, id);
  }
  return getBeneficiary(db, id);
}

// Adds a card to a beneficiary who has no active card. Card numbers are unique across the system.
function addCard(db, actor, beneficiaryId, cardNo) {
  requireRole(actor, ...ROLES);
  const card = String(cardNo ?? '').trim();
  if (!CARD_NO.test(card)) throw new Error('رقم البطاقة يجب أن يتكون من 20 رقمًا');
  return transaction(db, () => {
    if (!getBeneficiary(db, beneficiaryId)) throw new Error('المستفيد غير موجود');
    if (activeCard(db, beneficiaryId)) throw new Error('لدى المستفيد بطاقة نشطة بالفعل');
    if (db.prepare('SELECT id FROM cards WHERE card_no = ?').get(card)) throw new Error('رقم البطاقة مسجل مسبقًا');
    const info = db.prepare(`INSERT INTO cards (beneficiary_id, card_no, status, created_by) VALUES (?, ?, 'active', ?)`)
      .run(beneficiaryId, card, actor.id);
    return { id: Number(info.lastInsertRowid), beneficiary_id: beneficiaryId, card_no: card, status: 'active' };
  });
}

// Last shipment date and the balance from the original file (shown on the profile).
function lastShipmentAt(db, beneficiaryId) {
  const row = db.prepare('SELECT MAX(shipped_at) AS last FROM shipments WHERE beneficiary_id = ?').get(beneficiaryId);
  return row ? row.last : null;
}

function findMissingCards(db) {
  return db.prepare(`
    SELECT b.id, b.file_no, b.full_name, b.phone FROM beneficiaries b
    WHERE NOT EXISTS (SELECT 1 FROM cards c WHERE c.beneficiary_id = b.id AND c.status = 'active')
    ORDER BY b.id`).all();
}

function findFlagged(db) {
  return db.prepare(`
    SELECT id, file_no, full_name, phone, phone_flag FROM beneficiaries
    WHERE phone_flag IS NOT NULL ORDER BY id`).all();
}

module.exports = {
  importBeneficiaries, updateBeneficiary, confirmPhone, addCard,
  findMissingCards, findFlagged, phoneFlagFor, lastShipmentAt, activeCard, getBeneficiary,
};
