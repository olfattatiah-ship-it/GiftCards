// Append-only audit trail for import and export operations.
// The database triggers (see db/migrations.js) block UPDATE and DELETE,
// and this module only exposes inserts and reads.
// Edits to beneficiary data are not audited, by request.

function record(db, { userId = null, action, entity, entityId, before = null, after = null, reason = null }) {
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity, entity_id, before_json, after_json, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    userId,
    action,
    entity,
    String(entityId),
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    reason
  );
}

function listForEntity(db, entity, entityId) {
  return db.prepare(`
    SELECT a.*, u.username FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.entity = ? AND a.entity_id = ?
    ORDER BY a.id`).all(entity, String(entityId));
}

// سجل التدقيق للعمليات: الاستيراد الأولي للمستفيدين، والتصدير.
// استيراد الاستحقاقات يُعرض من سجلات الدفعات نفسها (import_batches) لأنه يُحذف عند الإلغاء.
function listOperations(db, { limit = 200 } = {}) {
  return db.prepare(`
    SELECT a.id, a.at, a.action, a.entity_id, a.after_json, u.full_name AS user_name
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.action = 'import.beneficiaries' OR a.action LIKE 'export.%'
    ORDER BY a.id DESC
    LIMIT ?`).all(limit);
}

module.exports = { record, listForEntity, listOperations };
