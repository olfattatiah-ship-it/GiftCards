// Schema migrations. Each entry runs once, in order, tracked by PRAGMA user_version.
// Never edit an entry that has already shipped; add a new one instead.

const migrations = [
  {
    name: 'initial_schema',
    sql: `
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        full_name     TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('admin','importer','reviewer','cards_manager')),
        is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      );

      CREATE TABLE import_batches (
        id            INTEGER PRIMARY KEY,
        kind          TEXT NOT NULL CHECK (kind IN ('beneficiaries','entitlements')),
        file_name     TEXT NOT NULL,
        file_sha256   TEXT NOT NULL,
        row_count     INTEGER NOT NULL,
        imported_by   INTEGER NOT NULL REFERENCES users(id),
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        status        TEXT NOT NULL DEFAULT 'imported'
                      CHECK (status IN ('imported','in_review','exported','closed','cancelled'))
      );

      CREATE TABLE beneficiaries (
        id              INTEGER PRIMARY KEY,
        file_no         TEXT NOT NULL UNIQUE,            -- رقم الملف (عمود id في الملف الأصلي)
        sequence_no     INTEGER UNIQUE,                  -- التسلسل الداخلي (قابل لإعادة الترقيم)
        full_name       TEXT NOT NULL,
        phone           TEXT,
        phone_flag      TEXT CHECK (phone_flag IN ('duplicate','international') OR phone_flag IS NULL),
        legacy_balance  TEXT,                            -- آخر رصيد من الملف الأصلي (للعرض فقط)
        source_batch_id INTEGER REFERENCES import_batches(id),
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_by      INTEGER REFERENCES users(id)
      );

      CREATE INDEX idx_beneficiaries_phone ON beneficiaries(phone);

      CREATE TABLE cards (
        id              INTEGER PRIMARY KEY,
        beneficiary_id  INTEGER NOT NULL REFERENCES beneficiaries(id),
        card_no         TEXT NOT NULL UNIQUE,
        status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
        issued_at       TEXT NOT NULL DEFAULT (datetime('now')),
        created_by      INTEGER REFERENCES users(id)
      );

      -- بطاقة نشطة واحدة كحد أقصى لكل مستفيد
      CREATE UNIQUE INDEX idx_one_active_card ON cards(beneficiary_id) WHERE status = 'active';

      CREATE TABLE audit_log (
        id          INTEGER PRIMARY KEY,
        at          TEXT NOT NULL DEFAULT (datetime('now')),
        user_id     INTEGER REFERENCES users(id),
        action      TEXT NOT NULL,
        entity      TEXT NOT NULL,
        entity_id   TEXT NOT NULL,
        before_json TEXT,
        after_json  TEXT,
        reason      TEXT
      );

      -- سجل التدقيق غير قابل للتعديل أو الحذف على مستوى قاعدة البيانات
      CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

      CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    `,
  },
  {
    name: 'shipments',
    sql: `
      -- عمليات الشحن. تُضاف فعليًا في المرحلة الخامسة، والجدول موجود لحساب ألوان الحالة.
      CREATE TABLE shipments (
        id             INTEGER PRIMARY KEY,
        beneficiary_id INTEGER NOT NULL REFERENCES beneficiaries(id),
        card_id        INTEGER REFERENCES cards(id),
        amount         REAL NOT NULL CHECK (amount >= 0),
        shipped_at     TEXT NOT NULL,
        created_by     INTEGER REFERENCES users(id),
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_shipments_beneficiary ON shipments(beneficiary_id, shipped_at);
    `,
  },
  {
    name: 'entitlement_rows',
    sql: `
      -- صفوف ملف الاستحقاقات كما رُفعت. لا تُحذف ولا يُعدَّل مبلغها.
      -- القرار الوحيد الذي يُسجَّل على الصف هو اعتماد الاسم الحالي أو تحديثه.
      CREATE TABLE entitlement_rows (
        id           INTEGER PRIMARY KEY,
        batch_id     INTEGER NOT NULL REFERENCES import_batches(id),
        excel_row    INTEGER NOT NULL,
        file_no      TEXT,
        name_in_file TEXT,
        amount       REAL,
        parse_error  TEXT,
        decision     TEXT CHECK (decision IN ('keep_db_name','use_file_name') OR decision IS NULL)
      );

      CREATE INDEX idx_entitlement_rows_batch ON entitlement_rows(batch_id);

      -- دفعة واحدة مفتوحة كحد أقصى في كل وقت
      CREATE UNIQUE INDEX idx_one_open_batch ON import_batches(kind)
        WHERE kind = 'entitlements' AND status IN ('imported','in_review');
    `,
  },
  {
    name: 'duplicate_decision',
    sql: `
      -- قرار المستخدم في حالة تكرار رقم الملف داخل الملف: تصدير الصفين معًا، أو إعادة الرفع بعد الحذف
      ALTER TABLE import_batches ADD COLUMN duplicate_decision TEXT
        CHECK (duplicate_decision IN ('keep_both') OR duplicate_decision IS NULL);
    `,
  },
  {
    name: 'batch_export_time',
    sql: `
      -- تاريخ التصدير لسجل الاستيراد. يُملأ عند التصدير فقط.
      ALTER TABLE import_batches ADD COLUMN exported_at TEXT;
    `,
  },
  {
    name: 'batch_draft_and_file',
    sql: `
      -- المسودة: عملية استيراد قيد المعالجة ولم تُكمَل بعد. تُحذف كاملة عند الإلغاء.
      -- الملف المستورد يُحفظ مع العملية عند إكمالها.
      ALTER TABLE import_batches ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 0 CHECK (is_draft IN (0,1));
      ALTER TABLE import_batches ADD COLUMN file_data BLOB;
    `,
  },
  {
    name: 'exported_files',
    sql: `
      -- ملفات التصدير الأصلية تُحفظ مع العملية، لإعادة تنزيلها عند فقدان النسخة الأولى
      CREATE TABLE exported_files (
        id          INTEGER PRIMARY KEY,
        batch_id    INTEGER NOT NULL REFERENCES import_batches(id),
        kind        TEXT NOT NULL CHECK (kind IN ('supplier','contacts')),
        file_name   TEXT NOT NULL,
        content     BLOB NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_exported_files_batch ON exported_files(batch_id);
    `,
  },
];

module.exports = { migrations };
