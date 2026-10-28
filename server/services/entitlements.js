// ملف الاستحقاقات الشهري: استيراد، مطابقة مع قاعدة المستفيدين، وتحقق، ثم تصدير.
// قواعد ثابتة:
//  - لا يُحذف أي صف ولا يُعدَّل مبلغه.
//  - الاسم يُحفظ كما ورد في الملف، والفرق مع الاسم الحالي يُعرض للمستخدم ليقرر لكل صف، ولا يُرفض الملف.
//  - التكرار داخل الملف يحتاج قرارًا: إعادة الرفع بعد حذف المكرر، أو تصدير الصفين معًا مع تنبيه.
//  - التصدير يتطلب أن يكون لكل مستفيد جوال، لأن ملف التواصل يحتاجه.
//  - التصدير مسموح عددًا غير محدود من المرات. أول تصدير يسجل عملية شحن لكل صف بتاريخ يوم التصدير.
//  - أول تصدير يُغلق العملية تلقائيًا، ويُحفظ ملفاه ليمكن تنزيلهما من سجل العمليات لاحقًا.
//  - لا يُرفع ملف جديد قبل إغلاق العملية المفتوحة (أي بعد أول تصدير أو بعد الإلغاء).
//  - الإلغاء يحذف عملية الاستيراد بالكامل دون سجل ودون سبب. لا يمكن إلغاء دفعة مصدّرة.
const { transaction } = require('../db');
const { record } = require('./audit');
const { requireRole, ROLES } = require('./auth');
const { phoneFlagFor } = require('./beneficiaries');

const CARD_NO = /^\d{20}$/;
const OPEN_STATUSES = ['imported', 'in_review'];

// توحيد الاسم للمقارنة فقط: الحركات والمسافات وأشكال الألف والياء والتاء المربوطة
function normalizeName(s) {
  return String(s ?? '')
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}

// تاريخ اليوم بالتوقيت المحلي بصيغة قاعدة البيانات
function localDateTime(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function getOpenBatch(db) {
  return db.prepare(`
    SELECT * FROM import_batches
    WHERE kind = 'entitlements' AND status IN ('imported','in_review')
    ORDER BY id DESC LIMIT 1`).get() || null;
}

function getBatchOrThrow(db, batchId) {
  const batch = db.prepare(`SELECT * FROM import_batches WHERE id = ? AND kind = 'entitlements'`).get(batchId);
  if (!batch) throw new Error('الدفعة غير موجودة');
  return batch;
}

function requireOpenBatch(db, batchId) {
  const batch = getBatchOrThrow(db, batchId);
  if (!OPEN_STATUSES.includes(batch.status)) throw new Error('هذه الدفعة مغلقة ولا يمكن تعديلها');
  return batch;
}

// إنشاء المسودة بعد رفع الملف مباشرة. المسودة تُحفظ مؤقتًا للمعالجة فقط،
// وتُحذف كاملة عند الإلغاء، ولا تظهر في سجل العمليات إلا بعد إكمالها.
function createBatch(db, actor, { rows, fileName, fileSha256, fileData }) {
  requireRole(actor, 'admin', 'importer');
  if (!rows || !rows.length) throw new Error('الملف لا يحتوي على استحقاقات');
  return transaction(db, () => {
    if (getOpenBatch(db)) {
      throw new Error('توجد عملية استحقاقات سابقة لم تُغلق. أكملي تصديرها أو ألغيها قبل رفع ملف جديد');
    }
    const info = db.prepare(`
      INSERT INTO import_batches (kind, file_name, file_sha256, row_count, imported_by, status, is_draft, file_data)
      VALUES ('entitlements', ?, ?, ?, ?, 'in_review', 1, ?)`).run(fileName, fileSha256, rows.length, actor.id, fileData);
    const batchId = Number(info.lastInsertRowid);
    const ins = db.prepare(`
      INSERT INTO entitlement_rows (batch_id, excel_row, file_no, name_in_file, amount, parse_error)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const r of rows) ins.run(batchId, r.excelRow, r.fileNo || null, r.name || null, r.amount, r.parseError);
    return batchId;
  });
}

// إكمال العملية: يُحفظ الملف المستورد مع العملية، وتصبح جاهزة للتصدير لاحقًا.
// لا يكتمل إلا إذا كانت المعالجة منتهية: لا صفوف خاطئة، ولا تكرار بلا قرار، ولا صف يحتاج إجراء.
function completeBatch(db, actor, batchId) {
  requireRole(actor, 'admin', 'importer');
  return transaction(db, () => {
    const batch = requireOpenBatch(db, batchId);
    if (!batch.is_draft) throw new Error('العملية مكتملة بالفعل');
    const analysis = analyzeBatch(db, batchId);
    const invalid = analysis.rows.filter((r) => r.status === 'invalid').length;
    if (invalid) throw new Error(`يوجد ${invalid} صف فيه خطأ في الملف. ألغي العملية وأصلحي الملف ثم ارفعيه من جديد`);
    if (analysis.duplicates.needsDecision) throw new Error('يوجد تكرار في الملف، ويلزم اختيار: تصدير الصفين معًا أو إعادة الرفع');
    if (analysis.totals.blocking > 0) throw new Error('توجد صفوف تحتاج إجراء في المعالجة قبل إكمال العملية');
    db.prepare('UPDATE import_batches SET is_draft = 0 WHERE id = ?').run(batchId);
    return { ok: true };
  });
}

// يحسب حالة كل صف من الحالة الحالية لقاعدة البيانات، فتتحدث تلقائيًا بعد أي إضافة أو قرار.
function analyzeBatch(db, batchId) {
  const batch = getBatchOrThrow(db, batchId);
  const rows = db.prepare('SELECT * FROM entitlement_rows WHERE batch_id = ? ORDER BY excel_row').all(batchId);

  const fileNoCount = new Map();
  for (const r of rows) if (r.file_no) fileNoCount.set(r.file_no, (fileNoCount.get(r.file_no) || 0) + 1);
  const keepBoth = batch.duplicate_decision === 'keep_both';

  const fileNos = [...new Set(rows.map((r) => r.file_no).filter(Boolean))];
  const benByFileNo = new Map();
  if (fileNos.length) {
    const placeholders = fileNos.map(() => '?').join(',');
    const found = db.prepare(`
      SELECT b.id, b.file_no, b.full_name, b.phone, b.phone_flag, c.card_no
      FROM beneficiaries b
      LEFT JOIN cards c ON c.beneficiary_id = b.id AND c.status = 'active'
      WHERE b.file_no IN (${placeholders})`).all(...fileNos);
    for (const b of found) benByFileNo.set(b.file_no, b);
  }

  const out = rows.map((r) => {
    const ben = r.file_no ? benByFileNo.get(r.file_no) : null;
    const isDuplicate = r.file_no && fileNoCount.get(r.file_no) > 1;
    let status = 'ready';
    const issues = [];
    const notices = [];
    if (r.parse_error) {
      status = 'invalid';
      issues.push(r.parse_error);
    } else if (isDuplicate && !keepBoth) {
      status = 'duplicate';
      issues.push('رقم الملف مكرر في الملف');
    } else if (!ben) {
      status = 'unregistered';
      issues.push('غير مسجل في قاعدة المستفيدين');
    } else if (normalizeName(ben.full_name) !== normalizeName(r.name_in_file) && !r.decision) {
      status = 'name_mismatch';
      issues.push('الاسم في الملف يختلف عن الاسم المسجل');
    } else if (!ben.card_no) {
      status = 'missing_card';
      issues.push('لا توجد بطاقة نشطة للمستفيد');
    } else if (!ben.phone) {
      notices.push('لا يوجد جوال مسجل. يلزم قبل تصدير ملف التواصل');
    }
    if (isDuplicate && keepBoth && status === 'ready') notices.push('رقم الملف مكرر في الملف، ويُصدر مع الصف الآخر');

    const warnings = [];
    if (ben && ben.phone_flag) warnings.push(ben.phone_flag === 'duplicate' ? 'جوال مكرر' : 'رقم غير سعودي');

    return {
      id: r.id,
      excelRow: r.excel_row,
      fileNo: r.file_no,
      nameInFile: r.name_in_file,
      amount: r.amount,
      status,
      issues,
      notices,
      warnings,
      decision: r.decision,
      blocking: status !== 'ready',
      beneficiary: ben ? {
        id: ben.id, file_no: ben.file_no, full_name: ben.full_name, phone: ben.phone, card_no: ben.card_no,
      } : null,
    };
  });

  const counts = { ready: 0, name_mismatch: 0, unregistered: 0, missing_card: 0, duplicate: 0, invalid: 0 };
  let totalAmount = 0;
  let readyAmount = 0;
  for (const r of out) {
    counts[r.status]++;
    if (r.amount !== null) totalAmount += r.amount;
    if (r.status === 'ready' && r.amount !== null) readyAmount += r.amount;
  }
  const blockingCount = out.filter((r) => r.blocking).length;
  const duplicateFileNos = [...fileNoCount].filter(([, n]) => n > 1).map(([k]) => k);
  const missingPhones = out.filter((r) => r.beneficiary && !r.beneficiary.phone).map((r) => ({
    excelRow: r.excelRow, fileNo: r.fileNo, name: r.beneficiary.full_name,
  }));

  return {
    batch: {
      id: batch.id,
      fileName: batch.file_name,
      status: batch.status,
      createdAt: batch.created_at,
      importedBy: batch.imported_by,
      duplicateDecision: batch.duplicate_decision,
      isDraft: !!batch.is_draft,
      exportedAt: batch.exported_at,
    },
    rows: out,
    duplicates: {
      fileNos: duplicateFileNos,
      needsDecision: duplicateFileNos.length > 0 && !keepBoth,
    },
    totals: {
      rows: out.length,
      amount: round2(totalAmount),
      readyAmount: round2(readyAmount),
      counts,
      blocking: blockingCount,
    },
    missingPhones,
    readyToExport: blockingCount === 0 && out.length > 0 && missingPhones.length === 0 && !(duplicateFileNos.length > 0 && !keepBoth),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function getRow(db, batchId, rowId) {
  const row = db.prepare('SELECT * FROM entitlement_rows WHERE id = ? AND batch_id = ?').get(rowId, batchId);
  if (!row) throw new Error('الصف غير موجود في هذه الدفعة');
  return row;
}

// قرار المكرر: "keep_both" يعني تصدير الصفين معًا مع تنبيه. الخيار الآخر هو إلغاء الملف وإعادة رفعه (يتم من الإلغاء).
function setDuplicateDecision(db, actor, batchId, choice) {
  requireRole(actor, ...ROLES);
  if (choice !== 'keep_both') throw new Error('القرار غير صالح');
  return transaction(db, () => {
    const batch = requireOpenBatch(db, batchId);
    if (!batch.is_draft) throw new Error('لا يمكن تغيير قرار التكرار بعد إكمال العملية');
    db.prepare('UPDATE import_batches SET duplicate_decision = ? WHERE id = ?').run(choice, batchId);
    return { ok: true };
  });
}

// يُضيف مستفيدًا جديدًا (غير مسجل) مع بطاقته. الاسم من الملف، والجوال اختياري عند الإضافة.
function addUnregistered(db, actor, batchId, rowId, { card_no, phone }) {
  requireRole(actor, ...ROLES);
  return transaction(db, () => {
    requireOpenBatch(db, batchId);
    const row = getRow(db, batchId, rowId);
    if (row.parse_error) throw new Error('لا يمكن إضافة صف يحتوي على خطأ في الملف');
    if (db.prepare('SELECT id FROM beneficiaries WHERE file_no = ?').get(row.file_no)) {
      throw new Error('رقم الملف مسجل بالفعل');
    }
    const card = String(card_no ?? '').trim();
    if (!CARD_NO.test(card)) throw new Error('رقم البطاقة يجب أن يتكون من 20 رقمًا');
    if (db.prepare('SELECT id FROM cards WHERE card_no = ?').get(card)) throw new Error('رقم البطاقة مسجل مسبقًا');

    const cleanPhone = String(phone ?? '').trim() || null;
    const dup = cleanPhone ? db.prepare('SELECT COUNT(*) AS n FROM beneficiaries WHERE phone = ?').get(cleanPhone).n > 0 : false;
    const flag = phoneFlagFor(cleanPhone, { duplicate: dup });

    const info = db.prepare(`
      INSERT INTO beneficiaries (file_no, full_name, phone, phone_flag, source_batch_id, updated_by)
      VALUES (?, ?, ?, ?, ?, ?)`).run(row.file_no, row.name_in_file, cleanPhone, flag, batchId, actor.id);
    const beneficiaryId = Number(info.lastInsertRowid);
    db.prepare(`INSERT INTO cards (beneficiary_id, card_no, status, created_by) VALUES (?, ?, 'active', ?)`)
      .run(beneficiaryId, card, actor.id);
    return { beneficiaryId };
  });
}

// يُضيف جوالًا لمستفيد مسجل لا يملك جوالًا (مطلوب قبل تصدير ملف التواصل).
function setPhoneForRow(db, actor, batchId, rowId, phone) {
  requireRole(actor, ...ROLES);
  const clean = String(phone ?? '').trim();
  if (!clean) throw new Error('رقم الجوال مطلوب');
  return transaction(db, () => {
    requireOpenBatch(db, batchId);
    const row = getRow(db, batchId, rowId);
    const ben = db.prepare('SELECT id, phone FROM beneficiaries WHERE file_no = ?').get(row.file_no);
    if (!ben) throw new Error('المستفيد غير مسجل بعد');
    if (ben.phone) throw new Error('لدى المستفيد جوال مسجل بالفعل');
    const dup = db.prepare('SELECT COUNT(*) AS n FROM beneficiaries WHERE phone = ? AND id <> ?').get(clean, ben.id).n > 0;
    db.prepare(`UPDATE beneficiaries SET phone = ?, phone_flag = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?`)
      .run(clean, phoneFlagFor(clean, { duplicate: dup }), actor.id, ben.id);
    return { ok: true };
  });
}

// يُضيف بطاقة لمستفيد مسجل لا يملك بطاقة نشطة.
function addCardForRow(db, actor, batchId, rowId, cardNo) {
  requireRole(actor, ...ROLES);
  return transaction(db, () => {
    requireOpenBatch(db, batchId);
    const row = getRow(db, batchId, rowId);
    const ben = db.prepare('SELECT id FROM beneficiaries WHERE file_no = ?').get(row.file_no);
    if (!ben) throw new Error('المستفيد غير مسجل بعد');
    const active = db.prepare(`SELECT id FROM cards WHERE beneficiary_id = ? AND status = 'active'`).get(ben.id);
    if (active) throw new Error('لدى المستفيد بطاقة نشطة بالفعل');
    const card = String(cardNo ?? '').trim();
    if (!CARD_NO.test(card)) throw new Error('رقم البطاقة يجب أن يتكون من 20 رقمًا');
    if (db.prepare('SELECT id FROM cards WHERE card_no = ?').get(card)) throw new Error('رقم البطاقة مسجل مسبقًا');
    db.prepare(`INSERT INTO cards (beneficiary_id, card_no, status, created_by) VALUES (?, ?, 'active', ?)`)
      .run(ben.id, card, actor.id);
    return { beneficiaryId: ben.id };
  });
}

// قرار الاسم لكل صف: إما الإبقاء على الاسم الحالي، أو تحديثه بالاسم الوارد في الملف.
function decideName(db, actor, batchId, rowId, choice) {
  requireRole(actor, ...ROLES);
  if (!['keep_db_name', 'use_file_name'].includes(choice)) throw new Error('القرار غير صالح');
  return transaction(db, () => {
    requireOpenBatch(db, batchId);
    const row = getRow(db, batchId, rowId);
    const ben = db.prepare('SELECT id FROM beneficiaries WHERE file_no = ?').get(row.file_no);
    if (!ben) throw new Error('المستفيد غير مسجل بعد');
    if (choice === 'use_file_name') {
      db.prepare(`UPDATE beneficiaries SET full_name = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?`)
        .run(row.name_in_file, actor.id, ben.id);
    }
    db.prepare('UPDATE entitlement_rows SET decision = ? WHERE id = ?').run(choice, rowId);
    return { ok: true };
  });
}

// التصدير: يسجل عملية شحن لكل صف بقيمة الملف وتاريخ اليوم، ويحفظ ملفي التصدير مع العملية،
// ثم يغلق العملية تلقائيًا. يمكن تنزيل الملفين لاحقًا من سجل العمليات.
// build(out) يُرجع ملفات التصدير [{ kind, name, base64 }] داخل نفس المعاملة، فإذا فشل البناء تتراجع العملية كلها.
function exportBatch(db, actor, batchId, { now = new Date(), build = null } = {}) {
  requireRole(actor, 'admin', 'importer', 'reviewer', 'cards_manager');
  return transaction(db, () => {
    const batch = requireOpenBatch(db, batchId);
    if (batch.is_draft) throw new Error('يجب إكمال العملية قبل التصدير');
    const analysis = analyzeBatch(db, batchId);
    if (analysis.duplicates.needsDecision) {
      throw Object.assign(new Error('يوجد تكرار في الملف، ويلزم اختيار: تصدير الصفين معًا أو إعادة الرفع'), { status: 400 });
    }
    if (analysis.totals.blocking > 0) {
      throw Object.assign(new Error('لا يمكن التصدير قبل معالجة جميع الصفوف التي تحتاج إجراء'), { status: 400 });
    }
    if (analysis.missingPhones.length) {
      throw Object.assign(new Error('يوجد مستفيدون بلا رقم جوال، ولا يمكن تصدير ملف التواصل قبل إضافة أرقامهم'), {
        status: 400,
        details: analysis.missingPhones.map((m) => `الصف ${m.excelRow} · ${m.fileNo} · ${m.name}`),
      });
    }

    const shippedAt = localDateTime(now);
    const insShip = db.prepare(`
      INSERT INTO shipments (beneficiary_id, card_id, amount, shipped_at, created_by)
      VALUES (?, (SELECT id FROM cards WHERE beneficiary_id = ? AND status = 'active'), ?, ?, ?)`);
    for (const r of analysis.rows) {
      insShip.run(r.beneficiary.id, r.beneficiary.id, r.amount, shippedAt, actor.id);
    }

    const supplierRows = analysis.rows.map((r) => ({ fileNo: r.beneficiary.file_no, card: r.beneficiary.card_no, amount: r.amount }));
    const contactRows = analysis.rows.map((r) => ({ fileNo: r.beneficiary.file_no, phone: r.beneficiary.phone, amount: r.amount }));
    const notices = analysis.duplicates.fileNos.length
      ? [`تم تصدير صفوف مكررة في الملف: ${analysis.duplicates.fileNos.join('، ')}`]
      : [];

    const out = { batchId, shippedAt, supplierRows, contactRows, notices, template: MESSAGE_TEMPLATE, total: analysis.totals.amount };
    out.files = build ? build(out) : [];

    // حفظ الملفين مع العملية، ثم إغلاقها تلقائيًا
    const insFile = db.prepare('INSERT INTO exported_files (batch_id, kind, file_name, content) VALUES (?, ?, ?, ?)');
    for (const f of out.files) insFile.run(batchId, f.kind, f.name, Buffer.from(f.base64, 'base64'));
    db.prepare(`UPDATE import_batches SET status = 'closed', exported_at = ? WHERE id = ?`).run(shippedAt, batchId);

    record(db, {
      userId: actor.id, action: 'export.entitlements', entity: 'import_batch', entityId: batchId,
      after: {
        fileName: batch.file_name, rows: analysis.rows.length, total: analysis.totals.amount,
        shippedAt, duplicates: analysis.duplicates.fileNos,
      },
    });
    return out;
  });
}

// ملفات التصدير المحفوظة لعملية ما (للتنزيل مرة أخرى)
function listExportedFiles(db, batchId) {
  return db.prepare('SELECT id, kind, file_name FROM exported_files WHERE batch_id = ? ORDER BY id').all(batchId);
}

function getExportedFile(db, fileId) {
  return db.prepare('SELECT id, file_name, content FROM exported_files WHERE id = ?').get(fileId) || null;
}
// قالب الرسالة العام (يُدار لاحقًا من الإعدادات)
const MESSAGE_TEMPLATE = 'عزيزي المستفيد/ة، تم شحن البطاقة الغذائية لأسواق المنتزه. يومًا سعيدًا، جمعية سيهات للخدمات الاجتماعية';

// الإلغاء يحذف العملية بالكامل (المسودة أو العملية المكتملة قبل التصدير) مع صفوفها وملفها.
// لا يُكتب له سجل ولا يُطلب له سبب. لا يمكن إلغاء عملية تم تصديرها (لأنها تغلق بالتصدير).
function cancelBatch(db, actor, batchId) {
  requireRole(actor, 'admin', 'importer', 'reviewer');
  return transaction(db, () => {
    const batch = requireOpenBatch(db, batchId);
    if (batch.exported_at) throw new Error('لا يمكن إلغاء عملية تم تصديرها');
    // المستفيدون الذين أُضيفوا أثناء هذه الدفعة يبقون كبيانات مستفيدين، لكن بلا ارتباط بالدفعة المحذوفة
    db.prepare('UPDATE beneficiaries SET source_batch_id = NULL WHERE source_batch_id = ?').run(batchId);
    db.prepare('DELETE FROM entitlement_rows WHERE batch_id = ?').run(batchId);
    db.prepare('DELETE FROM import_batches WHERE id = ?').run(batchId);
    return { ok: true };
  });
}

module.exports = {
  createBatch, getOpenBatch, analyzeBatch, addUnregistered, addCardForRow, decideName, cancelBatch, normalizeName,
  setDuplicateDecision, setPhoneForRow, exportBatch, completeBatch, listExportedFiles, getExportedFile, MESSAGE_TEMPLATE,
};


