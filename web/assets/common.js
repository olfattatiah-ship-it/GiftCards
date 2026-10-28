// مشترك بين الصفحات: الاتصال بالخادم، والهيكل (القائمة الجانبية والشريط العلوي)، والنوافذ، والإشعارات.
window.App = (() => {
  const ICONS = {
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9.5h14V10"/><path d="M10 19.5v-5h4v5"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14.7c1.9.8 3 2.7 3.5 5.3"/>',
    card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/><path d="M6.5 15h4"/>',
    history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 4.5V9h4.5"/><path d="M12 7.5V12l3 2"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2"/><path d="m16 7 2.5 2.5"/><path d="m13.5 9.5 2 2"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    back: '<path d="M5 12h14"/><path d="m11 6-6 6 6 6"/>',
    logout: '<path d="M14 4.5h4.5a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M10 8.5 5.5 12 10 15.5"/><path d="M5.5 12H15"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    phone: '<path d="M5 3.5h3.2l1.6 4.4-2.1 1.4a11 11 0 0 0 6 6l1.4-2.1 4.4 1.6V18.5a1.5 1.5 0 0 1-1.6 1.5A16.5 16.5 0 0 1 3.5 5.1 1.5 1.5 0 0 1 5 3.5Z"/>',
    print: '<path d="M7 9V3.5h10V9"/><rect x="3.5" y="9" width="17" height="8" rx="2"/><path d="M7 14h10v6.5H7z"/>',
    check: '<path d="m4.5 12.5 4.5 4.5 10.5-10.5"/>',
    alert: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5"/><path d="M12 17.3v.2"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    wallet: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><circle cx="16.5" cy="14.5" r="1"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
    inbox: '<path d="M3 13.5 5.5 5h13L21 13.5"/><path d="M3 13.5V19h18v-5.5h-5l-1.5 2.5h-5L9 13.5z"/>',
    filter: '<path d="M3.5 5h17l-6.5 8v5.5l-4-2V13z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.8v.2"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  };

  function icon(name, cls = '') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(path, options = {}) {
    const init = { method: options.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const res = await fetch(path, init);
    let data = {};
    try { data = await res.json(); } catch (_) { /* لا يوجد JSON */ }
    if (res.status === 401 && !location.pathname.endsWith('login.html')) {
      location.href = 'login.html';
      throw new Error('يجب تسجيل الدخول');
    }
    if (!res.ok) {
      const err = new Error(data.error || 'حدث خطأ، حاولي مرة أخرى');
      err.details = data.details;
      throw err;
    }
    return data;
  }

  const roleNames = { admin: 'مدير النظام', importer: 'مستورد بيانات', reviewer: 'مراجِع', cards_manager: 'مسؤول البطاقات' };

  function toast(message, kind = 'ok') {
    let wrap = document.querySelector('.toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'toast-wrap';
      document.body.appendChild(wrap);
    }
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  // نافذة منبثقة بسيطة. يعيد Promise يعطي القيم عند الحفظ، أو null عند الإلغاء.
  function modal({ title, body, submitText = 'حفظ', danger = false }) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-backdrop';
      back.innerHTML = `
        <form class="modal" role="dialog" aria-modal="true">
          <h3>${escapeHtml(title)}</h3>
          <div class="modal-body">${body.html}</div>
          <div class="notice danger" data-err hidden style="margin:12px 0 0"></div>
          <div class="actions">
            <button type="button" class="btn ghost" data-cancel>إلغاء</button>
            <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${escapeHtml(submitText)}</button>
          </div>
        </form>`;
      document.body.appendChild(back);
      const form = back.querySelector('form');
      const errBox = back.querySelector('[data-err]');
      const onKey = (e) => { if (e.key === 'Escape') close(null); };
      const close = (value) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
      document.addEventListener('keydown', onKey);
      back.querySelector('[data-cancel]').addEventListener('click', () => close(null));
      back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        try {
          const value = await body.onSubmit(form);
          close(value ?? true);
        } catch (err) {
          errBox.textContent = err.message;
          errBox.hidden = false;
        } finally {
          submitBtn.disabled = false;
        }
      });
      setTimeout(() => form.querySelector('input,select,textarea')?.focus(), 30);
    });
  }

  function changePasswordModal() {
    return modal({
      title: 'تغيير كلمة المرور',
      submitText: 'تغيير',
      body: {
        html: `
          <div class="field"><label for="cp1">كلمة المرور الحالية</label><input class="input ltr" type="password" id="cp1" name="current_password" required autocomplete="current-password"></div>
          <div class="field"><label for="cp2">كلمة المرور الجديدة</label><input class="input ltr" type="password" id="cp2" name="new_password" required minlength="10" autocomplete="new-password"><div class="hint">10 أحرف على الأقل. ستبقى جلستك الحالية فقط نشطة.</div></div>`,
        onSubmit: async (form) => {
          await api('api/me/password', {
            method: 'POST',
            body: { current_password: form.current_password.value, new_password: form.new_password.value },
          });
          toast('تم تغيير كلمة المرور');
        },
      },
    });
  }

  // يبني الهيكل (القائمة الجانبية + الشريط العلوي) ويعيد عنصر المحتوى.
  async function mount({ active, title, back = null }) {
    const { user } = await api('api/me');
    const isReviewer = ['admin', 'reviewer'].includes(user.role);
    const nav = [
      ['index.html', 'home', 'الرئيسية'],
      ['beneficiaries.html', 'users', 'المستفيدون والبطاقات'],
      ['entitlements.html', 'wallet', 'استحقاقات الشحن'],
      ...(isReviewer ? [['operations.html', 'history', 'سجل العمليات']] : []),
    ];
    const initials = user.full_name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('');
    const backBtn = back
      ? `<a class="back-btn" href="${escapeHtml(back)}" data-back>${icon('back')}<span>رجوع</span></a>`
      : '';
    document.body.innerHTML = `
      <div class="app">
        <aside class="sidebar">
          <div class="brand">
            <img src="assets/logo-color.png" alt="شعار الجمعية">
            <div>
              <div class="name">جمعية سيهات</div>
              <div class="sub">للخدمات الاجتماعية</div>
            </div>
          </div>
          <div class="nav-title">القائمة</div>
          <div class="nav-group">
            ${nav.map(([href, ic, label]) => `
              <a class="nav-link ${href === active ? 'active' : ''}" href="${href}">${icon(ic)}<span>${label}</span></a>`).join('')}
          </div>
          <div class="spacer"></div>
          <div class="foot">نظام بطاقات الإهداء<br>الإصدار 1.0</div>
        </aside>
        <div class="main">
          <header class="topbar">
            ${backBtn}
            <h1 class="page-title">${escapeHtml(title)}</h1>
            <div class="spacer"></div>
            <div class="user-chip">
              <div class="avatar">${escapeHtml(initials)}</div>
              <div class="user-meta">
                <div class="n">${escapeHtml(user.full_name)}</div>
                <div class="r">${roleNames[user.role] || user.role}</div>
              </div>
              <button class="icon-btn" id="btnPassword" title="تغيير كلمة المرور" type="button">${icon('key')}</button>
              <button class="icon-btn" id="btnLogout" title="تسجيل الخروج" type="button">${icon('logout')}</button>
            </div>
          </header>
          <div class="content" id="content"></div>
        </div>
      </div>`;

    document.getElementById('btnPassword').addEventListener('click', () => changePasswordModal());
    document.getElementById('btnLogout').addEventListener('click', async () => {
      await api('api/logout', { method: 'POST' }).catch(() => {});
      location.href = 'login.html';
    });
    const backLink = document.querySelector('[data-back]');
    if (backLink) {
      backLink.addEventListener('click', (e) => {
        // إن وُجدت صفحة سابقة في المتصفح نعود إليها، وإلا نذهب للرابط المحدد
        if (history.length > 1 && document.referrer && new URL(document.referrer).origin === location.origin) {
          e.preventDefault();
          history.back();
        }
      });
    }
    return { content: document.getElementById('content'), user };
  }

  function statusBadge(status) {
    const label = status.color === 'green' ? 'نشطة' : status.color === 'orange' ? 'تحتاج متابعة' : 'غير نشطة';
    return `<span class="badge ${status.color}" title="${escapeHtml(status.reason || label)}">${label}</span>`;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(String(iso).replace(' ', 'T'));
    return isNaN(d) ? iso : d.toLocaleDateString('ar-SA-u-ca-gregory', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(String(iso).replace(' ', 'T'));
    return isNaN(d) ? iso : d.toLocaleString('ar-SA-u-ca-gregory', { dateStyle: 'medium', timeStyle: 'short' });
  }

  return { api, icon, escapeHtml, toast, modal, mount, statusBadge, formatDate, formatDateTime, roleNames };
})();
