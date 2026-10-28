// Reads a monthly entitlements workbook without changing it.
// Only three fields are read: file number, beneficiary name, and amount.
// Columns are matched by header text so a re-ordered file still works.
const XLSX = require('xlsx');

// "الرمز" هو رقم الملف. عمود "الرقم" في الملف تسلسل داخلي لا يُستخدم.
const HEADERS = {
  fileNo: ['الرمز'],
  name: ['العائلة'],
  amount: ['القيمة'],
};

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function findColumns(headerRow) {
  const cols = {};
  for (const [key, names] of Object.entries(HEADERS)) {
    const idx = headerRow.findIndex((h) => names.includes(norm(h)));
    if (idx !== -1) cols[key] = idx;
  }
  const missing = Object.keys(HEADERS).filter((k) => cols[k] === undefined);
  if (missing.length) {
    const labels = { fileNo: 'الرمز', name: 'العائلة', amount: 'القيمة' };
    throw new Error(`أعمدة مطلوبة غير موجودة في الملف: ${missing.map((k) => labels[k]).join('، ')}`);
  }
  return cols;
}

// Returns { rows, headerRowNumber } where each row has excelRow, fileNo, name, amount (number|null), parseError.
// Rows that are completely empty are ignored. Duplicate file numbers are detected later, in the service.
function parseEntitlementWorkbook(buffer) {
  let grid;
  try {
    const wb = XLSX.read(buffer, { type: 'buffer', cellText: true, raw: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false });
  } catch (_) {
    throw new Error('تعذر قراءة الملف. تأكدي أنه ملف Excel صالح (xls أو xlsx)');
  }
  if (grid.length < 2) throw new Error('الملف لا يحتوي على بيانات');

  const cols = findColumns(grid[0]);
  const rows = [];
  grid.slice(1).forEach((r, i) => {
    const excelRow = i + 2;
    const fileNo = norm(r[cols.fileNo]);
    const name = norm(r[cols.name]);
    const rawAmount = norm(r[cols.amount]).replace(/,/g, '');
    if (!fileNo && !name && !rawAmount) return;

    let amount = null;
    let parseError = null;
    if (!fileNo) parseError = 'لا يوجد رقم ملف';
    else if (!name) parseError = 'لا يوجد اسم';
    else if (rawAmount === '') parseError = 'المبلغ فارغ';
    else if (!/^-?\d+(\.\d+)?$/.test(rawAmount)) parseError = 'المبلغ ليس رقمًا';
    else if (Number(rawAmount) < 0) parseError = 'المبلغ سالب';
    else amount = Number(rawAmount);

    rows.push({ excelRow, fileNo, name, amount, parseError });
  });
  return { rows };
}

module.exports = { parseEntitlementWorkbook, findColumns };
