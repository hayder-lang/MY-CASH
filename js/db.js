import { firebaseConfig } from './firebase-config.js';

// ============================================================
// هذا الملف يستخدم Firestore REST API مباشرة (طلبات fetch عادية)
// بدل مكتبة Firebase SDK الكاملة. السبب: بعض الشبكات تعيق الاتصال
// المستمر (streaming) اللي تستخدمه المكتبة، بينما طلبات fetch
// العادية (نفس طريقة فتح أي صفحة ويب) تشتغل بشكل أوثق حتى على
// شبكات مقيدة.
// ============================================================

const PROJECT_ID = firebaseConfig.projectId;
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents`;

// مهلة 15 ثانية لأي طلب، حتى ما تعلق الشاشة بصمت
function fetchWithTimeout(url, options, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer))
    .catch((err) => {
      if (err.name === 'AbortError') {
        throw new Error('انتهت مهلة الاتصال (' + label + '). تأكد من الانترنت وحاول مرة ثانية.');
      }
      throw new Error('فشل الاتصال (' + label + '): ' + err.message);
    });
}

// ---------- تحويل القيم من/إلى صيغة Firestore REST ----------
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v === 'SERVER_TIMESTAMP') return { timestampValue: new Date().toISOString() };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { integerValue: String(Math.trunc(v)) };
  return { stringValue: String(v) };
}

function toFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toValue(v);
  return fields;
}

function fromFields(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if ('stringValue' in v) obj[k] = v.stringValue;
    else if ('booleanValue' in v) obj[k] = v.booleanValue;
    else if ('integerValue' in v) obj[k] = Number(v.integerValue);
    else if ('doubleValue' in v) obj[k] = v.doubleValue;
    else if ('timestampValue' in v) obj[k] = v.timestampValue;
    else obj[k] = null;
  }
  return obj;
}

async function restGet(path, label) {
  const res = await fetchWithTimeout(`${BASE_URL}/${path}`, { method: 'GET' }, label);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error('خطأ من الخادم (' + res.status + '): ' + text.slice(0, 150));
  }
  const json = await res.json();
  return json.fields ? fromFields(json.fields) : {};
}

async function restWrite(path, data, label, mergeFields) {
  let url = `${BASE_URL}/${path}`;
  if (mergeFields && mergeFields.length) {
    url += '?' + mergeFields.map((f) => 'updateMask.fieldPaths=' + encodeURIComponent(f)).join('&');
  }
  const res = await fetchWithTimeout(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(data) })
  }, label);
  if (!res.ok) {
    const text = await res.text();
    throw new Error('خطأ من الخادم (' + res.status + '): ' + text.slice(0, 150));
  }
  return res.json();
}

async function restCreate(path, data, label) {
  const res = await fetchWithTimeout(`${BASE_URL}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(data) })
  }, label);
  if (!res.ok) {
    const text = await res.text();
    throw new Error('خطأ من الخادم (' + res.status + '): ' + text.slice(0, 150));
  }
  return res.json();
}

async function restList(path, label) {
  const res = await fetchWithTimeout(`${BASE_URL}/${path}`, { method: 'GET' }, label);
  if (res.status === 404) return [];
  if (!res.ok) {
    const text = await res.text();
    throw new Error('خطأ من الخادم (' + res.status + '): ' + text.slice(0, 150));
  }
  const json = await res.json();
  if (!json.documents) return [];
  return json.documents.map((d) => ({
    id: d.name.split('/').pop(),
    ...fromFields(d.fields)
  }));
}

// ---------- تشفير الرمز السري (بسيط، من طرف المتصفح) ----------
export async function hashPin(pin) {
  const enc = new TextEncoder().encode(pin);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- أكواد التفعيل ----------
export async function getActivationCode(code) {
  const id = code.trim().toUpperCase();
  const data = await restGet(`activationCodes/${id}`, 'التحقق من كود التفعيل');
  return data ? { id, ...data } : null;
}

export async function bindActivationCode(code, phone) {
  const id = code.trim().toUpperCase();
  await restWrite(`activationCodes/${id}`, {
    status: 'used',
    boundAgentPhone: phone,
    usedAt: 'SERVER_TIMESTAMP'
  }, 'ربط كود التفعيل', ['status', 'boundAgentPhone', 'usedAt']);
}

export async function createActivationCode(code, plan) {
  const id = code.trim().toUpperCase();
  await restWrite(`activationCodes/${id}`, {
    code: id,
    plan,
    status: 'unused',
    boundAgentPhone: null,
    createdAt: 'SERVER_TIMESTAMP',
    usedAt: null
  }, 'توليد كود التفعيل');
}

// ---------- الوكلاء ----------
export async function getAgent(phone) {
  const data = await restGet(`agents/${phone}`, 'جلب بيانات الوكيل');
  return data ? { id: phone, ...data } : null;
}

export async function createAgent(phone, pinHash, activationCode, plan, subscriptionEnd) {
  await restWrite(`agents/${phone}`, {
    phone,
    pinHash,
    activationCode,
    plan,
    subscriptionStart: 'SERVER_TIMESTAMP',
    subscriptionEnd,
    isAdmin: false,
    createdAt: 'SERVER_TIMESTAMP'
  }, 'إنشاء حساب الوكيل');
}

export async function updateAgentPin(phone, newPinHash) {
  await restWrite(`agents/${phone}`, { pinHash: newPinHash }, 'تحديث الرمز السري', ['pinHash']);
}

// ---------- استرجاع الرمز عبر واتساب (OTP) ----------
export async function saveOtp(phone, otp) {
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 دقائق
  await restWrite(`otpRequests/${phone}`, {
    otp,
    expiresAt,
    createdAt: 'SERVER_TIMESTAMP'
  }, 'إرسال رمز التحقق');
}

export async function verifyOtp(phone, otp) {
  const data = await restGet(`otpRequests/${phone}`, 'التحقق من الرمز');
  if (!data) return false;
  if (Date.now() > data.expiresAt) return false;
  return data.otp === otp;
}

// ---------- إعدادات المنفذ (الأجهزة المتوفرة) ----------
export async function getBranchConfig(phone) {
  return await restGet(`branches/${phone}`, 'جلب إعدادات المنفذ');
}

export async function saveBranchConfig(phone, devices) {
  await restWrite(`branches/${phone}`, devices, 'حفظ إعدادات المنفذ');
}

// ---------- التسويات ----------
export async function createSettlement(phone, device, amount, commission) {
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const timeStr = now.toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' });
  await restCreate(`branches/${phone}/settlements`, {
    device,
    amount,
    commission,
    dateKey,
    createdAt: 'SERVER_TIMESTAMP'
  }, 'حفظ التسوية');

  // تحديث ملخص اليوم (نقرأه لاحقاً بعملية واحدة بدل سرد كل التسويات)
  const existing = await restGet(`branches/${phone}/dailyStats/${dateKey}`, 'جلب ملخص اليوم');
  const devKeyAmount = `${device}_amount`;
  const devKeyCommission = `${device}_commission`;
  const devKeyCount = `${device}_count`;

  const txList = parseTransactions(existing);
  txList.push({ time: timeStr, device, amount, commission, type: 'settlement' });

  const updated = {
    totalCommission: (existing && existing.totalCommission || 0) + commission,
    totalAmount: (existing && existing.totalAmount || 0) + amount,
    count: (existing && existing.count || 0) + 1,
    lastDevice: device,
    lastAmount: amount,
    lastCommission: commission,
    [devKeyAmount]: (existing && existing[devKeyAmount] || 0) + amount,
    [devKeyCommission]: (existing && existing[devKeyCommission] || 0) + commission,
    [devKeyCount]: (existing && existing[devKeyCount] || 0) + 1,
    totalChargeAmount: (existing && existing.totalChargeAmount) || 0,
    chargeCount: (existing && existing.chargeCount) || 0,
    transactionsJson: JSON.stringify(txList)
  };
  await restWrite(`branches/${phone}/dailyStats/${dateKey}`, updated, 'تحديث ملخص اليوم');

  // الرصيد يزيد بالمبلغ الأصلي + عمولة الوكيل (نفس ما ينزل بالمحفظة فعلياً)
  await adjustDeviceBalance(phone, device, amount + commission);
}

function parseTransactions(existing) {
  if (!existing || !existing.transactionsJson) return [];
  try {
    return JSON.parse(existing.transactionsJson);
  } catch (e) {
    return [];
  }
}

export async function createCharge(phone, device, amount) {
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  const timeStr = now.toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' });

  await restCreate(`branches/${phone}/charges`, {
    device,
    amount,
    dateKey,
    createdAt: 'SERVER_TIMESTAMP'
  }, 'حفظ الشحن والتحويل');

  const existing = await restGet(`branches/${phone}/dailyStats/${dateKey}`, 'جلب ملخص اليوم');
  const devKeyChargeAmount = `${device}_charge_amount`;
  const devKeyChargeCount = `${device}_charge_count`;

  const txList = parseTransactions(existing);
  txList.push({ time: timeStr, device, amount, commission: 0, type: 'charge' });

  const updated = {
    totalCommission: (existing && existing.totalCommission) || 0,
    totalAmount: (existing && existing.totalAmount) || 0,
    count: (existing && existing.count) || 0,
    totalChargeAmount: (existing && existing.totalChargeAmount || 0) + amount,
    chargeCount: (existing && existing.chargeCount || 0) + 1,
    [devKeyChargeAmount]: (existing && existing[devKeyChargeAmount] || 0) + amount,
    [devKeyChargeCount]: (existing && existing[devKeyChargeCount] || 0) + 1,
    transactionsJson: JSON.stringify(txList)
  };
  if (existing && existing.lastDevice) {
    updated.lastDevice = existing.lastDevice;
    updated.lastAmount = existing.lastAmount;
    updated.lastCommission = existing.lastCommission;
  }
  await restWrite(`branches/${phone}/dailyStats/${dateKey}`, updated, 'تحديث ملخص اليوم');

  // الرصيد ينقص بمبلغ الشحن (نفس مبدأ السحب البنكي — هذا الكاش يغني عن سحب مصرفي حقيقي)
  await adjustDeviceBalance(phone, device, -amount);
  // ويزيد مجموع "المسحوب من المصرف" لنفس الجهاز
  await adjustWithdrawnTotal(phone, device, amount);
}

export async function getDailyStats(phone, dateKey) {
  return await restGet(`branches/${phone}/dailyStats/${dateKey}`, 'جلب ملخص اليوم');
}

export async function listSettlements(phone) {
  return await restList(`branches/${phone}/settlements`, 'جلب التسويات');
}

// ---------- الرصيد المعلق لكل جهاز (مستند واحد لكل منفذ، بدون List) ----------
export async function getDeviceBalances(phone) {
  const data = await restGet(`branches/${phone}/meta/balances`, 'جلب أرصدة الأجهزة');
  return data || {};
}

async function adjustDeviceBalance(phone, device, delta) {
  const current = await getDeviceBalances(phone);
  const updated = { ...current, [device]: (current[device] || 0) + delta };
  await restWrite(`branches/${phone}/meta/balances`, updated, 'تحديث رصيد الجهاز');
}

export async function createWithdrawal(phone, device, bankName, amount) {
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  await restCreate(`branches/${phone}/withdrawals`, {
    device,
    bankName,
    amount,
    dateKey,
    createdAt: 'SERVER_TIMESTAMP'
  }, 'حفظ السحب البنكي');

  // الرصيد ينقص بمقدار المبلغ المسحوب (كامل أو جزئي)
  await adjustDeviceBalance(phone, device, -amount);
  // ويزيد مجموع "المسحوب من المصرف" لنفس الجهاز
  await adjustWithdrawnTotal(phone, device, amount);
}

// ---------- مجموع المسحوب من المصرف لكل جهاز (سحب بنكي حقيقي + شحن وتحويل) ----------
export async function getWithdrawnTotals(phone) {
  const data = await restGet(`branches/${phone}/meta/withdrawn`, 'جلب مجموع المسحوب');
  return data || {};
}

async function adjustWithdrawnTotal(phone, device, delta) {
  const current = await getWithdrawnTotals(phone);
  const updated = { ...current, [device]: (current[device] || 0) + delta };
  await restWrite(`branches/${phone}/meta/withdrawn`, updated, 'تحديث مجموع المسحوب');
}
