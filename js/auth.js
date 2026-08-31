import { SUPPORT_PHONE } from './firebase-config.js';
import {
  getActivationCode, bindActivationCode, getAgent, createAgent,
  hashPin, updateAgentPin, saveOtp, verifyOtp,
  getBranchConfig, saveBranchConfig,
  createSettlement, getDailyStats,
  getDeviceBalances, createWithdrawal, createCharge, getWithdrawnTotals
} from './db.js';

const COMMISSION_RATE = 0.003; // 3 بالألف عمولة الوكيل
const DEVICE_LABELS = {
  Switch_Rasheed: 'Switch Rasheed', Switch_NBI: 'Switch NBI', Switch_BOB: 'Switch BOB',
  Qi: 'Qi', Qasa: 'Qasa', AlArab: 'AlArab', Tabadul: 'Tabadul', Blue: 'Blue'
};

const PLAN_LABELS = { '1m': 'شهر واحد', '3m': '3 أشهر', '12m': 'سنة كاملة' };
const PLAN_DAYS = { '1m': 30, '3m': 90, '12m': 365 };

function show(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
}

function setError(elId, msg) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.classList.toggle('show', !!msg);
}

document.getElementById('support-phone-display').textContent = SUPPORT_PHONE;

// ---------------- الانتقال بعد الدخول: تحقق من إعداد المنفذ أول ----------------
async function goAfterLogin(phone, plan) {
  try {
    const branch = await getBranchConfig(phone);
    if (!branch) {
      show('screen-device-setup');
    } else {
      window.__myDevices = branch;
      show('screen-dashboard');
      loadDashboard(phone);
    }
  } catch (e) {
    // لو صار خطأ بالتحقق، نكمل عادي لصفحة الإعداد حتى ما يعلق الوكيل
    show('screen-device-setup');
  }
}

const fmtNum = (n) => Math.round(n).toLocaleString('en-US');

// ---------------- تحميل بيانات لوحة التحكم ----------------
async function loadDashboard(phone) {
  const dateEl = document.getElementById('dash-date');
  dateEl.textContent = new Date().toLocaleDateString('ar-EG-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' });

  try {
    const today = new Date().toISOString().slice(0, 10);
    const stats = await getDailyStats(phone, today);

    const totalProfit = (stats && stats.totalCommission) || 0;
    const count = (stats && stats.count) || 0;
    document.getElementById('dash-profit-today').textContent = fmtNum(totalProfit) + ' د.ع';
    document.getElementById('dash-count-today').textContent = count + ' تسوية اليوم';

    const totalCharge = (stats && stats.totalChargeAmount) || 0;
    document.getElementById('dash-charge-today').textContent = fmtNum(totalCharge) + ' د.ع';

    const recentList = document.getElementById('dash-recent-list');
    if (stats && stats.lastDevice) {
      recentList.innerHTML = `
        <div class="recent-item">
          <span class="r-device">${DEVICE_LABELS[stats.lastDevice] || stats.lastDevice}</span>
          <span>${fmtNum(stats.lastAmount)} د.ع</span>
          <span class="r-commission">+${fmtNum(stats.lastCommission)}</span>
        </div>
      `;
    } else {
      recentList.innerHTML = '<div class="subtitle">ماكو تسويات لهسه</div>';
    }

    // الأرصدة المعلقة
    const balances = await getDeviceBalances(phone);
    window.__myBalances = balances;
    const balancesList = document.getElementById('dash-balances-list');
    const activeBalances = Object.entries(balances).filter(([, v]) => v && v > 0);
    if (activeBalances.length === 0) {
      balancesList.innerHTML = '<div class="subtitle">لا يوجد رصيد معلق</div>';
    } else {
      balancesList.innerHTML = activeBalances.map(([key, val]) => `
        <div class="recent-item">
          <span class="r-device">${DEVICE_LABELS[key] || key}</span>
          <span>${fmtNum(val)} د.ع</span>
        </div>
      `).join('');
    }

    // مجموع المسحوب من المصرف (سحب بنكي حقيقي + شحن وتحويل)
    const withdrawn = await getWithdrawnTotals(phone);
    const withdrawnList = document.getElementById('dash-withdrawn-list');
    const activeWithdrawn = Object.entries(withdrawn).filter(([, v]) => v && v > 0);
    if (activeWithdrawn.length === 0) {
      withdrawnList.innerHTML = '<div class="subtitle">لا يوجد مسحوبات لهسه</div>';
    } else {
      withdrawnList.innerHTML = activeWithdrawn.map(([key, val]) => `
        <div class="recent-item">
          <span class="r-device">${DEVICE_LABELS[key] || key}</span>
          <span>${fmtNum(val)} د.ع</span>
        </div>
      `).join('');
    }
  } catch (e) {
    document.getElementById('dash-count-today').textContent = 'تعذر تحميل البيانات، حدث الصفحة';
  }
}

// ---------------- حالة البدء ----------------
window.addEventListener('DOMContentLoaded', () => {
  const savedPhone = localStorage.getItem('agentPhone');
  show('screen-login');
  if (savedPhone) {
    document.getElementById('login-phone').value = savedPhone;
  }
});

// ---------------- شاشة التفعيل ----------------
document.getElementById('btn-check-activation').addEventListener('click', async () => {
  const code = document.getElementById('activation-code').value.trim();
  setError('activation-error', '');
  if (!code) { setError('activation-error', 'أدخل كود التفعيل'); return; }

  const btn = document.getElementById('btn-check-activation');
  btn.disabled = true; btn.textContent = 'جاري التحقق...';

  try {
    const record = await getActivationCode(code);
    if (!record) { setError('activation-error', 'كود التفعيل غير صحيح'); return; }
    if (record.status === 'used') { setError('activation-error', 'هذا الكود مستخدم من قبل'); return; }

    localStorage.setItem('deviceActivated', 'true');
    localStorage.setItem('activationCode', record.code);
    localStorage.setItem('activationPlan', record.plan);
    show('screen-signup');
  } catch (e) {
    setError('activation-error', 'فشل الاتصال، تأكد من الانترنت وحاول مرة ثانية');
  } finally {
    btn.disabled = false; btn.textContent = 'تحقق من الكود';
  }
});

// ---------------- شاشة التسجيل الأول (بعد التفعيل) ----------------
document.getElementById('btn-signup').addEventListener('click', async () => {
  const phone = document.getElementById('signup-phone').value.trim();
  const pin = document.getElementById('signup-pin').value.trim();
  const pin2 = document.getElementById('signup-pin2').value.trim();
  setError('signup-error', '');

  if (!/^07[0-9]{9}$/.test(phone)) { setError('signup-error', 'أدخل رقم هاتف عراقي صحيح (07xxxxxxxxx)'); return; }
  if (!/^[0-9]{5}$/.test(pin)) { setError('signup-error', 'الرمز السري لازم يكون 5 أرقام'); return; }
  if (pin !== pin2) { setError('signup-error', 'الرمزين غير متطابقين'); return; }

  const btn = document.getElementById('btn-signup');
  btn.disabled = true; btn.textContent = 'جاري الإنشاء...';

  try {
    const existing = await getAgent(phone);
    if (existing) { setError('signup-error', 'هذا الرقم مسجل مسبقاً، سجل دخول بدل هذا'); return; }

    const code = localStorage.getItem('activationCode');
    const plan = localStorage.getItem('activationPlan');
    const days = PLAN_DAYS[plan] || 30;
    const subscriptionEnd = Date.now() + days * 24 * 60 * 60 * 1000;

    const pinHash = await hashPin(pin);
    await createAgent(phone, pinHash, code, plan, subscriptionEnd);
    await bindActivationCode(code, phone);

    localStorage.setItem('agentPhone', phone);
    await goAfterLogin(phone, plan);
  } catch (e) {
    setError('signup-error', 'صار خطأ، حاول مرة ثانية');
  } finally {
    btn.disabled = false; btn.textContent = 'إنشاء الحساب';
  }
});

// ---------------- شاشة تسجيل الدخول ----------------
document.getElementById('btn-login').addEventListener('click', async () => {
  const phone = document.getElementById('login-phone').value.trim();
  const pin = document.getElementById('login-pin').value.trim();
  setError('login-error', '');

  if (!/^07[0-9]{9}$/.test(phone)) { setError('login-error', 'أدخل رقم هاتف صحيح'); return; }
  if (!/^[0-9]{5}$/.test(pin)) { setError('login-error', 'أدخل الرمز السري كامل (5 أرقام)'); return; }

  const btn = document.getElementById('btn-login');
  btn.disabled = true; btn.textContent = 'جاري الدخول...';

  try {
    const agent = await getAgent(phone);
    if (!agent) { setError('login-error', 'ما فيه حساب بهذا الرقم'); return; }

    const pinHash = await hashPin(pin);
    if (pinHash !== agent.pinHash) { setError('login-error', 'الرمز السري غير صحيح'); return; }

    if (agent.subscriptionEnd && Date.now() > agent.subscriptionEnd) {
      setError('login-error', 'انتهى اشتراكك، تواصل لتجديد الاشتراك');
      return;
    }

    localStorage.setItem('agentPhone', phone);
    await goAfterLogin(phone, agent.plan);
  } catch (e) {
    setError('login-error', 'فشل الاتصال، حاول مرة ثانية');
  } finally {
    btn.disabled = false; btn.textContent = 'دخول';
  }
});

document.getElementById('link-forgot-pin').addEventListener('click', () => {
  document.getElementById('forgot-phone').value = document.getElementById('login-phone').value;
  show('screen-forgot-1');
});

document.getElementById('btn-toggle-pin').addEventListener('click', () => {
  const pinInput = document.getElementById('login-pin');
  const btn = document.getElementById('btn-toggle-pin');
  const isHidden = pinInput.type === 'password';
  pinInput.type = isHidden ? 'text' : 'password';
  btn.textContent = isHidden ? '🙈' : '👁';
});

document.getElementById('link-login-to-activation').addEventListener('click', () => {
  show('screen-activation');
});

document.getElementById('link-to-login').addEventListener('click', () => show('screen-login'));

// ---------------- نسيت الرمز السري: خطوة 1 - إرسال OTP ----------------
document.getElementById('btn-send-otp').addEventListener('click', async () => {
  const phone = document.getElementById('forgot-phone').value.trim();
  setError('forgot1-error', '');
  if (!/^07[0-9]{9}$/.test(phone)) { setError('forgot1-error', 'أدخل رقم هاتف صحيح'); return; }

  const btn = document.getElementById('btn-send-otp');
  btn.disabled = true; btn.textContent = 'جاري الإرسال...';

  try {
    const agent = await getAgent(phone);
    if (!agent) { setError('forgot1-error', 'ما فيه حساب بهذا الرقم'); return; }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    await saveOtp(phone, otp);

    // TODO: هذا مكان استدعاء WhatsApp Business API الحقيقي لإرسال otp لرقم الوكيل
    // بالوقت الحالي (وضع تجريبي) نعرض الكود على الشاشة لغرض الاختبار فقط
    document.getElementById('otp-dev-hint').textContent = 'وضع تجريبي، الكود: ' + otp;

    localStorage.setItem('resetPhone', phone);
    show('screen-forgot-2');
  } catch (e) {
    setError('forgot1-error', 'فشل الإرسال، حاول مرة ثانية');
  } finally {
    btn.disabled = false; btn.textContent = 'إرسال الرمز عبر واتساب';
  }
});

// ---------------- نسيت الرمز السري: خطوة 2 - تأكيد OTP وتعيين رمز جديد ----------------
document.getElementById('btn-reset-pin').addEventListener('click', async () => {
  const phone = localStorage.getItem('resetPhone');
  const otp = document.getElementById('otp-code').value.trim();
  const newPin = document.getElementById('new-pin').value.trim();
  const newPin2 = document.getElementById('new-pin2').value.trim();
  setError('forgot2-error', '');

  if (!/^[0-9]{6}$/.test(otp)) { setError('forgot2-error', 'أدخل رمز التحقق المرسل (6 أرقام)'); return; }
  if (!/^[0-9]{5}$/.test(newPin)) { setError('forgot2-error', 'الرمز السري الجديد لازم 5 أرقام'); return; }
  if (newPin !== newPin2) { setError('forgot2-error', 'الرمزين غير متطابقين'); return; }

  const btn = document.getElementById('btn-reset-pin');
  btn.disabled = true; btn.textContent = 'جاري التحديث...';

  try {
    const ok = await verifyOtp(phone, otp);
    if (!ok) { setError('forgot2-error', 'رمز التحقق غير صحيح أو منتهي'); return; }

    const pinHash = await hashPin(newPin);
    await updateAgentPin(phone, pinHash);

    show('screen-login');
    document.getElementById('login-phone').value = phone;
    setError('login-error', '');
  } catch (e) {
    setError('forgot2-error', 'صار خطأ، حاول مرة ثانية');
  } finally {
    btn.disabled = false; btn.textContent = 'تأكيد وتحديث الرمز';
  }
});

document.getElementById('link-back-forgot1').addEventListener('click', () => show('screen-forgot-1'));

// ---------------- حفظ إعداد الأجهزة ----------------
document.getElementById('btn-save-devices').addEventListener('click', async () => {
  const phone = localStorage.getItem('agentPhone');
  const checked = Array.from(document.querySelectorAll('#screen-device-setup input[type="checkbox"]:checked'));
  setError('device-setup-error', '');

  if (checked.length === 0) {
    setError('device-setup-error', 'اختر جهاز واحد على الأقل');
    return;
  }

  const btn = document.getElementById('btn-save-devices');
  btn.disabled = true; btn.textContent = 'جاري الحفظ...';

  try {
    const devices = {};
    document.querySelectorAll('#screen-device-setup input[type="checkbox"]').forEach((cb) => {
      devices[cb.value.replace(/\s/g, '_')] = cb.checked;
    });
    await saveBranchConfig(phone, devices);
    window.__myDevices = devices;
    show('screen-dashboard');
    loadDashboard(phone);
  } catch (e) {
    setError('device-setup-error', e && e.message ? e.message : 'صار خطأ، حاول مرة ثانية');
  } finally {
    btn.disabled = false; btn.textContent = 'حفظ ومتابعة';
  }
});

// ---------------- شاشة إدخال تسوية ----------------
let selectedDevice = null;

document.getElementById('btn-open-add-settlement').addEventListener('click', () => {
  const devices = window.__myDevices || {};
  const enabledKeys = Object.keys(devices).filter((k) => devices[k]);
  const chipsWrap = document.getElementById('settlement-device-chips');
  chipsWrap.innerHTML = '';
  selectedDevice = null;

  if (enabledKeys.length === 0) {
    chipsWrap.innerHTML = '<div class="subtitle">ماكو أجهزة مفعّلة، راجع إعدادات المنفذ</div>';
  } else {
    enabledKeys.forEach((key, i) => {
      const chip = document.createElement('div');
      chip.className = 'device-chip' + (i === 0 ? ' selected' : '');
      chip.textContent = DEVICE_LABELS[key] || key;
      chip.dataset.key = key;
      chip.addEventListener('click', () => {
        chipsWrap.querySelectorAll('.device-chip').forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
        selectedDevice = key;
      });
      chipsWrap.appendChild(chip);
    });
    selectedDevice = enabledKeys[0];
  }

  document.getElementById('settlement-amount').value = '';
  document.getElementById('settlement-commission').textContent = '0 د.ع';
  setError('settlement-error', '');
  show('screen-add-settlement');
});

document.getElementById('link-back-dashboard').addEventListener('click', () => show('screen-dashboard'));

document.getElementById('settlement-amount').addEventListener('input', (e) => {
  const raw = e.target.value.replace(/[^0-9]/g, '');
  const val = raw ? parseInt(raw, 10) : 0;
  e.target.value = raw ? fmtNum(val) : '';
  document.getElementById('settlement-commission').textContent = fmtNum(val * COMMISSION_RATE) + ' د.ع';
});

document.getElementById('btn-save-settlement').addEventListener('click', async () => {
  const phone = localStorage.getItem('agentPhone');
  const raw = document.getElementById('settlement-amount').value.replace(/[^0-9]/g, '');
  const amount = raw ? parseInt(raw, 10) : 0;
  setError('settlement-error', '');

  if (!selectedDevice) { setError('settlement-error', 'اختر جهاز أول'); return; }
  if (amount <= 0) { setError('settlement-error', 'أدخل مبلغ التسوية'); return; }

  const btn = document.getElementById('btn-save-settlement');
  btn.disabled = true; btn.textContent = 'جاري الحفظ...';

  try {
    const commission = Math.round(amount * COMMISSION_RATE);
    await createSettlement(phone, selectedDevice, amount, commission);
    show('screen-dashboard');
    await loadDashboard(phone);
  } catch (e) {
    setError('settlement-error', e && e.message ? e.message : 'صار خطأ، حاول مرة ثانية');
  } finally {
    btn.disabled = false; btn.textContent = 'حفظ التسوية';
  }
});

// ---------------- شاشة سحب بنكي ----------------
let withdrawalDevice = null;

document.getElementById('btn-open-withdrawal').addEventListener('click', () => {
  const devices = window.__myDevices || {};
  const balances = window.__myBalances || {};
  const enabledKeys = Object.keys(devices).filter((k) => devices[k]);
  const chipsWrap = document.getElementById('withdrawal-device-chips');
  chipsWrap.innerHTML = '';
  withdrawalDevice = null;

  const updateBalanceDisplay = (key) => {
    document.getElementById('withdrawal-current-balance').textContent = fmtNum(balances[key] || 0) + ' د.ع';
  };

  if (enabledKeys.length === 0) {
    chipsWrap.innerHTML = '<div class="subtitle">ماكو أجهزة مفعّلة، راجع إعدادات المنفذ</div>';
  } else {
    enabledKeys.forEach((key, i) => {
      const chip = document.createElement('div');
      chip.className = 'device-chip' + (i === 0 ? ' selected' : '');
      chip.textContent = DEVICE_LABELS[key] || key;
      chip.dataset.key = key;
      chip.addEventListener('click', () => {
        chipsWrap.querySelectorAll('.device-chip').forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
        withdrawalDevice = key;
        updateBalanceDisplay(key);
      });
      chipsWrap.appendChild(chip);
    });
    withdrawalDevice = enabledKeys[0];
    updateBalanceDisplay(withdrawalDevice);
  }

  document.getElementById('withdrawal-bank').value = '';
  document.getElementById('withdrawal-amount').value = '';
  setError('withdrawal-error', '');
  show('screen-add-withdrawal');
});

document.getElementById('link-back-dashboard-2').addEventListener('click', () => show('screen-dashboard'));

document.getElementById('withdrawal-amount').addEventListener('input', (e) => {
  const raw = e.target.value.replace(/[^0-9]/g, '');
  const val = raw ? parseInt(raw, 10) : 0;
  e.target.value = raw ? fmtNum(val) : '';
});

document.getElementById('btn-save-withdrawal').addEventListener('click', async () => {
  const phone = localStorage.getItem('agentPhone');
  const bankName = document.getElementById('withdrawal-bank').value.trim();
  const raw = document.getElementById('withdrawal-amount').value.replace(/[^0-9]/g, '');
  const amount = raw ? parseInt(raw, 10) : 0;
  setError('withdrawal-error', '');

  if (!withdrawalDevice) { setError('withdrawal-error', 'اختر جهاز أول'); return; }
  if (!bankName) { setError('withdrawal-error', 'أدخل اسم المصرف'); return; }
  if (amount <= 0) { setError('withdrawal-error', 'أدخل مبلغ السحب'); return; }

  const btn = document.getElementById('btn-save-withdrawal');
  btn.disabled = true; btn.textContent = 'جاري الحفظ...';

  try {
    await createWithdrawal(phone, withdrawalDevice, bankName, amount);
    show('screen-dashboard');
    await loadDashboard(phone);
  } catch (e) {
    setError('withdrawal-error', e && e.message ? e.message : 'صار خطأ، حاول مرة ثانية');
  } finally {
    btn.disabled = false; btn.textContent = 'حفظ السحب';
  }
});

// ---------------- الكشف اليومي المفصّل ----------------
let reportDate = new Date();

async function loadDailyReport() {
  const phone = localStorage.getItem('agentPhone');
  const dateKey = reportDate.toISOString().slice(0, 10);
  document.getElementById('daily-report-date').textContent =
    reportDate.toLocaleDateString('ar-EG-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' });

  const tableEl = document.getElementById('daily-report-table');
  const txEl = document.getElementById('daily-report-transactions');
  tableEl.innerHTML = '<div class="subtitle">جاري التحميل...</div>';
  txEl.innerHTML = '';

  try {
    const stats = await getDailyStats(phone, dateKey);
    const total = (stats && stats.totalCommission) || 0;
    document.getElementById('daily-report-total').textContent = fmtNum(total) + ' د.ع';

    if (!stats) {
      tableEl.innerHTML = '<div class="subtitle">ماكو حركات بهذا اليوم</div>';
      return;
    }

    const deviceKeys = Object.keys(DEVICE_LABELS);
    const rows = deviceKeys
      .map((key) => ({
        key,
        amount: stats[`${key}_amount`] || 0,
        commission: stats[`${key}_commission`] || 0,
        count: stats[`${key}_count`] || 0
      }))
      .filter((r) => r.count > 0);

    if (rows.length === 0) {
      tableEl.innerHTML = '<div class="subtitle">ماكو تسويات بهذا اليوم</div>';
    } else {
      let html = `
        <div class="report-row header">
          <span>الجهاز</span>
          <span class="r-num">عدد</span>
          <span class="r-num">العمولة</span>
        </div>
      `;
      html += rows.map((r) => `
        <div class="report-row">
          <span class="r-name">${DEVICE_LABELS[r.key] || r.key}</span>
          <span class="r-num">${r.count}</span>
          <span class="r-num r-commission">${fmtNum(r.commission)}</span>
        </div>
      `).join('');
      tableEl.innerHTML = html;
    }

    // قائمة كل الحركات بالتفصيل (تسويات + شحن وتحويل) مرتبة من الأحدث
    let txList = [];
    if (stats.transactionsJson) {
      try { txList = JSON.parse(stats.transactionsJson); } catch (e) { txList = []; }
    }
    if (txList.length === 0) {
      txEl.innerHTML = '<div class="subtitle">ماكو حركات مسجلة بهذا اليوم</div>';
    } else {
      txList = txList.slice().reverse();
      let txHtml = `
        <div class="report-row header">
          <span>الوقت</span>
          <span class="r-num">الجهاز</span>
          <span class="r-num">المبلغ</span>
        </div>
      `;
      txHtml += txList.map((t) => `
        <div class="report-row">
          <span class="r-name">${t.time || ''} ${t.type === 'charge' ? '(شحن)' : ''}</span>
          <span class="r-num">${DEVICE_LABELS[t.device] || t.device}</span>
          <span class="r-num r-commission">${fmtNum(t.amount)}${t.commission ? ' +' + fmtNum(t.commission) : ''}</span>
        </div>
      `).join('');
      txEl.innerHTML = txHtml;
    }
  } catch (e) {
    tableEl.innerHTML = '<div class="subtitle">تعذر تحميل الكشف، حدث الصفحة</div>';
  }
}

document.getElementById('btn-open-daily-report').addEventListener('click', () => {
  reportDate = new Date();
  show('screen-daily-report');
  loadDailyReport();
});

document.getElementById('link-back-dashboard-3').addEventListener('click', () => show('screen-dashboard'));

document.getElementById('btn-prev-day').addEventListener('click', () => {
  reportDate.setDate(reportDate.getDate() - 1);
  loadDailyReport();
});

document.getElementById('btn-next-day').addEventListener('click', () => {
  const tomorrow = new Date(reportDate);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (tomorrow > new Date()) return; // ما نسمح نطلع لأيام المستقبل
  reportDate = tomorrow;
  loadDailyReport();
});

// ---------------- تسجيل الخروج ----------------
document.getElementById('btn-logout').addEventListener('click', () => {
  localStorage.removeItem('agentPhone');
  show('screen-login');
});

// ---------------- شاشة الصندوق وشريط التنقل السفلي ----------------
document.getElementById('btn-open-safe').addEventListener('click', () => show('screen-safe'));
document.getElementById('link-back-dashboard-6').addEventListener('click', () => show('screen-dashboard'));

document.getElementById('nav-home').addEventListener('click', () => show('screen-dashboard'));
document.getElementById('nav-account').addEventListener('click', () => {
  alert('شاشة الحساب قيد التطوير، تكدر تراجع بيانات حسابك حالياً من داخل التطبيق.');
});
document.getElementById('nav-settings').addEventListener('click', () => {
  alert('شاشة الإعدادات قيد التطوير حالياً.');
});

// ---------------- الكشف الدوري (أسبوعي / شهري) ----------------
async function loadPeriodicReport(days) {
  const phone = localStorage.getItem('agentPhone');
  const tableEl = document.getElementById('periodic-report-table');
  tableEl.innerHTML = '<div class="subtitle">جاري التحميل...</div>';

  try {
    const dateKeys = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dateKeys.push(d.toISOString().slice(0, 10));
    }

    const allStats = await Promise.all(dateKeys.map((dk) => getDailyStats(phone, dk)));

    const totals = {};
    let grandTotal = 0;
    allStats.forEach((stats) => {
      if (!stats) return;
      grandTotal += stats.totalCommission || 0;
      Object.keys(DEVICE_LABELS).forEach((key) => {
        const commission = stats[`${key}_commission`] || 0;
        const count = stats[`${key}_count`] || 0;
        if (count > 0) {
          if (!totals[key]) totals[key] = { commission: 0, count: 0 };
          totals[key].commission += commission;
          totals[key].count += count;
        }
      });
    });

    document.getElementById('periodic-report-total').textContent = fmtNum(grandTotal) + ' د.ع';

    const rows = Object.entries(totals);
    if (rows.length === 0) {
      tableEl.innerHTML = '<div class="subtitle">ماكو تسويات بهذي الفترة</div>';
      return;
    }

    let html = `
      <div class="report-row header">
        <span>الجهاز</span>
        <span class="r-num">عدد</span>
        <span class="r-num">العمولة</span>
      </div>
    `;
    html += rows.map(([key, v]) => `
      <div class="report-row">
        <span class="r-name">${DEVICE_LABELS[key] || key}</span>
        <span class="r-num">${v.count}</span>
        <span class="r-num r-commission">${fmtNum(v.commission)}</span>
      </div>
    `).join('');
    tableEl.innerHTML = html;
  } catch (e) {
    tableEl.innerHTML = '<div class="subtitle">تعذر تحميل الكشف، حدث الصفحة</div>';
  }
}

document.getElementById('btn-open-periodic-report').addEventListener('click', () => {
  show('screen-periodic-report');
  document.querySelectorAll('#screen-periodic-report .device-chip').forEach((c) => c.classList.remove('selected'));
  document.getElementById('btn-period-week').classList.add('selected');
  loadPeriodicReport(7);
});

document.getElementById('link-back-dashboard-4').addEventListener('click', () => show('screen-dashboard'));

document.getElementById('btn-period-week').addEventListener('click', () => {
  document.querySelectorAll('#screen-periodic-report .device-chip').forEach((c) => c.classList.remove('selected'));
  document.getElementById('btn-period-week').classList.add('selected');
  loadPeriodicReport(7);
});

document.getElementById('btn-period-month').addEventListener('click', () => {
  document.querySelectorAll('#screen-periodic-report .device-chip').forEach((c) => c.classList.remove('selected'));
  document.getElementById('btn-period-month').classList.add('selected');
  loadPeriodicReport(30);
});

// ---------------- شاشة الشحن والتحويل ----------------
let chargeDevice = null;

document.getElementById('btn-open-add-charge').addEventListener('click', () => {
  const devices = window.__myDevices || {};
  const enabledKeys = Object.keys(devices).filter((k) => devices[k]);
  const chipsWrap = document.getElementById('charge-device-chips');
  chipsWrap.innerHTML = '';
  chargeDevice = null;

  if (enabledKeys.length === 0) {
    chipsWrap.innerHTML = '<div class="subtitle">ماكو أجهزة مفعّلة، راجع إعدادات المنفذ</div>';
  } else {
    enabledKeys.forEach((key, i) => {
      const chip = document.createElement('div');
      chip.className = 'device-chip' + (i === 0 ? ' selected' : '');
      chip.textContent = DEVICE_LABELS[key] || key;
      chip.dataset.key = key;
      chip.addEventListener('click', () => {
        chipsWrap.querySelectorAll('.device-chip').forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
        chargeDevice = key;
      });
      chipsWrap.appendChild(chip);
    });
    chargeDevice = enabledKeys[0];
  }

  document.getElementById('charge-amount').value = '';
  setError('charge-error', '');
  show('screen-add-charge');
});

document.getElementById('link-back-dashboard-5').addEventListener('click', () => show('screen-dashboard'));

document.getElementById('charge-amount').addEventListener('input', (e) => {
  const raw = e.target.value.replace(/[^0-9]/g, '');
  const val = raw ? parseInt(raw, 10) : 0;
  e.target.value = raw ? fmtNum(val) : '';
});

document.getElementById('btn-save-charge').addEventListener('click', async () => {
  const phone = localStorage.getItem('agentPhone');
  const raw = document.getElementById('charge-amount').value.replace(/[^0-9]/g, '');
  const amount = raw ? parseInt(raw, 10) : 0;
  setError('charge-error', '');

  if (!chargeDevice) { setError('charge-error', 'اختر جهاز أول'); return; }
  if (amount <= 0) { setError('charge-error', 'أدخل المبلغ'); return; }

  const btn = document.getElementById('btn-save-charge');
  btn.disabled = true; btn.textContent = 'جاري الحفظ...';

  try {
    await createCharge(phone, chargeDevice, amount);
    show('screen-dashboard');
    await loadDashboard(phone);
  } catch (e) {
    setError('charge-error', e && e.message ? e.message : 'صار خطأ، حاول مرة ثانية');
  } finally {
    btn.disabled = false; btn.textContent = 'حفظ العملية';
  }
});
