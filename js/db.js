import { firebaseConfig } from './firebase-config.js';

const PROJECT_ID = firebaseConfig.projectId;
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents`;

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

export async function hashPin(pin) {
  const enc = new TextEncoder().encode(pin);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

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

export async function saveOtp(phone, otp) {
  const expiresAt = Date.now() + 5 * 60 * 1000;
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
