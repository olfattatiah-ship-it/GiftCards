const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const auth = require('./services/auth');
const ben = require('./services/beneficiaries');
const ent = require('./services/entitlements');
const { parseEntitlementWorkbook } = require('./services/excel-entitlements');
const { buildSupplierFile, buildContactsFile } = require('./services/export-files');
const { shipmentStatus } = require('./services/status');

const WEB_DIR = path.join(__dirname, '..', 'web');
const SESSION_COOKIE = 'sid';
const PAGE_SIZE = 50;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

// Normalizes common Arabic letter variants so "احمد" matches "أحمد" in search.
const normAr = (s) => String(s ?? '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').trim();
const normSql = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${col},'أ','ا'),'إ','ا'),'آ','ا'),'ى','ي'),'ة','ه')`;

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Joins beneficiaries with their active card and last shipment, and computes the status color.
function loadBeneficiaryRows(db, q) {
  const where = [];
  const params = [];
  if (q) {
    const like = `%${q}%`;
    where.push(`(${normSql('b.full_name')} LIKE ? OR b.file_no LIKE ? OR b.phone LIKE ? OR c.card_no LIKE ?)`);
    params.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT b.id, b.file_no, b.sequence_no, b.full_name, b.phone, b.phone_flag,
           c.card_no,
           (SELECT MAX(s.shipped_at) FROM shipments s WHERE s.beneficiary_id = b.id) AS last_shipped_at,
           (SELECT s.amount FROM shipments s WHERE s.beneficiary_id = b.id ORDER BY s.shipped_at DESC, s.id DESC LIMIT 1) AS last_amount,
           b.legacy_balance
    FROM beneficiaries b
    LEFT JOIN cards c ON c.beneficiary_id = b.id AND c.status = 'active'
    ${whereSql}
    ORDER BY b.id`).all(...params);
  // آخر رصيد شحن: من آخر عملية شحن إن وُجدت، وإلا من الملف الأصلي
  return rows.map((r) => ({
    ...r,
    last_balance: r.last_amount ?? r.legacy_balance ?? null,
    status: shipmentStatus(r.last_shipped_at),
  }));
}

function createApp(db, { secureCookies = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // ملف الاستحقاقات يُرسل بالكامل كنص Base64، لذلك نسمح بحجم أكبر من بقية الطلبات.
  app.use(express.json({ limit: '8mb' }));
  app.use(express.static(WEB_DIR, { index: 'index.html' }));

  const failures = new Map(); // username (lowercase) -> { count, lockedUntil }

  function requireUser(req, res, next) {
    const token = readCookie(req, SESSION_COOKIE);
    const user = auth.currentUser(db, token);
    if (!user) return res.status(401).json({ error: 'يجب تسجيل الدخول أولًا' });
    req.user = user;
    req.token = token;
    next();
  }

  app.post('/api/login', (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    const key = username.toLowerCase();
    const state = failures.get(key);
    if (state && state.lockedUntil > Date.now()) {
      return res.status(429).json({ error: `تم إيقاف المحاولات مؤقتًا. حاول بعد ${LOCK_MINUTES} دقيقة` });
    }
    const token = username && password ? auth.login(db, username, password) : null;
    if (!token) {
      const count = (state?.count || 0) + 1;
      failures.set(key, {
        count,
        lockedUntil: count >= MAX_FAILED_LOGINS ? Date.now() + LOCK_MINUTES * 60000 : 0,
      });
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
    failures.delete(key);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'strict', secure: secureCookies, path: '/', maxAge: 8 * 3600 * 1000,
    });
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    auth.logout(db, readCookie(req, SESSION_COOKIE));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/me', requireUser, (req, res) => res.json({ user: req.user }));

  app.post('/api/me/password', requireUser, (req, res, next) => {
    try {
      auth.changePassword(db, req.user, req.body?.current_password, req.body?.new_password, req.token);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.get('/api/summary', requireUser, (req, res) => {
    const rows = loadBeneficiaryRows(db, '');
    const count = { total: rows.length, withoutCard: 0, flagged: 0, activeCards: 0, green: 0, orange: 0, red: 0 };
    for (const r of rows) {
      if (r.card_no) count.activeCards++; else count.withoutCard++;
      if (r.phone_flag) count.flagged++;
      count[r.status.color]++;
    }
    res.json(count);
  });

  app.get('/api/beneficiaries', requireUser, (req, res) => {
    const q = normAr(req.query.q);
    const filter = String(req.query.filter || 'all');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    let rows = loadBeneficiaryRows(db, q);
    if (filter === 'no_card') rows = rows.filter((r) => !r.card_no);
    else if (filter === 'has_card') rows = rows.filter((r) => r.card_no);
    else if (filter === 'flagged') rows = rows.filter((r) => r.phone_flag);
    else if (['green', 'orange', 'red'].includes(filter)) rows = rows.filter((r) => r.status.color === filter);

    const items = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    res.json({ total: rows.length, page, pageSize: PAGE_SIZE, items });
  });

  app.get('/api/beneficiaries/:id', requireUser, (req, res) => {
    const id = Number(req.params.id);
    const row = loadBeneficiaryRows(db, '').find((r) => r.id === id);
    if (!row) return res.status(404).json({ error: 'المستفيد غير موجود' });
    const cards = db.prepare('SELECT id, card_no, status, issued_at FROM cards WHERE beneficiary_id = ? ORDER BY id').all(id);
    res.json({ beneficiary: row, cards });
  });

  app.patch('/api/beneficiaries/:id', requireUser, (req, res, next) => {
    try {
      const { full_name, phone, card_no } = req.body || {};
      ben.updateBeneficiary(db, req.user, Number(req.params.id), { full_name, phone, card_no });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.post('/api/beneficiaries/:id/confirm-phone', requireUser, (req, res, next) => {
    try {
      ben.confirmPhone(db, req.user, Number(req.params.id));
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.post('/api/beneficiaries/:id/cards', requireUser, (req, res, next) => {
    try {
      const card = ben.addCard(db, req.user, Number(req.params.id), req.body?.card_no);
      res.status(201).json({ card });
    } catch (err) { next(err); }
  });

  // ---------- ملف الاستحقاقات ----------
  const wrap = (fn) => (req, res, next) => {
    try { fn(req, res); } catch (err) { next(err); }
  };

  app.get('/api/entitlements/open', requireUser, wrap((req, res) => {
    const open = ent.getOpenBatch(db);
    res.json(open ? ent.analyzeBatch(db, open.id) : { batch: null });
  }));

  app.post('/api/entitlements', requireUser, wrap((req, res) => {
    const name = String(req.body?.file_name ?? 'entitlements.xlsx').slice(0, 200);
    const b64 = String(req.body?.file_base64 ?? '');
    if (!b64) throw Object.assign(new Error('لم يتم إرفاق ملف'), { status: 400 });
    const buffer = Buffer.from(b64, 'base64');
    if (!buffer.length) throw Object.assign(new Error('الملف فارغ'), { status: 400 });
    const { rows } = parseEntitlementWorkbook(buffer);
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const batchId = ent.createBatch(db, req.user, { rows, fileName: name, fileSha256: sha, fileData: buffer });
    res.status(201).json(ent.analyzeBatch(db, batchId));
  }));

  app.post('/api/entitlements/:id/complete', requireUser, wrap((req, res) => {
    ent.completeBatch(db, req.user, Number(req.params.id));
    res.json(ent.analyzeBatch(db, Number(req.params.id)));
  }));

  app.get('/api/entitlements/:id', requireUser, wrap((req, res) => {
    res.json(ent.analyzeBatch(db, Number(req.params.id)));
  }));

  app.post('/api/entitlements/:id/rows/:rowId/beneficiary', requireUser, wrap((req, res) => {
    ent.addUnregistered(db, req.user, Number(req.params.id), Number(req.params.rowId), req.body || {});
    res.status(201).json(ent.analyzeBatch(db, Number(req.params.id)));
  }));

  app.post('/api/entitlements/:id/rows/:rowId/card', requireUser, wrap((req, res) => {
    ent.addCardForRow(db, req.user, Number(req.params.id), Number(req.params.rowId), req.body?.card_no);
    res.status(201).json(ent.analyzeBatch(db, Number(req.params.id)));
  }));

  app.post('/api/entitlements/:id/rows/:rowId/name', requireUser, wrap((req, res) => {
    ent.decideName(db, req.user, Number(req.params.id), Number(req.params.rowId), req.body?.choice);
    res.json(ent.analyzeBatch(db, Number(req.params.id)));
  }));

  app.post('/api/entitlements/:id/rows/:rowId/phone', requireUser, wrap((req, res) => {
    ent.setPhoneForRow(db, req.user, Number(req.params.id), Number(req.params.rowId), req.body?.phone);
    res.json(ent.analyzeBatch(db, Number(req.params.id)));
  }));

  app.post('/api/entitlements/:id/duplicates', requireUser, wrap((req, res) => {
    ent.setDuplicateDecision(db, req.user, Number(req.params.id), req.body?.choice);
    res.json(ent.analyzeBatch(db, Number(req.params.id)));
  }));

  app.post('/api/entitlements/:id/export', requireUser, wrap((req, res) => {
    const build = (o) => {
      const stamp = o.shippedAt.slice(0, 10);
      return [
        { kind: 'supplier', name: `ملف-المورد-${stamp}.xlsx`, base64: buildSupplierFile(o.supplierRows) },
        { kind: 'contacts', name: `ملف-التواصل-${stamp}.xlsx`, base64: buildContactsFile(o.contactRows) },
      ];
    };
    // التصدير الأول يُغلق العملية تلقائيًا، وتُحفظ ملفاته ليمكن تنزيلها لاحقًا
    const out = ent.exportBatch(db, req.user, Number(req.params.id), { build });
    res.json({
      shippedAt: out.shippedAt,
      notices: out.notices,
      template: out.template,
      total: out.total,
      files: out.files.map((f) => ({ name: f.name, base64: f.base64 })),
    });
  }));

  app.post('/api/entitlements/:id/cancel', requireUser, wrap((req, res) => {
    ent.cancelBatch(db, req.user, Number(req.params.id));
    res.json({ ok: true });
  }));

  // تنزيل ملف تصدير محفوظ (في حالة فقدان النسخة الأولى). نفس صلاحية سجل العمليات، لأن الملفات تحتوي أرقام بطاقات وجوالات
  app.get('/api/exported-files/:fileId', requireUser, wrap((req, res) => {
    auth.requireRole(req.user, 'admin', 'reviewer');
    const f = ent.getExportedFile(db, Number(req.params.fileId));
    if (!f) throw Object.assign(new Error('الملف غير موجود'), { status: 404 });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.file_name)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(f.content);
  }));

  app.get('/api/operations', requireUser, (req, res, next) => {
    try {
      auth.requireRole(req.user, 'admin', 'reviewer');
      // كل عملية استيراد (المستفيدون والاستحقاقات) تُعرض من سجل دفعتها، مع حالة التصدير وملفاته المحفوظة.
      const items = db.prepare(`
        SELECT ib.id, ib.kind, ib.file_name, ib.row_count, ib.created_at, ib.status, ib.exported_at, u.full_name AS user_name
        FROM import_batches ib LEFT JOIN users u ON u.id = ib.imported_by
        WHERE ib.is_draft = 0
        ORDER BY ib.id DESC`).all().map((b) => ({
        id: b.id,
        at: b.created_at,
        kind: b.kind === 'entitlements' ? 'entitlements.import' : 'beneficiaries.import',
        user_name: b.user_name,
        fileName: b.file_name,
        rows: b.row_count,
        status: b.exported_at ? 'exported' : (b.status === 'in_review' ? 'pending_export' : b.status),
        exportedAt: b.exported_at,
        files: b.kind === 'entitlements' ? ent.listExportedFiles(db, b.id) : [],
      }));
      res.json({ items });
    } catch (err) { next(err); }
  });


  // Error handler: our own validation messages are safe to show; anything else is hidden.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.status) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err instanceof SyntaxError && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'البيانات المرسلة غير صالحة' });
    }
    if (err.message && !/SQLITE|sqlite|constraint|ENOENT|TypeError|ReferenceError/i.test(err.message)) {
      return res.status(400).json({ error: err.message, details: err.details });
    }
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ غير متوقع' });
  });

  return app;
}

module.exports = { createApp };
