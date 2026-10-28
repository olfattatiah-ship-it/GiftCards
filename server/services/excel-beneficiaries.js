// Reads the beneficiaries workbook (ارقام بطاقات الاهداء.xlsx) without changing it.
// Columns are matched by header text, not by position, so a re-ordered file still works.
const XLSX = require('xlsx');

const HEADERS = {
  seq: ['المعرف'],
  fileNo: ['id'],
  name: ['العائلة', 'الاسم'],
  card: ['رقم البطاقة'],
  phone: ['رقم االجوال', 'رقم الجوال'],
  balance: ['اخر رصيد شحن', 'آخر رصيد شحن'],
  lastShipment: ['تاريخ اخرعملية شحن', 'تاريخ آخر عملية شحن'],
};

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function findColumns(headerRow) {
  const cols = {};
  for (const [key, names] of Object.entries(HEADERS)) {
    const idx = headerRow.findIndex((h) => names.includes(norm(h)));
    if (idx !== -1) cols[key] = idx;
  }
  const missing = ['fileNo', 'name', 'phone'].filter((k) => cols[k] === undefined);
  if (missing.length) throw new Error(`أعمدة مطلوبة غير موجودة في الملف: ${missing.join(', ')}`);
  return cols;
}

// Returns { rows, warnings } where rows are normalized beneficiary records.
// Rows with no file number and no name at all are skipped with a warning.
function parseBeneficiaryWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellText: true, cellDates: false, raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false });
  if (grid.length < 2) throw new Error('الملف لا يحتوي على بيانات');

  const cols = findColumns(grid[0]);
  const rows = [];
  const warnings = [];

  grid.slice(1).forEach((r, i) => {
    const excelRow = i + 2; // رقم الصف في Excel
    const fileNo = norm(r[cols.fileNo]);
    const name = norm(r[cols.name]);
    if (!fileNo && !name) return;
    if (!fileNo) warnings.push({ row: excelRow, type: 'missing_file_no', message: 'لا يوجد رقم ملف' });
    if (!name) warnings.push({ row: excelRow, type: 'missing_name', message: 'لا يوجد اسم' });
    rows.push({
      excelRow,
      seq: norm(r[cols.seq]) || null,
      fileNo,
      name,
      phone: norm(r[cols.phone]) || null,
      card: cols.card === undefined ? null : (norm(r[cols.card]) || null),
      legacyBalance: cols.balance === undefined ? null : (norm(r[cols.balance]) || null),
    });
  });

  return { rows, warnings };
}

module.exports = { parseBeneficiaryWorkbook, findColumns };
