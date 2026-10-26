'use strict';
require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { XMLParser } = require('fast-xml-parser');

const app = express();
function loadOrCreateSessionSecret() {
  // On a persistent Node host, create a stable local secret automatically on first run.
  // Netlify Functions are ephemeral/read-only for app files: configure SESSION_SECRET there.
  if (process.env.NETLIFY) return '';
  const secretPath = path.join(__dirname, '.session-secret');
  try {
    if (fs.existsSync(secretPath)) {
      const existing = fs.readFileSync(secretPath, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
    const generated = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(secretPath, generated + '\n', { flag: 'wx', mode: 0o600 });
    return generated;
  } catch (error) {
    // If another process created it between existsSync and writeFileSync, read that value.
    try {
      const existing = fs.readFileSync(secretPath, 'utf8').trim();
      if (existing.length >= 32) return existing;
    } catch {}
    console.error('Could not persist session secret. Set SESSION_SECRET in environment variables.', error.message);
    return '';
  }
}
const PORT = Number(process.env.PORT || 3000);
// Netlify Functions have an ephemeral filesystem; this app currently uses SQLite files.
// Do not allow payment actions that depend on records surviving a function restart.
const HAS_PERSISTENT_STORAGE = !process.env.NETLIFY;
const BASE_URL = String(process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const MODE = String(process.env.FREEDOMPAY_MODE || 'test').toLowerCase();
const MERCHANT_ID = String(process.env.FREEDOMPAY_MERCHANT_ID || '').trim();
const PAYMENT_SECRET = String(process.env.FREEDOMPAY_PAYMENT_SECRET || '').trim();
const PAYOUT_SECRET = String(process.env.FREEDOMPAY_PAYOUT_SECRET || '').trim();
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || 'admin');
const ADMIN_PASSWORD_HASH = String(process.env.ADMIN_PASSWORD_HASH || '').trim();
const ADMIN_SETUP_TOKEN = String(process.env.ADMIN_SETUP_TOKEN || '').trim();
const SESSION_SECRET = String(process.env.SESSION_SECRET || (process.env.NETLIFY ? crypto.randomBytes(48).toString('hex') : loadOrCreateSessionSecret()));
const PAYOUTS_ENABLED = String(process.env.ENABLE_PAYOUTS || 'false').toLowerCase() === 'true';
// Outgoing payouts are never available in test mode in this starter, to prevent an accidental live transfer.
function payoutFeatureAvailable() { return HAS_PERSISTENT_STORAGE && PAYOUTS_ENABLED && MODE === 'live' && Boolean(MERCHANT_ID && PAYOUT_SECRET && BASE_URL); }
const PAYOUT_URL = String(process.env.FREEDOMPAY_PAYOUT_URL || 'https://api.freedompay.kz/api/reg2nonreg').trim();
const DB_PATH = path.resolve(process.env.DATABASE_PATH || './data/payportal.sqlite');
const upload = multer({ limits: { fieldSize: 16 * 1024, fields: 80, files: 0 } });
const xmlParser = new XMLParser({ ignoreAttributes: true, trimValues: true, parseTagValue: false });

if (SESSION_SECRET.length < 32) {
  console.error('Configuration error: SESSION_SECRET must be at least 32 characters.');
  process.exit(1);
}
if (!['test', 'live'].includes(MODE)) {
  console.error('Configuration error: FREEDOMPAY_MODE must be test or live.');
  process.exit(1);
}
if (MODE === 'live' && process.env.NODE_ENV !== 'production') {
  console.warn('Warning: live payment mode is enabled while NODE_ENV is not production.');
}
if (MODE === 'live' && !BASE_URL.startsWith('https://')) {
  console.error('Configuration error: live mode requires BASE_URL to be a public https:// URL.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    amount_kzt INTEGER NOT NULL CHECK(amount_kzt > 0),
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed')),
    provider_payment_id TEXT,
    provider_result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    paid_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
  CREATE TABLE IF NOT EXISTS payouts (
    order_id TEXT PRIMARY KEY,
    amount_kzt INTEGER NOT NULL CHECK(amount_kzt > 0),
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'creating' CHECK(status IN ('creating','awaiting_recipient','processing','paid','failed')),
    provider_payment_id TEXT,
    provider_status TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    paid_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_payouts_created ON payouts(created_at DESC);
  CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    reference_id TEXT,
    details TEXT,
    created_at TEXT NOT NULL
  );
`);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      formAction: ["'self'", 'https://api.freedompay.kz', 'https://customer.freedompay.kz'],
      frameAncestors: ["'none'"]
    }
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '1h' }));

const publicApiLimiter = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many login attempts. Try again later.' } });

function nowIso() { return new Date().toISOString(); }
function audit(event, referenceId, details = {}) {
  db.prepare('INSERT INTO audit_log(event, reference_id, details, created_at) VALUES (?, ?, ?, ?)')
    .run(event, referenceId || null, JSON.stringify(details), nowIso());
}
function escapeXml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function xmlResponse(fields) {
  const body = Object.entries(fields).map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?><response>${body}</response>`;
}
function parseXmlResponse(xml) {
  const parsed = xmlParser.parse(xml);
  return parsed?.response || parsed?.root || parsed || {};
}
function randomSalt() { return crypto.randomBytes(12).toString('hex'); }

// Freedom Pay signs the script name, sorted parameter values, and secret key with MD5.
// All provider calls are server-side; secret keys are never sent to the browser.
function signature(scriptName, params, secret) {
  const keys = Object.keys(params).filter((key) => key !== 'pg_sig').sort();
  const values = keys.map((key) => {
    const value = params[key];
    return value == null ? '' : String(value);
  });
  return crypto.createHash('md5').update([scriptName, ...values, secret].join(';'), 'utf8').digest('hex');
}
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[a-f0-9]{32}$/i.test(a) || !/^[a-f0-9]{32}$/i.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a.toLowerCase(), 'hex'), Buffer.from(b.toLowerCase(), 'hex'));
}
function verifySignature(scriptName, params, secret) {
  if (!secret || !params || typeof params.pg_sig !== 'string') return false;
  return safeEqualHex(params.pg_sig, signature(scriptName, params, secret));
}
function signedParams(scriptName, params, secret) {
  const result = { ...params };
  result.pg_sig = signature(scriptName, result, secret);
  return result;
}
function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const bit of header.split(';')) {
    const i = bit.indexOf('=');
    if (i >= 0 && bit.slice(0, i).trim() === name) {
      const raw = bit.slice(i + 1).trim();
      try { return decodeURIComponent(raw); } catch { return ''; }
    }
  }
  return '';
}
function signSession(payloadPart) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payloadPart).digest('base64url');
}
function readSession(req) {
  const token = getCookie(req, 'qfp_session');
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const payloadPart = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = signSession(payloadPart);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    if (!payload || payload.exp < Date.now() || payload.role !== 'admin' || typeof payload.csrf !== 'string') return null;
    return payload;
  } catch { return null; }
}
function issueSession(res) {
  const payload = { role: 'admin', exp: Date.now() + 8 * 60 * 60 * 1000, csrf: crypto.randomBytes(24).toString('hex') };
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const token = `${payloadPart}.${signSession(payloadPart)}`;
  const secure = process.env.NODE_ENV === 'production' || BASE_URL.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `qfp_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`);
  return payload;
}
function clearSession(res) {
  const secure = process.env.NODE_ENV === 'production' || BASE_URL.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `qfp_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}
function requireAdmin(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Sign in to the admin panel.' });
  req.adminSession = session;
  next();
}
function requireCsrf(req, res, next) {
  const got = req.get('x-csrf-token') || req.body?.csrfToken;
  if (!req.adminSession || typeof got !== 'string' || got !== req.adminSession.csrf) {
    return res.status(403).json({ error: 'Security token expired. Reload the admin panel and try again.' });
  }
  next();
}
function validPublicUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && (parsed.hostname === 'freedompay.kz' || parsed.hostname.endsWith('.freedompay.kz'));
  } catch { return false; }
}
async function postForm(url, params) {
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) form.set(key, String(value));
  }
  const response = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
  return parseXmlResponse(text);
}
function asPublicStatus(row) {
  return { orderId: row.order_id, amount: row.amount_kzt, description: row.description, status: row.status, createdAt: row.created_at, paidAt: row.paid_at || null };
}
function makeOrderId(prefix = 'ORD') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(7).toString('hex')}`.slice(0, 48);
}
function setXml(res, status, fields) {
  res.status(status).type('application/xml; charset=utf-8').send(xmlResponse(fields));
}
function providerConfigReady() {
  return HAS_PERSISTENT_STORAGE && Boolean(MERCHANT_ID && PAYMENT_SECRET && BASE_URL);
}

app.get('/api/config', (_req, res) => {
  res.json({
    provider: 'Freedom Pay',
    configured: providerConfigReady(),
    mode: MODE,
    payoutsEnabled: payoutFeatureAvailable(),
    persistentStorage: HAS_PERSISTENT_STORAGE,
    message: !HAS_PERSISTENT_STORAGE
      ? 'Бұл Netlify конфигурациясында тұрақты дерекқор қосылмаған. Нақты төлемдер қауіпсіздік үшін өшірілген.'
      : providerConfigReady()
        ? (MODE === 'test' ? 'Test mode: transactions are handled by the provider test environment.' : 'Live API configured.')
        : 'Provider credentials are not configured. No fake payments will be created.'
  });
});

app.post('/api/payments', publicApiLimiter, async (req, res) => {
  if (!HAS_PERSISTENT_STORAGE) {
    return res.status(503).json({ error: 'Төлем қабылдау уақытша өшірілген: Netlify үшін тұрақты дерекқор қосылмаған. Төлем жазбасын жоғалтпау үшін төлем жасалмайды.' });
  }
  const amount = Number(req.body?.amount);
  const description = String(req.body?.description || '').trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, 120);
  if (!Number.isSafeInteger(amount) || amount < 100 || amount > 2_000_000) {
    return res.status(400).json({ error: 'Соманы 100–2 000 000 ₸ аралығында, бүтін санмен енгіз.' });
  }
  if (description.length < 3) return res.status(400).json({ error: 'Тауардың немесе қызметтің атауын кемінде 3 таңбамен жаз.' });
  if (!providerConfigReady()) return res.status(503).json({ error: 'Freedom Pay API кілттері әлі қосылмаған. Төлем ойдан жасалмайды.' });
  if (MODE === 'live' && !BASE_URL.startsWith('https://')) return res.status(503).json({ error: 'Live төлемдер үшін жария HTTPS домені қажет.' });

  const orderId = makeOrderId();
  const stamp = nowIso();
  db.prepare(`INSERT INTO orders(order_id, amount_kzt, description, status, created_at, updated_at)
              VALUES (?, ?, ?, 'pending', ?, ?)`).run(orderId, amount, description, stamp, stamp);
  audit('payment.created', orderId, { amountKzt: amount, mode: MODE });

  const params = {
    pg_order_id: orderId,
    pg_merchant_id: MERCHANT_ID,
    pg_amount: String(amount),
    pg_currency: 'KZT',
    pg_description: description,
    pg_salt: randomSalt(),
    pg_result_url: `${BASE_URL}/api/freedompay/result.php`,
    pg_request_method: 'POST',
    pg_success_url: `${BASE_URL}/payment-result.html?order=${encodeURIComponent(orderId)}`,
    pg_failure_url: `${BASE_URL}/payment-result.html?order=${encodeURIComponent(orderId)}`,
    pg_success_url_method: 'GET',
    pg_failure_url_method: 'GET',
    pg_lifetime: '3600',
    pg_language: 'ru'
  };
  if (MODE === 'test') params.pg_testing_mode = '1';
  const request = signedParams('init_payment.php', params, PAYMENT_SECRET);

  try {
    const result = await postForm('https://api.freedompay.kz/init_payment.php', request);
    if (String(result.pg_status) !== 'ok') {
      db.prepare("UPDATE orders SET status='failed', provider_result=?, updated_at=? WHERE order_id=?")
        .run(String(result.pg_error_code || result.pg_error_description || 'provider_error').slice(0, 180), nowIso(), orderId);
      audit('payment.provider_rejected', orderId, { code: String(result.pg_error_code || 'unknown') });
      return res.status(502).json({ error: 'Freedom Pay төлем жасау сұрауын қабылдамады. API баптауларын тексер.' });
    }
    if (!verifySignature('init_payment.php', result, PAYMENT_SECRET)) {
      db.prepare("UPDATE orders SET status='failed', provider_result='invalid_provider_signature', updated_at=? WHERE order_id=?").run(nowIso(), orderId);
      audit('payment.invalid_provider_signature', orderId);
      return res.status(502).json({ error: 'Провайдердің жауабының қолтаңбасы жарамсыз. Төлем сілтемесі ашылған жоқ.' });
    }
    if (!result.pg_redirect_url || !validPublicUrl(String(result.pg_redirect_url))) {
      db.prepare("UPDATE orders SET status='failed', provider_result='invalid_redirect_url', updated_at=? WHERE order_id=?").run(nowIso(), orderId);
      audit('payment.invalid_redirect', orderId);
      return res.status(502).json({ error: 'Провайдер қауіпсіз төлем сілтемесін қайтармады.' });
    }
    db.prepare('UPDATE orders SET provider_payment_id=?, provider_result=?, updated_at=? WHERE order_id=?')
      .run(String(result.pg_payment_id || ''), String(result.pg_status), nowIso(), orderId);
    audit('payment.checkout_created', orderId, { providerPaymentId: String(result.pg_payment_id || '') });
    return res.json({ orderId, redirectUrl: String(result.pg_redirect_url), status: 'pending' });
  } catch (error) {
    console.error('Payment provider request failed:', error.message);
    db.prepare("UPDATE orders SET status='failed', provider_result='provider_unreachable', updated_at=? WHERE order_id=?").run(nowIso(), orderId);
    audit('payment.provider_unreachable', orderId);
    return res.status(502).json({ error: 'Freedom Pay серверімен байланыс орнамады. Бұл төлем жасалды дегенді білдірмейді.' });
  }
});

// Provider server-to-server notification. This, not the browser redirect, determines payment status.
app.post('/api/freedompay/result.php', upload.none(), (req, res) => {
  if (!HAS_PERSISTENT_STORAGE) {
    return setXml(res, 503, { pg_status: 'error', pg_description: 'Persistent database is not configured.' });
  }
  const data = req.body || {};
  if (!verifySignature('result.php', data, PAYMENT_SECRET)) {
    audit('payment.callback_signature_failed', String(data.pg_order_id || 'unknown'));
    return setXml(res, 400, { pg_status: 'error', pg_description: 'Invalid signature' });
  }
  const order = db.prepare('SELECT * FROM orders WHERE order_id=?').get(String(data.pg_order_id || ''));
  if (!order || String(data.pg_merchant_id || '') !== String(MERCHANT_ID)) {
    audit('payment.callback_unknown_order', String(data.pg_order_id || 'unknown'));
    return setXml(res, 400, { pg_status: 'error', pg_description: 'Unknown order' });
  }
  const callbackAmount = Number(data.pg_amount);
  if (!Number.isFinite(callbackAmount) || Math.round(callbackAmount) !== Number(order.amount_kzt) || (data.pg_currency && data.pg_currency !== 'KZT')) {
    audit('payment.callback_amount_mismatch', order.order_id, { received: String(data.pg_amount || ''), expected: order.amount_kzt });
    return setXml(res, 400, { pg_status: 'error', pg_description: 'Amount mismatch' });
  }
  const success = String(data.pg_result) === '1';
  const current = db.prepare('SELECT status FROM orders WHERE order_id=?').get(order.order_id);
  if (current.status !== 'paid') {
    const nextStatus = success ? 'paid' : 'failed';
    db.prepare('UPDATE orders SET status=?, provider_payment_id=COALESCE(NULLIF(?,\'\'), provider_payment_id), provider_result=?, updated_at=?, paid_at=CASE WHEN ?=\'paid\' THEN COALESCE(paid_at, ?) ELSE paid_at END WHERE order_id=?')
      .run(nextStatus, String(data.pg_payment_id || ''), String(data.pg_result || '').slice(0, 60), nowIso(), nextStatus, nowIso(), order.order_id);
  }
  audit(success ? 'payment.callback_paid' : 'payment.callback_failed', order.order_id, { providerPaymentId: String(data.pg_payment_id || '') });
  const reply = signedParams('result.php', { pg_status: 'ok', pg_description: success ? 'Order result recorded' : 'Payment result recorded', pg_salt: randomSalt() }, PAYMENT_SECRET);
  return setXml(res, 200, reply);
});

app.get('/api/status/:orderId', publicApiLimiter, (req, res) => {
  if (!HAS_PERSISTENT_STORAGE) {
    return res.status(503).json({ error: 'Төлем статусы қолжетімсіз: тұрақты дерекқор қосылмаған.' });
  }
  const order = db.prepare('SELECT order_id, amount_kzt, description, status, created_at, paid_at FROM orders WHERE order_id=?').get(String(req.params.orderId || ''));
  if (!order) return res.status(404).json({ error: 'Тапсырыс табылмады.' });
  return res.json(asPublicStatus(order));
});

function adminSetupTokenRequired() {
  // Only an explicitly local development setup may bootstrap without an out-of-band token.
  if (process.env.NODE_ENV !== 'development') return true;
  if (!BASE_URL) return false;
  try {
    const hostname = new URL(BASE_URL).hostname.toLowerCase();
    return !['localhost', '127.0.0.1', '::1'].includes(hostname);
  } catch { return true; }
}
function safeEqualString(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
function configuredAdminHash() {
  if (ADMIN_PASSWORD_HASH) return ADMIN_PASSWORD_HASH;
  const row = db.prepare('SELECT value FROM admin_settings WHERE key=?').get('password_hash');
  return row?.value || '';
}
app.get('/api/admin/setup-status', (_req, res) => {
  const configured = Boolean(configuredAdminHash());
  const setupTokenRequired = adminSetupTokenRequired();
  res.json({
    setupRequired: !configured,
    canSetupHere: HAS_PERSISTENT_STORAGE,
    persistentStorage: HAS_PERSISTENT_STORAGE,
    setupTokenRequired,
    setupTokenConfigured: ADMIN_SETUP_TOKEN.length >= 32
  });
});
app.post('/api/admin/setup', loginLimiter, async (req, res) => {
  if (process.env.NETLIFY) return res.status(503).json({ error: 'Netlify-де сайт ішіндегі алғашқы баптау қолжетімсіз. Бұл нұсқада тұрақты дерекқор қажет.' });
  if (adminSetupTokenRequired()) {
    if (ADMIN_SETUP_TOKEN.length < 32) return res.status(503).json({ error: 'Алғашқы әкімші аккаунтын қауіпсіз жасау үшін серверге кемінде 32 таңбалы ADMIN_SETUP_TOKEN қосып, қайта іске қос.' });
    if (!safeEqualString(req.body?.setupToken, ADMIN_SETUP_TOKEN)) return res.status(403).json({ error: 'Бір реттік орнату коды қате.' });
  }
  if (ADMIN_PASSWORD_HASH || configuredAdminHash()) return res.status(409).json({ error: 'Әкімші бұрыннан бапталған. Қайта орнату үшін сервердегі дерекқорды әкімші рұқсатымен басқару қажет.' });
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const confirm = String(req.body?.confirmPassword || '');
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) return res.status(400).json({ error: 'Логин 3–32 таңба болсын: латын әріптері, сан, нүкте, сызықша.' });
  if (password.length < 12 || password.length > 72 || Buffer.byteLength(password, 'utf8') > 72) return res.status(400).json({ error: 'Құпиясөз 12–72 таңба болсын және UTF-8 бойынша 72 байттан аспасын.' });
  if (password !== confirm) return res.status(400).json({ error: 'Құпиясөздер сәйкес емес.' });
  const hash = await bcrypt.hash(password, 12);
  const save = db.transaction(() => {
    if (configuredAdminHash()) return false;
    const now = nowIso();
    db.prepare('INSERT INTO admin_settings(key,value,updated_at) VALUES(?,?,?)').run('username', username, now);
    db.prepare('INSERT INTO admin_settings(key,value,updated_at) VALUES(?,?,?)').run('password_hash', hash, now);
    return true;
  });
  if (!save()) return res.status(409).json({ error: 'Әкімші басқа сұраумен бапталып қойды. Кіру бетіне өтіңіз.' });
  audit('admin.initial_setup', username);
  res.status(201).json({ ok: true, message: 'Әкімші құпиясөзі сақталды. Енді кіре аласыз.' });
});
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const username = String(req.body?.username || '');
  const password = String(req.body?.password || '');
  const passwordHash = configuredAdminHash();
  const savedUsername = db.prepare('SELECT value FROM admin_settings WHERE key=?').get('username')?.value;
  const expectedUsername = savedUsername || ADMIN_USERNAME;
  if (!passwordHash) return res.status(503).json({ error: 'Алдымен осы бетте әкімші құпиясөзін орнатыңыз.' });
  let passwordOk = false;
  try { passwordOk = await bcrypt.compare(password, passwordHash); } catch { passwordOk = false; }
  if (username !== expectedUsername || !passwordOk) {
    audit('admin.login_failed', username.slice(0, 60));
    return res.status(401).json({ error: 'Логин немесе құпиясөз қате.' });
  }
  const session = issueSession(res);
  audit('admin.login', expectedUsername);
  res.json({ ok: true, csrfToken: session.csrf });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ authenticated: true, username: db.prepare('SELECT value FROM admin_settings WHERE key=?').get('username')?.value || ADMIN_USERNAME, csrfToken: req.adminSession.csrf, payoutsEnabled: payoutFeatureAvailable() });
});
app.post('/api/admin/logout', requireAdmin, requireCsrf, (req, res) => {
  clearSession(res);
  audit('admin.logout', ADMIN_USERNAME);
  res.json({ ok: true });
});
app.get('/api/admin/data', requireAdmin, (_req, res) => {
  if (!HAS_PERSISTENT_STORAGE) {
    return res.status(503).json({ error: 'Әкімші деректері қауіпсіз режимде өшірілген: Netlify үшін тұрақты дерекқор қажет.' });
  }
  const payments = db.prepare('SELECT order_id, amount_kzt, description, status, provider_payment_id, provider_result, created_at, paid_at FROM orders ORDER BY created_at DESC LIMIT 100').all();
  const payouts = db.prepare('SELECT order_id, amount_kzt, description, status, provider_payment_id, provider_status, created_at, paid_at FROM payouts ORDER BY created_at DESC LIMIT 100').all();
  const sums = db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN status='paid' THEN amount_kzt ELSE 0 END),0) AS paid_total,
    COUNT(*) AS total_count,
    COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending_count
    FROM orders`).get();
  res.json({ payments, payouts, stats: sums, mode: MODE, payoutsEnabled: payoutFeatureAvailable() });
});

// Payouts use the provider's hosted recipient-card page; this app does not collect or store PAN/CVV.
// Only authorized admins can initiate a payout from the merchant's provider balance.
app.post('/api/admin/payouts', requireAdmin, requireCsrf, publicApiLimiter, async (req, res) => {
  if (!HAS_PERSISTENT_STORAGE) {
    return res.status(503).json({ error: 'Выплата өшірілген: тұрақты дерекқор қосылмаған.' });
  }
  if (!payoutFeatureAvailable()) {
    return res.status(403).json({ error: 'Картаға төлем функциясы жабық. Freedom Pay менеджері оны ресми түрде қосуы керек.' });
  }
  if (MODE === 'live' && !BASE_URL.startsWith('https://')) {
    return res.status(503).json({ error: 'Live төлемдер үшін жария HTTPS домені қажет.' });
  }
  const amount = Number(req.body?.amount);
  const description = String(req.body?.description || '').trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, 120);
  if (!Number.isSafeInteger(amount) || amount < 1000 || amount > 1_000_000) {
    return res.status(400).json({ error: 'Выплата сомасы 1 000–1 000 000 ₸ аралығында болуы керек.' });
  }
  if (description.length < 3) return res.status(400).json({ error: 'Төлемнің нақты себебін жазыңыз.' });
  const orderId = makeOrderId('PAY');
  const stamp = nowIso();
  db.prepare(`INSERT INTO payouts(order_id, amount_kzt, description, status, created_at, updated_at)
              VALUES (?, ?, ?, 'creating', ?, ?)`).run(orderId, amount, description, stamp, stamp);
  audit('payout.created', orderId, { amountKzt: amount });
  const limit = new Date(Date.now() + 30 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  const params = signedParams('reg2nonreg', {
    pg_merchant_id: MERCHANT_ID,
    pg_order_id: orderId,
    pg_amount: String(amount),
    pg_description: description,
    pg_post_link: `${BASE_URL}/api/freedompay/payout.php`,
    pg_back_link: `${BASE_URL}/admin.html?payout=${encodeURIComponent(orderId)}`,
    pg_order_time_limit: limit,
    pg_salt: randomSalt()
  }, PAYOUT_SECRET);
  try {
    const result = await postForm(PAYOUT_URL, params);
    if (String(result.pg_status) !== 'ok') {
      db.prepare("UPDATE payouts SET status='failed', provider_status=?, updated_at=? WHERE order_id=?")
        .run(String(result.pg_error_code || result.pg_error_description || 'provider_error').slice(0, 180), nowIso(), orderId);
      audit('payout.provider_rejected', orderId, { code: String(result.pg_error_code || 'unknown') });
      return res.status(502).json({ error: 'Freedom Pay выплата сұрауын қабылдамады. Менеджер баптаулары мен payout balance тексерілсін.' });
    }
    if (!verifySignature('reg2nonreg', result, PAYOUT_SECRET)) {
      db.prepare("UPDATE payouts SET status='failed', provider_status='invalid_provider_signature', updated_at=? WHERE order_id=?").run(nowIso(), orderId);
      audit('payout.invalid_provider_signature', orderId);
      return res.status(502).json({ error: 'Провайдердің жауабының қолтаңбасы жарамсыз. Выплата жалғасқан жоқ.' });
    }
    if (!result.pg_redirect_url || !validPublicUrl(String(result.pg_redirect_url))) {
      db.prepare("UPDATE payouts SET status='failed', provider_status='invalid_redirect_url', updated_at=? WHERE order_id=?").run(nowIso(), orderId);
      audit('payout.invalid_redirect', orderId);
      return res.status(502).json({ error: 'Провайдер қауіпсіз payout сілтемесін қайтармады.' });
    }
    db.prepare("UPDATE payouts SET status='awaiting_recipient', provider_payment_id=?, provider_status='page_created', updated_at=? WHERE order_id=?")
      .run(String(result.pg_payment_id || ''), nowIso(), orderId);
    audit('payout.hosted_page_created', orderId, { providerPaymentId: String(result.pg_payment_id || '') });
    res.json({ orderId, redirectUrl: String(result.pg_redirect_url), status: 'awaiting_recipient' });
  } catch (error) {
    console.error('Payout provider request failed:', error.message);
    db.prepare("UPDATE payouts SET status='failed', provider_status='provider_unreachable', updated_at=? WHERE order_id=?").run(nowIso(), orderId);
    audit('payout.provider_unreachable', orderId);
    res.status(502).json({ error: 'Freedom Pay payout серверімен байланыс болмады. Ақша аударылды деп есептелмейді.' });
  }
});

app.post('/api/freedompay/payout.php', upload.none(), (req, res) => {
  if (!HAS_PERSISTENT_STORAGE) return res.status(503).send('Persistent database is not configured');
  const data = req.body || {};
  if (!verifySignature('payout.php', data, PAYOUT_SECRET)) {
    audit('payout.callback_signature_failed', String(data.pg_order_id || 'unknown'));
    return res.status(400).send('Invalid signature');
  }
  const payout = db.prepare('SELECT * FROM payouts WHERE order_id=?').get(String(data.pg_order_id || ''));
  if (!payout || String(data.pg_merchant_id || '') !== String(MERCHANT_ID)) {
    audit('payout.callback_unknown_order', String(data.pg_order_id || 'unknown'));
    return res.status(400).send('Unknown payout');
  }
  if (data.pg_payment_amount != null && Number(data.pg_payment_amount) !== Number(payout.amount_kzt)) {
    audit('payout.callback_amount_mismatch', payout.order_id, { received: String(data.pg_payment_amount), expected: payout.amount_kzt });
    return res.status(400).send('Amount mismatch');
  }
  const providerStatus = String(data.pg_payment_status || data.pg_status || 'process');
  const nextStatus = providerStatus === 'success' || providerStatus === 'ok' ? 'paid'
    : providerStatus === 'error' ? 'failed' : 'processing';
  if (payout.status !== 'paid') {
    db.prepare('UPDATE payouts SET status=?, provider_payment_id=COALESCE(NULLIF(?,\'\'), provider_payment_id), provider_status=?, updated_at=?, paid_at=CASE WHEN ?=\'paid\' THEN COALESCE(paid_at, ?) ELSE paid_at END WHERE order_id=?')
      .run(nextStatus, String(data.pg_payment_id || ''), providerStatus.slice(0, 80), nowIso(), nextStatus, nowIso(), payout.order_id);
  }
  audit(`payout.callback_${nextStatus}`, payout.order_id, { providerStatus });
  res.status(200).type('text/plain').send('OK');
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ready: HAS_PERSISTENT_STORAGE && providerConfigReady(), service: 'PayPortal KZ', time: nowIso(), mode: MODE, persistentStorage: HAS_PERSISTENT_STORAGE });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled request error:', err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Сервер қатесі. Сервер журналын тексеріңіз.' });
});

// Normal Node.js host: start a persistent HTTP server. Netlify Functions import
// this module, so do not call listen() when the module is required by a function.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PayPortal KZ listening on http://localhost:${PORT}`);
    console.log(`Mode: ${MODE}. Payment API configured: ${providerConfigReady()}. Payouts enabled: ${payoutFeatureAvailable()}.`);
  });
}

module.exports = app;
