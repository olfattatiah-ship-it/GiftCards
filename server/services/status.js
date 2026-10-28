// حالة البطاقة حسب آخر عملية شحن، بالأشهر التقويمية الفعلية:
//  أخضر: خلال الشهرين الماضيين بما في ذلك الشهرين
//  برتقالي: أكثر من شهرين وحتى أقل من أربعة أشهر
//  أحمر: أربعة أشهر أو أكثر، أو لا توجد عملية شحن سابقة

function fullCalendarMonthsBetween(from, to) {
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1;
  return Math.max(0, months);
}

function shipmentStatus(lastShippedAt, now = new Date()) {
  if (!lastShippedAt) {
    return { color: 'red', label: 'غير نشطة', reason: 'لا يوجد سجل شحن سابق', months: null };
  }
  const last = new Date(String(lastShippedAt).replace(' ', 'T'));
  if (Number.isNaN(last.getTime())) {
    return { color: 'red', label: 'غير نشطة', reason: 'تاريخ آخر شحن غير صالح', months: null };
  }
  const months = fullCalendarMonthsBetween(last, now);
  if (months <= 2) return { color: 'green', label: 'نشطة', reason: null, months };
  if (months < 4) return { color: 'orange', label: 'تحتاج متابعة', reason: null, months };
  return { color: 'red', label: 'غير نشطة', reason: `آخر شحن منذ ${months} شهرًا`, months };
}

module.exports = { shipmentStatus, fullCalendarMonthsBetween };
