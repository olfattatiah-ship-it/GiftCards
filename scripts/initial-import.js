// One-time load of the beneficiaries workbook into the database.
// Usage: node scripts/initial-import.js "<path to xlsx>"
// Requires ADMIN_USERNAME and ADMIN_PASSWORD on the first run (creates the first admin).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDatabase, DEFAULT_DB_PATH } = require('../server/db');
const { createUser } = require('../server/services/auth');
const { parseBeneficiaryWorkbook } = require('../server/services/excel-beneficiaries');
const { importBeneficiaries } = require('../server/services/beneficiaries');

function main() {
  const file = process.argv[2];
  if (!file) throw new Error('حدد مسار ملف Excel');
  const buffer = fs.readFileSync(file);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
  const db = openDatabase(dbPath);
  let admin = db.prepare(`SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`).get();
  if (!admin) {
    if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
      throw new Error('لا يوجد مدير بعد. عيّن ADMIN_USERNAME و ADMIN_PASSWORD ثم أعد التشغيل');
    }
    admin = createUser(db, null, {
      username: process.env.ADMIN_USERNAME,
      fullName: process.env.ADMIN_FULL_NAME || 'مدير النظام',
      password: process.env.ADMIN_PASSWORD,
      role: 'admin',
    });
    console.log(`تم إنشاء حساب المدير: ${admin.username}`);
  }

  const { rows, warnings } = parseBeneficiaryWorkbook(buffer);
  const report = importBeneficiaries(db, admin, { rows, fileName: path.basename(file), fileSha256: sha256 });

  console.log(`تم استيراد ${report.imported} مستفيدًا (دفعة رقم ${report.batchId})`);
  console.log(`بدون بطاقة: ${report.withoutCard.length}`);
  console.log(`جوال مكرر: ${report.duplicatePhones.length}`);
  console.log(`رقم دولي: ${report.internationalPhones.length}`);
  console.log(`تحذيرات الصفوف: ${warnings.length}`);
  const reportPath = path.join(path.dirname(dbPath), 'import-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ ...report, warnings }, null, 2), 'utf8');
  console.log(`التقرير الكامل: ${reportPath}`);
  db.close();
  return { report, warnings };
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    if (err.details) for (const d of err.details) console.error(' -', d);
    process.exit(1);
  }
}

module.exports = { main };
