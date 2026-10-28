// بناء ملفي التصدير. كل ملف يحتوي ثلاثة أعمدة فقط، بدون أي حقول أخرى.
const XLSX = require('xlsx');

function sheetBase64(headers, rows) {
  const aoa = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // نص الأرقام كما هو (أصفار بادئة وبطاقات طويلة لا تُحوَّل لأرقام)
  for (let r = 1; r < aoa.length; r++) {
    for (let c = 0; c < headers.length; c++) {
      const cell = XLSX.utils.encode_cell({ r, c });
      if (ws[cell] && typeof ws[cell].v === 'string' && /^\d+$/.test(ws[cell].v)) ws[cell].t = 's';
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
}

// ملف المورد: رقم الملف، رقم البطاقة، الرصيد (بدون أسماء)
function buildSupplierFile(rows) {
  return sheetBase64(['رقم الملف', 'رقم البطاقة', 'الرصيد'],
    rows.map((r) => [String(r.fileNo), String(r.card), r.amount]));
}

// ملف التواصل: رقم الملف، رقم الجوال، الرصيد
function buildContactsFile(rows) {
  return sheetBase64(['رقم الملف', 'رقم الجوال', 'الرصيد'],
    rows.map((r) => [String(r.fileNo), String(r.phone), r.amount]));
}

module.exports = { buildSupplierFile, buildContactsFile };
