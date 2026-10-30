'use strict';

const { createServer } = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual
} = require('node:crypto');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const {
  ANNUAL_DISCOUNT_PERCENT,
  ANNUAL_SUBSCRIPTION_MONTHS,
  SUBSCRIPTION_DAYS,
  calculateAnnualPriceRub,
  calculateSubscriptionExpiry
} = require('./billing');

const scryptAsync = promisify(scrypt);
const PORT = Number.parseInt(process.env.PORT || '4175', 10);
const SUBSCRIPTION_PRICE_RUB = Number.parseInt(process.env.SUBSCRIPTION_PRICE_RUB || '990', 10);
const ANNUAL_PRICE_RUB = calculateAnnualPriceRub(SUBSCRIPTION_PRICE_RUB, ANNUAL_DISCOUNT_PERCENT);
const ADMIN_USERNAMES = new Set(
  (process.env.ADMIN_USERNAMES || '')
    .split(',')
    .map((username) => username.trim().toLowerCase())
    .filter(Boolean)
);
const ADMIN_PATH = (process.env.ADMIN_PATH || '').trim();
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REQUEST_BYTES = 16 * 1024;
const COOKIE_NAME = 'autoparcer_session';
const TERMS_VERSION = '1.2';
const PRIVACY_VERSION = '1.5';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATABASE_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'autoparcer.sqlite');
const APP_DOWNLOAD_PATH = process.env.APP_DOWNLOAD_PATH
  ? path.resolve(process.env.APP_DOWNLOAD_PATH)
  : '';

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT должен быть целым числом от 1 до 65535.');
}
if (!Number.isInteger(SUBSCRIPTION_PRICE_RUB) || SUBSCRIPTION_PRICE_RUB < 1) {
  throw new Error('SUBSCRIPTION_PRICE_RUB должен быть положительным целым числом.');
}
if (ADMIN_PATH && !/^\/[A-Za-z0-9_-]{32,128}$/.test(ADMIN_PATH)) {
  throw new Error('ADMIN_PATH должен начинаться с / и содержать от 32 до 128 случайных символов.');
}

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
const db = new DatabaseSync(DATABASE_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    subscription_until INTEGER NOT NULL DEFAULT 0,
    subscription_plan TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_sessions (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    provider_payment_id TEXT NOT NULL UNIQUE,
    amount_kopecks INTEGER NOT NULL,
    plan_code TEXT NOT NULL DEFAULT 'monthly',
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    paid_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS user_consents (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_type TEXT NOT NULL,
    document_version TEXT NOT NULL,
    accepted_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, document_type, document_version)
  );

  CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS payments_user_id_idx ON payments(user_id);
`);

let userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
if (!userColumns.has('username') && userColumns.has('email')) {
  db.exec('ALTER TABLE users RENAME COLUMN email TO username');
  userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
}
if (!userColumns.has('username')) {
  throw new Error('Схема таблицы users не содержит поля username или email.');
}
if (!userColumns.has('subscription_plan')) {
  db.exec('ALTER TABLE users ADD COLUMN subscription_plan TEXT');
}
const paymentColumns = new Set(db.prepare('PRAGMA table_info(payments)').all().map((column) => column.name));
if (!paymentColumns.has('plan_code')) {
  db.exec("ALTER TABLE payments ADD COLUMN plan_code TEXT NOT NULL DEFAULT 'monthly'");
}
const paymentUserColumn = db.prepare('PRAGMA table_info(payments)').all()
  .find((column) => column.name === 'user_id');
const paymentUserForeignKey = db.prepare('PRAGMA foreign_key_list(payments)').all()
  .find((foreignKey) => foreignKey.table === 'users' && foreignKey.from === 'user_id');
if (
  paymentUserColumn.notnull ||
  !paymentUserForeignKey ||
  paymentUserForeignKey.on_delete !== 'SET NULL'
) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE payments_with_nullable_user (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        provider_payment_id TEXT NOT NULL UNIQUE,
        amount_kopecks INTEGER NOT NULL,
        plan_code TEXT NOT NULL DEFAULT 'monthly',
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        paid_at INTEGER
      );

      INSERT INTO payments_with_nullable_user (
        id, user_id, provider_payment_id, amount_kopecks, plan_code, status, created_at, paid_at
      )
      SELECT id, user_id, provider_payment_id, amount_kopecks, plan_code, status, created_at, paid_at
      FROM payments;

      DROP TABLE payments;
      ALTER TABLE payments_with_nullable_user RENAME TO payments;
      CREATE INDEX payments_user_id_idx ON payments(user_id);
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const rateLimits = new Map();

function jsonResponse(response, status, data, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(JSON.stringify(data));
}

function securityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
}

function parseCookies(request) {
  const header = request.headers.cookie || '';
  return Object.fromEntries(header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return ['', ''];
    return [
      part.slice(0, separator).trim(),
      part.slice(separator + 1).trim()
    ];
  }).filter(([key]) => key));
}

function cookieOptions(maxAge) {
  const secure = process.env.NODE_ENV === 'production' ||
    (process.env.PUBLIC_ORIGIN || '').startsWith('https://');
  return [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    ...(secure ? ['Secure'] : [])
  ].join('; ');
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) throw new HttpError(403, 'Запрос отклонён.', 'origin_required');

  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new HttpError(403, 'Запрос отклонён.', 'invalid_origin');
  }

  const forwardedProtocol = request.headers['x-forwarded-proto'];
  const requestProtocol = forwardedProtocol
    ? forwardedProtocol.split(',')[0].trim()
    : (request.socket.encrypted ? 'https' : 'http');
  const requestOrigin = `${requestProtocol}://${request.headers.host}`;
  const expectedOrigin = process.env.PUBLIC_ORIGIN
    ? new URL(process.env.PUBLIC_ORIGIN).origin
    : requestOrigin;

  if (originUrl.origin !== expectedOrigin || originUrl.origin !== requestOrigin) {
    throw new HttpError(403, 'Запрос отклонён.', 'origin_mismatch');
  }
}

function assertDesktopApiRequest(request) {
  if (request.headers.origin || request.headers.referer) {
    throw new HttpError(403, 'Запрос приложения отклонён.', 'desktop_origin_forbidden');
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new HttpError(413, 'Слишком большой запрос.', 'body_too_large');
    }
    chunks.push(chunk);
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected an object.');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'Некорректные данные запроса.', 'invalid_json');
  }
}

function checkRateLimit(request, action) {
  const forwardedFor = request.headers['x-forwarded-for'];
  const address = process.env.TRUST_PROXY === 'true' && forwardedFor
    ? forwardedFor.split(',')[0].trim()
    : request.socket.remoteAddress || 'unknown';
  const key = `${action}:${address}`;
  const now = Date.now();
  const limit = rateLimits.get(key);
  if (!limit || now - limit.startedAt >= 10 * 60 * 1000) {
    rateLimits.set(key, { startedAt: now, count: 1 });
    return;
  }
  limit.count += 1;
  if (limit.count > 10) {
    throw new HttpError(429, 'Слишком много попыток. Попробуйте позже.', 'rate_limited');
  }
}

function validateUsername(value) {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Введите логин.', 'invalid_username');
  }
  const username = value.trim().toLowerCase();
  if (!/^[a-zа-яё0-9][a-zа-яё0-9._-]{2,31}$/u.test(username)) {
    throw new HttpError(400, 'Логин должен содержать от 3 до 32 букв, цифр, точек, дефисов или подчёркиваний.', 'invalid_username');
  }
  return username;
}

function normalizeLogin(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Введите логин.', 'invalid_username');
  const login = value.trim().toLowerCase();
  const isUsername = /^[a-zа-яё0-9][a-zа-яё0-9._-]{2,31}$/u.test(login);
  const isLegacyEmail = login.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login);
  if (!isUsername && !isLegacyEmail) {
    throw new HttpError(400, 'Введите логин.', 'invalid_username');
  }
  return login;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) {
    throw new HttpError(400, 'Пароль должен содержать от 10 до 128 символов.', 'invalid_password');
  }
  return value;
}

function validateReceiptEmail(value) {
  if (
    typeof value !== 'string' ||
    value.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  ) {
    throw new HttpError(400, 'Введите корректный email для получения чека.', 'invalid_receipt_email');
  }
  return value.trim();
}

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt, hash: Buffer.from(hash).toString('hex') };
}

async function verifyPassword(password, salt, expectedHash) {
  const actualHash = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  const actual = Buffer.from(actualHash);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function createSessionToken(userId) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + SESSION_DURATION_MS;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hashSessionToken(token), userId, expiresAt, now);
  return token;
}

function createAppSessionToken(userId) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashSessionToken(token);
  const now = Date.now();
  const expiresAt = now + SESSION_DURATION_MS;
  db.exec('BEGIN IMMEDIATE');
  try {
    const previousSession = db.prepare('SELECT token_hash FROM app_sessions WHERE user_id = ?')
      .get(userId);
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, userId, expiresAt, now);
    db.prepare(`
      INSERT INTO app_sessions (user_id, token_hash, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at
    `).run(userId, tokenHash, now);
    if (previousSession) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(previousSession.token_hash);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return token;
}

function issueSession(response, userId) {
  const token = createSessionToken(userId);
  const secure = process.env.NODE_ENV === 'production' ||
    (process.env.PUBLIC_ORIGIN || '').startsWith('https://');
  response.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}`,
    ...(secure ? ['Secure'] : [])
  ].join('; '));
}

function currentUser(request) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token) return null;

  const tokenHash = hashSessionToken(token);
  const now = Date.now();
  const session = db.prepare(`
    SELECT users.id, users.username, users.subscription_until, users.subscription_plan
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(tokenHash, now);

  if (!session) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return session;
}

function requireUser(request) {
  const user = currentUser(request);
  if (!user) throw new HttpError(401, 'Войдите в аккаунт, чтобы продолжить.', 'authentication_required');
  return user;
}

function isAdminUser(user) {
  return ADMIN_USERNAMES.has(user.username.toLowerCase());
}

function requireAdmin(request) {
  const user = requireUser(request);
  if (!isAdminUser(user)) {
    throw new HttpError(403, 'Доступ к панели управления запрещён.', 'admin_required');
  }
  return user;
}

function publicUser(user) {
  const active = user.subscription_until > Date.now();
  return {
    username: user.username,
    subscription: {
      active,
      expiresAt: active ? new Date(user.subscription_until).toISOString() : null,
      plan: active ? user.subscription_plan : null
    }
  };
}

function appPublicUser(user) {
  const active = user.subscription_until > Date.now();
  return {
    username: user.username,
    subscription: {
      active,
      expiresAt: user.subscription_until > 0
        ? new Date(user.subscription_until).toISOString()
        : null,
      plan: user.subscription_plan
    }
  };
}

function appApiToken(request) {
  const authorization = request.headers.authorization || '';
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  return match ? match[1] : '';
}

function appApiUser(request) {
  const token = appApiToken(request);
  if (!token) return null;

  const tokenHash = hashSessionToken(token);
  const now = Date.now();
  const user = db.prepare(`
    SELECT users.id, users.username, users.subscription_until, users.subscription_plan
    FROM app_sessions
    JOIN sessions ON sessions.token_hash = app_sessions.token_hash
    JOIN users ON users.id = app_sessions.user_id
    WHERE app_sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(tokenHash, now);
  if (!user) {
    const expiredSession = db.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at <= ?')
      .get(tokenHash, now);
    if (expiredSession) {
      db.prepare('DELETE FROM app_sessions WHERE token_hash = ?').run(tokenHash);
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    }
    return null;
  }
  return user;
}

function requireAppApiUser(request) {
  const user = appApiUser(request);
  if (!user) {
    throw new HttpError(
      401,
      'Сеанс приложения завершён или аккаунт запущен на другом компьютере. Войдите снова.',
      'session_replaced'
    );
  }
  return user;
}

function getSubscriptionPlan(planCode) {
  if (planCode === 'monthly') {
    return {
      code: 'monthly',
      priceRub: SUBSCRIPTION_PRICE_RUB,
      description: `${SUBSCRIPTION_DAYS} дней`
    };
  }
  if (planCode === 'annual') {
    return {
      code: 'annual',
      priceRub: ANNUAL_PRICE_RUB,
      description: `${ANNUAL_SUBSCRIPTION_MONTHS} месяцев`
    };
  }
  throw new HttpError(400, 'Выберите доступный тариф.', 'invalid_plan');
}

function getYooKassaCredentials() {
  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secretKey = process.env.YOOKASSA_SECRET_KEY;
  const publicOrigin = process.env.PUBLIC_ORIGIN;
  if (!shopId || !secretKey || !publicOrigin) {
    throw new HttpError(503, 'Платёжный сервис ещё не подключён.', 'payments_not_configured');
  }
  let parsedOrigin;
  try {
    parsedOrigin = new URL(publicOrigin);
  } catch {
    throw new HttpError(503, 'Проверьте настройку PUBLIC_ORIGIN.', 'invalid_public_origin');
  }
  if (parsedOrigin.protocol !== 'https:' && parsedOrigin.hostname !== 'localhost') {
    throw new HttpError(503, 'Для приёма платежей нужен HTTPS-адрес сайта.', 'https_required');
  }
  return { shopId, secretKey, publicOrigin: parsedOrigin.origin };
}

function yooKassaAuthorization(shopId, secretKey) {
  return `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`;
}

async function createYooKassaPayment(user, plan, receiptEmail, request, response) {
  const { shopId, secretKey, publicOrigin } = getYooKassaCredentials();
  assertSameOrigin(request);

  const idempotenceKey = randomUUID();
  const paymentResponse = await fetch('https://api.yookassa.ru/v3/payments', {
    method: 'POST',
    headers: {
      Authorization: yooKassaAuthorization(shopId, secretKey),
      'Content-Type': 'application/json',
      'Idempotence-Key': idempotenceKey
    },
    body: JSON.stringify({
      amount: {
        value: `${plan.priceRub}.00`,
        currency: 'RUB'
      },
      capture: true,
      confirmation: {
        type: 'redirect',
        return_url: `${publicOrigin}/profile.html?payment=return`
      },
      description: `Autoparcer — доступ на ${plan.description}`,
      metadata: { user_id: String(user.id), plan_code: plan.code },
      receipt: {
        customer: { email: receiptEmail },
        items: [{
          description: `Подписка Autoparcer — ${plan.description}`,
          quantity: '1.000',
          amount: {
            value: `${plan.priceRub}.00`,
            currency: 'RUB'
          },
          vat_code: 1,
          payment_mode: 'full_prepayment',
          payment_subject: 'service'
        }],
        internet: 'true'
      }
    })
  });

  if (!paymentResponse.ok) {
    const errorText = await paymentResponse.text();
    let errorPayload = {};
    try {
      errorPayload = JSON.parse(errorText);
    } catch {
      errorPayload = {};
    }
    const errorDetails = {};
    for (const field of ['code', 'description', 'parameter']) {
      if (typeof errorPayload[field] === 'string') {
        errorDetails[field] = errorPayload[field].slice(0, 300);
      }
    }
    console.error(
      `YooKassa payment creation failed with HTTP ${paymentResponse.status}: ${JSON.stringify(errorDetails)}`
    );
    throw new HttpError(502, 'Не удалось создать платёж. Попробуйте позже.', 'payment_creation_failed');
  }

  const payment = await paymentResponse.json();
  const confirmationUrl = payment.confirmation && payment.confirmation.confirmation_url;
  if (!payment.id || !confirmationUrl || payment.status !== 'pending') {
    console.error('YooKassa returned an incomplete payment response.');
    throw new HttpError(502, 'Платёжный сервис вернул некорректный ответ.', 'invalid_payment_response');
  }

  db.prepare(`
    INSERT INTO payments (user_id, provider_payment_id, amount_kopecks, plan_code, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(user.id, payment.id, plan.priceRub * 100, plan.code, Date.now());

  jsonResponse(response, 200, { confirmationUrl });
}

async function verifyYooKassaPayment(paymentId) {
  const { shopId, secretKey } = getYooKassaCredentials();
  const paymentResponse = await fetch(
    `https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`,
    { headers: { Authorization: yooKassaAuthorization(shopId, secretKey) } }
  );
  if (!paymentResponse.ok) {
    console.error(`YooKassa payment verification failed with HTTP ${paymentResponse.status}.`);
    throw new HttpError(502, 'Не удалось проверить платёж.', 'payment_verification_failed');
  }
  return paymentResponse.json();
}

function amountToKopecks(value) {
  if (typeof value !== 'string' || !/^\d+\.\d{2}$/.test(value)) return null;
  const [rubles, kopecks] = value.split('.');
  return Number(rubles) * 100 + Number(kopecks);
}

function activateSubscription(payment) {
  const now = Date.now();
  db.exec('BEGIN');
  let transactionActive = true;
  try {
    const record = db.prepare(`
      SELECT id, user_id, amount_kopecks, plan_code, status
      FROM payments
      WHERE provider_payment_id = ?
    `).get(payment.id);

    if (!record) {
      db.exec('ROLLBACK');
      transactionActive = false;
      return false;
    }
    if (record.status === 'paid') {
      db.exec('COMMIT');
      transactionActive = false;
      return true;
    }

    const verifiedUserId = payment.metadata && payment.metadata.user_id;
    const verifiedPlanCode = payment.metadata && payment.metadata.plan_code;
    if (
      payment.status !== 'succeeded' ||
      !payment.amount ||
      payment.amount.currency !== 'RUB' ||
      amountToKopecks(payment.amount.value) !== record.amount_kopecks ||
      (record.user_id !== null && String(verifiedUserId) !== String(record.user_id)) ||
      (verifiedPlanCode !== undefined && verifiedPlanCode !== record.plan_code)
    ) {
      db.exec('ROLLBACK');
      transactionActive = false;
      throw new HttpError(400, 'Параметры подтверждённого платежа не совпали.', 'payment_mismatch');
    }

    if (record.plan_code !== 'monthly' && record.plan_code !== 'annual') {
      db.exec('ROLLBACK');
      transactionActive = false;
      throw new HttpError(400, 'Неизвестный срок подписки.', 'invalid_payment_plan');
    }
    if (record.user_id === null) {
      db.prepare("UPDATE payments SET status = 'paid', paid_at = ? WHERE id = ?")
        .run(now, record.id);
      db.exec('COMMIT');
      transactionActive = false;
      return true;
    }
    const user = db.prepare('SELECT subscription_until FROM users WHERE id = ?').get(record.user_id);
    if (!user) {
      db.exec('ROLLBACK');
      transactionActive = false;
      throw new HttpError(404, 'Аккаунт платежа не найден.', 'payment_user_missing');
    }

    const subscriptionUntil = calculateSubscriptionExpiry(
      user.subscription_until,
      now,
      record.plan_code
    );
    db.prepare('UPDATE users SET subscription_until = ?, subscription_plan = ? WHERE id = ?')
      .run(subscriptionUntil, record.plan_code, record.user_id);
    db.prepare("UPDATE payments SET status = 'paid', paid_at = ? WHERE id = ?")
      .run(now, record.id);
    db.exec('COMMIT');
    transactionActive = false;
    return true;
  } catch (error) {
    if (transactionActive) db.exec('ROLLBACK');
    throw error;
  }
}

async function handleYooKassaWebhook(request, response) {
  const payload = await readJson(request);
  const paymentId = payload.object && payload.object.id;
  if (typeof paymentId !== 'string' || !paymentId) {
    throw new HttpError(400, 'В уведомлении не найден номер платежа.', 'invalid_webhook');
  }

  const record = db.prepare('SELECT provider_payment_id FROM payments WHERE provider_payment_id = ?')
    .get(paymentId);
  if (!record) {
    jsonResponse(response, 200, { received: true });
    return;
  }

  const payment = await verifyYooKassaPayment(paymentId);
  if (payload.event === 'payment.succeeded' && payment.status === 'succeeded') {
    activateSubscription(payment);
  } else if (payment.status === 'canceled') {
    db.prepare("UPDATE payments SET status = 'canceled' WHERE provider_payment_id = ? AND status = 'pending'")
      .run(paymentId);
  }
  jsonResponse(response, 200, { received: true });
}

function applicationDownloadUrl() {
  try {
    const url = new URL(process.env.APP_DOWNLOAD_URL || '');
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

async function sendApplicationInstaller(response) {
  let fileStats;
  try {
    fileStats = await fs.promises.stat(APP_DOWNLOAD_PATH);
  } catch (error) {
    console.error('Configured application installer could not be accessed.', error);
    throw new HttpError(503, 'Установщик пока недоступен.', 'download_unavailable');
  }
  if (!fileStats.isFile()) {
    throw new HttpError(503, 'Установщик пока недоступен.', 'download_unavailable');
  }

  const filename = path.basename(APP_DOWNLOAD_PATH).replace(/["\\]/g, '_');
  response.writeHead(200, {
    'Content-Type': 'application/vnd.microsoft.portable-executable',
    'Content-Length': fileStats.size,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'private, no-store'
  });
  await pipeline(fs.createReadStream(APP_DOWNLOAD_PATH), response);
}

function apiConfiguration() {
  return {
    priceRub: SUBSCRIPTION_PRICE_RUB,
    subscriptionDays: SUBSCRIPTION_DAYS,
    annualPriceRub: ANNUAL_PRICE_RUB,
    annualMonths: ANNUAL_SUBSCRIPTION_MONTHS,
    annualDiscountPercent: ANNUAL_DISCOUNT_PERCENT,
    downloadAvailable: Boolean(APP_DOWNLOAD_PATH || applicationDownloadUrl())
  };
}

async function handleRequest(request, response) {
  securityHeaders(response);
  const requestUrl = new URL(request.url, 'http://localhost');
  const route = `${request.method} ${requestUrl.pathname}`;

  if (route === 'GET /api/health') {
    jsonResponse(response, 200, { status: 'ok' });
    return;
  }
  if (route === 'GET /api/config') {
    jsonResponse(response, 200, apiConfiguration());
    return;
  }
  if (route === 'GET /download') {
    const user = currentUser(request);
    const downloadUrl = applicationDownloadUrl();
    if (!user) {
      response.writeHead(302, { Location: '/?login=1&next=download', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (user.subscription_until <= Date.now()) {
      response.writeHead(302, { Location: '/profile.html', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (APP_DOWNLOAD_PATH) {
      await sendApplicationInstaller(response);
      return;
    }
    response.writeHead(302, {
      Location: downloadUrl || '/profile.html',
      'Cache-Control': 'no-store'
    });
    response.end();
    return;
  }
  if (route === 'GET /api/me') {
    const user = currentUser(request);
    jsonResponse(response, 200, { user: user ? publicUser(user) : null });
    return;
  }
  if (route === 'GET /api/admin/users') {
    requireAdmin(request);
    const query = requestUrl.searchParams.get('q')?.trim().toLowerCase() || '';
    const limit = Number(requestUrl.searchParams.get('limit') || 50);
    const offset = Number(requestUrl.searchParams.get('offset') || 0);
    if (query.length > 80) {
      throw new HttpError(400, 'Поисковый запрос слишком длинный.', 'invalid_search');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HttpError(400, 'Некорректный размер страницы.', 'invalid_limit');
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new HttpError(400, 'Некорректный номер страницы.', 'invalid_offset');
    }
    const total = db.prepare(`
      SELECT COUNT(*) AS count
      FROM users
      WHERE ? = '' OR instr(lower(username), ?) > 0
    `).get(query, query).count;
    const users = db.prepare(`
      SELECT id, username, created_at, subscription_until, subscription_plan
      FROM users
      WHERE ? = '' OR instr(lower(username), ?) > 0
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(query, query, limit, offset).map((user) => ({
      id: user.id,
      username: user.username,
      createdAt: new Date(user.created_at).toISOString(),
      subscription: {
        active: user.subscription_until > Date.now(),
        expiresAt: user.subscription_until > 0
          ? new Date(user.subscription_until).toISOString()
          : null,
        plan: user.subscription_plan
      },
      admin: isAdminUser(user)
    }));
    jsonResponse(response, 200, { users, total, limit, offset });
    return;
  }
  const grantSubscriptionMatch = requestUrl.pathname.match(/^\/api\/admin\/users\/([1-9]\d*)\/subscription$/);
  if (request.method === 'POST' && grantSubscriptionMatch) {
    assertSameOrigin(request);
    requireAdmin(request);
    const userId = Number(grantSubscriptionMatch[1]);
    if (!Number.isSafeInteger(userId)) {
      throw new HttpError(400, 'Некорректный аккаунт.', 'invalid_user_id');
    }
    const body = await readJson(request);
    if (!Number.isInteger(body.days) || body.days < 1 || body.days > 3650) {
      throw new HttpError(400, 'Укажите срок подписки от 1 до 3650 дней.', 'invalid_subscription_days');
    }
    const target = db.prepare('SELECT subscription_until FROM users WHERE id = ?').get(userId);
    if (!target) throw new HttpError(404, 'Аккаунт не найден.', 'account_not_found');
    const subscriptionUntil = Math.max(Date.now(), target.subscription_until) + body.days * 24 * 60 * 60 * 1000;
    db.prepare("UPDATE users SET subscription_until = ?, subscription_plan = 'admin' WHERE id = ?")
      .run(subscriptionUntil, userId);
    jsonResponse(response, 200, {
      success: true,
      subscription: { active: true, expiresAt: new Date(subscriptionUntil).toISOString(), plan: 'admin' }
    });
    return;
  }
  const revokeSubscriptionMatch = requestUrl.pathname.match(/^\/api\/admin\/users\/([1-9]\d*)\/subscription\/revoke$/);
  if (request.method === 'POST' && revokeSubscriptionMatch) {
    assertSameOrigin(request);
    requireAdmin(request);
    const userId = Number(revokeSubscriptionMatch[1]);
    if (!Number.isSafeInteger(userId)) {
      throw new HttpError(400, 'Некорректный аккаунт.', 'invalid_user_id');
    }
    const result = db.prepare('UPDATE users SET subscription_until = 0, subscription_plan = NULL WHERE id = ?')
      .run(userId);
    if (result.changes === 0) throw new HttpError(404, 'Аккаунт не найден.', 'account_not_found');
    jsonResponse(response, 200, { success: true });
    return;
  }
  const deleteUserMatch = requestUrl.pathname.match(/^\/api\/admin\/users\/([1-9]\d*)$/);
  if (request.method === 'DELETE' && deleteUserMatch) {
    assertSameOrigin(request);
    const admin = requireAdmin(request);
    const userId = Number(deleteUserMatch[1]);
    if (!Number.isSafeInteger(userId)) {
      throw new HttpError(400, 'Некорректный аккаунт.', 'invalid_user_id');
    }
    const target = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
    if (!target) throw new HttpError(404, 'Аккаунт не найден.', 'account_not_found');
    if (userId === admin.id || isAdminUser(target)) {
      throw new HttpError(400, 'Администраторские аккаунты нельзя удалить из панели.', 'admin_account_protected');
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    jsonResponse(response, 200, { success: true });
    return;
  }
  if (route === 'POST /api/app/login') {
    assertDesktopApiRequest(request);
    checkRateLimit(request, 'login');
    const body = await readJson(request);
    const username = normalizeLogin(body.username);
    if (typeof body.password !== 'string' || body.password.length > 128) {
      throw new HttpError(401, 'Логин или пароль указаны неверно.', 'invalid_credentials');
    }
    const user = db.prepare(`
      SELECT id, username, password_salt, password_hash, subscription_until, subscription_plan
      FROM users
      WHERE username = ?
    `).get(username);
    const salt = user ? user.password_salt : 'autoparcer-invalid-user-salt';
    const hash = user ? user.password_hash : '0'.repeat(128);
    const passwordMatches = await verifyPassword(body.password, salt, hash);
    if (!user || !passwordMatches) {
      throw new HttpError(401, 'Логин или пароль указаны неверно.', 'invalid_credentials');
    }
    const accessToken = createAppSessionToken(user.id);
    jsonResponse(response, 200, { accessToken, user: appPublicUser(user) });
    return;
  }
  if (route === 'GET /api/app/me') {
    assertDesktopApiRequest(request);
    const user = requireAppApiUser(request);
    jsonResponse(response, 200, { user: appPublicUser(user) });
    return;
  }
  if (route === 'POST /api/app/logout') {
    assertDesktopApiRequest(request);
    const user = requireAppApiUser(request);
    const tokenHash = hashSessionToken(appApiToken(request));
    db.prepare('DELETE FROM app_sessions WHERE user_id = ? AND token_hash = ?')
      .run(user.id, tokenHash);
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    jsonResponse(response, 200, { success: true });
    return;
  }
  if (route === 'POST /api/register') {
    assertSameOrigin(request);
    checkRateLimit(request, 'register');
    const body = await readJson(request);
    const username = validateUsername(body.username);
    if (ADMIN_USERNAMES.has(username.toLowerCase())) {
      throw new HttpError(
        409,
        'Этот логин зарезервирован для администратора. Сначала зарегистрируйте аккаунт, затем укажите его в ADMIN_USERNAMES.',
        'admin_username_reserved'
      );
    }
    const password = validatePassword(body.password);
    if (body.acceptedTerms !== true || body.personalDataConsent !== true) {
      throw new HttpError(400, 'Для регистрации примите условия и дайте согласие на обработку персональных данных.', 'consent_required');
    }
    const credentials = await hashPassword(password);
    let result;
    const createdAt = Date.now();
    db.exec('BEGIN');
    let transactionActive = true;
    try {
      result = db.prepare(`
        INSERT INTO users (username, password_salt, password_hash, created_at)
        VALUES (?, ?, ?, ?)
      `).run(username, credentials.salt, credentials.hash, createdAt);
      const userId = Number(result.lastInsertRowid);
      const saveConsent = db.prepare(`
        INSERT INTO user_consents (user_id, document_type, document_version, accepted_at)
        VALUES (?, ?, ?, ?)
      `);
      saveConsent.run(userId, 'terms', TERMS_VERSION, createdAt);
      saveConsent.run(userId, 'personal-data', PRIVACY_VERSION, createdAt);
      db.exec('COMMIT');
      transactionActive = false;
    } catch (error) {
      if (transactionActive) db.exec('ROLLBACK');
      if (
        error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        error.message.includes('UNIQUE constraint failed: users.username')
      ) {
        throw new HttpError(409, 'Этот логин уже занят.', 'username_already_registered');
      }
      throw error;
    }
    issueSession(response, Number(result.lastInsertRowid));
    jsonResponse(response, 201, { user: { username, subscription: { active: false, expiresAt: null } } });
    return;
  }
  if (route === 'POST /api/login') {
    assertSameOrigin(request);
    checkRateLimit(request, 'login');
    const body = await readJson(request);
    const username = normalizeLogin(body.username);
    if (typeof body.password !== 'string' || body.password.length > 128) {
      throw new HttpError(401, 'Логин или пароль указаны неверно.', 'invalid_credentials');
    }
    const user = db.prepare('SELECT id, username, password_salt, password_hash, subscription_until, subscription_plan FROM users WHERE username = ?')
      .get(username);
    const salt = user ? user.password_salt : 'autoparcer-invalid-user-salt';
    const hash = user ? user.password_hash : '0'.repeat(128);
    const passwordMatches = await verifyPassword(body.password, salt, hash);
    if (!user || !passwordMatches) {
      throw new HttpError(401, 'Логин или пароль указаны неверно.', 'invalid_credentials');
    }
    issueSession(response, user.id);
    jsonResponse(response, 200, { user: publicUser(user) });
    return;
  }
  if (route === 'POST /api/password') {
    assertSameOrigin(request);
    checkRateLimit(request, 'password-change');
    const user = requireUser(request);
    const body = await readJson(request);
    if (typeof body.currentPassword !== 'string' || body.currentPassword.length > 128) {
      throw new HttpError(400, 'Введите текущий пароль.', 'current_password_required');
    }
    const newPassword = validatePassword(body.newPassword);
    const storedCredentials = db.prepare('SELECT password_salt, password_hash FROM users WHERE id = ?')
      .get(user.id);
    if (!storedCredentials) {
      throw new HttpError(404, 'Аккаунт не найден.', 'account_not_found');
    }
    const currentPasswordMatches = await verifyPassword(
      body.currentPassword,
      storedCredentials.password_salt,
      storedCredentials.password_hash
    );
    if (!currentPasswordMatches) {
      throw new HttpError(400, 'Текущий пароль указан неверно.', 'invalid_current_password');
    }

    const credentials = await hashPassword(newPassword);
    const token = parseCookies(request)[COOKIE_NAME];
    const currentTokenHash = hashSessionToken(token);
    db.exec('BEGIN');
    let transactionActive = true;
    try {
      db.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?')
        .run(credentials.salt, credentials.hash, user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
        .run(user.id, currentTokenHash);
      db.exec('COMMIT');
      transactionActive = false;
    } catch (error) {
      if (transactionActive) db.exec('ROLLBACK');
      throw error;
    }
    jsonResponse(response, 200, { success: true });
    return;
  }
  if (route === 'POST /api/logout') {
    assertSameOrigin(request);
    const token = parseCookies(request)[COOKIE_NAME];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashSessionToken(token));
    response.setHeader('Set-Cookie', cookieOptions(0));
    jsonResponse(response, 200, { success: true });
    return;
  }
  if (route === 'POST /api/checkout') {
    const user = requireUser(request);
    const body = await readJson(request);
    const plan = getSubscriptionPlan(body.plan);
    const receiptEmail = validateReceiptEmail(body.receiptEmail);
    await createYooKassaPayment(user, plan, receiptEmail, request, response);
    return;
  }
  if (route === 'POST /api/yookassa/webhook') {
    await handleYooKassaWebhook(request, response);
    return;
  }

  if (request.method === 'GET' && !requestUrl.pathname.startsWith('/api/')) {
    if (ADMIN_PATH && requestUrl.pathname === ADMIN_PATH) {
      const user = currentUser(request);
      if (!user || !isAdminUser(user)) {
        throw new HttpError(404, 'Страница не найдена.', 'not_found');
      }
      const contents = await fs.promises.readFile(path.join(PUBLIC_DIR, 'admin.html'));
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      response.end(contents);
      return;
    }
    const staticFiles = {
      '/': ['index.html', 'text/html; charset=utf-8'],
      '/index.html': ['index.html', 'text/html; charset=utf-8'],
      '/profile.html': ['profile.html', 'text/html; charset=utf-8'],
      '/privacy.html': ['privacy.html', 'text/html; charset=utf-8'],
      '/terms.html': ['terms.html', 'text/html; charset=utf-8'],
      '/site.css': ['site.css', 'text/css; charset=utf-8'],
      '/admin.css': ['admin.css', 'text/css; charset=utf-8'],
      '/site.js': ['site.js', 'text/javascript; charset=utf-8'],
      '/profile.js': ['profile.js', 'text/javascript; charset=utf-8'],
      '/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
      '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
    };
    const file = staticFiles[requestUrl.pathname];
    if (file) {
      const contents = await fs.promises.readFile(path.join(PUBLIC_DIR, file[0]));
      response.writeHead(200, {
        'Content-Type': file[1],
        'Cache-Control': file[0] === 'index.html' ? 'no-cache' : 'public, max-age=300'
      });
      response.end(contents);
      return;
    }
  }

  throw new HttpError(404, 'Страница не найдена.', 'not_found');
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error(error);
    jsonResponse(response, status, {
      error: error instanceof HttpError ? error.message : 'Внутренняя ошибка сервера.',
      code: error instanceof HttpError ? error.code : 'internal_error'
    });
  });
});

server.listen(PORT, () => {
  console.log(`Autoparcer site is listening on http://localhost:${PORT}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
