'use strict';

const assert = require('node:assert/strict');
const { scryptSync } = require('node:crypto');
const { createServer } = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');

async function getFreePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Website server exited before becoming ready.');
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      await delay(100);
    }
  }
  throw new Error('Website server did not become ready in time.');
}

async function register(origin, username) {
  const response = await fetch(`${origin}/api/register`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      username,
      password: 'correct-horse-battery',
      acceptedTerms: true,
      personalDataConsent: true
    })
  });
  assert.equal(response.status, 201);
  return response.headers.get('set-cookie').split(';')[0];
}

async function api(origin, route, { cookie, method = 'GET', body, requestOrigin = origin } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (requestOrigin) headers.Origin = requestOrigin;
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(`${origin}${route}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

test('admin panel protects access, manages subscriptions and anonymizes deleted accounts', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'autoparcer-admin-'));
  const databasePath = path.join(dataDirectory, 'accounts.sqlite');
  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;

  const legacyDatabase = new DatabaseSync(databasePath);
  legacyDatabase.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      subscription_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      provider_payment_id TEXT NOT NULL UNIQUE,
      amount_kopecks INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      paid_at INTEGER
    );
    INSERT INTO users (username, password_salt, password_hash, created_at)
    VALUES ('legacy.user', 'legacy-salt', 'legacy-hash', 1000);
    INSERT INTO payments (user_id, provider_payment_id, amount_kopecks, status, created_at)
    VALUES (1, 'legacy-payment', 99000, 'paid', 2000);
  `);
  const adminSalt = 'preexisting-admin-test-salt';
  const adminHash = scryptSync('correct-horse-battery', adminSalt, 64, { N: 16384, r: 8, p: 1 })
    .toString('hex');
  legacyDatabase.prepare(`
    INSERT INTO users (username, password_salt, password_hash, created_at)
    VALUES (?, ?, ?, ?)
  `).run('admin.user', adminSalt, adminHash, Date.now());
  legacyDatabase.close();

  const serverPath = path.join(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: databasePath,
      NODE_ENV: 'test',
      PUBLIC_ORIGIN: origin,
      ADMIN_USERNAMES: 'admin.user',
      ADMIN_PATH: '/manage-' + 'a'.repeat(64)
    },
    stdio: 'ignore'
  });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });

  await waitForHealth(origin, child);

  const database = new DatabaseSync(databasePath);
  const paymentUserColumn = database.prepare('PRAGMA table_info(payments)').all()
    .find((column) => column.name === 'user_id');
  const paymentUserForeignKey = database.prepare('PRAGMA foreign_key_list(payments)').all()
    .find((foreignKey) => foreignKey.table === 'users' && foreignKey.from === 'user_id');
  assert.equal(paymentUserColumn.notnull, 0);
  assert.equal(paymentUserForeignKey.on_delete, 'SET NULL');
  assert.equal(database.prepare('SELECT plan_code FROM payments WHERE provider_payment_id = ?')
    .get('legacy-payment').plan_code, 'monthly');
  database.close();

  assert.equal((await fetch(`${origin}/admin`)).status, 404);
  assert.equal((await fetch(`${origin}/admin.html`)).status, 404);

  const reservedAdminRegistration = await api(origin, '/api/register', {
    method: 'POST',
    body: {
      username: 'admin.user',
      password: 'correct-horse-battery',
      acceptedTerms: true,
      personalDataConsent: true
    }
  });
  assert.equal(reservedAdminRegistration.status, 409);
  assert.equal((await reservedAdminRegistration.json()).code, 'admin_username_reserved');
  const adminLogin = await api(origin, '/api/login', {
    method: 'POST',
    body: { username: 'admin.user', password: 'correct-horse-battery' }
  });
  assert.equal(adminLogin.status, 200);
  const adminCookie = adminLogin.headers.get('set-cookie').split(';')[0];
  const memberCookie = await register(origin, 'member.user');
  const adminPage = await api(origin, '/manage-' + 'a'.repeat(64), { cookie: adminCookie });
  assert.equal(adminPage.status, 200);
  assert.match(await adminPage.text(), /Аккаунты пользователей/);
  assert.equal((await fetch(`${origin}/admin.css`)).status, 200);
  assert.equal((await fetch(`${origin}/admin.js`)).status, 200);

  const deniedPanel = await api(origin, '/manage-' + 'a'.repeat(64), { cookie: memberCookie });
  assert.equal(deniedPanel.status, 404);
  const deniedList = await api(origin, '/api/admin/users', { cookie: memberCookie });
  assert.equal(deniedList.status, 403);
  const unauthenticatedList = await api(origin, '/api/admin/users');
  assert.equal(unauthenticatedList.status, 401);

  const userListResponse = await api(origin, '/api/admin/users?q=member');
  assert.equal(userListResponse.status, 401);
  const usersResponse = await api(origin, '/api/admin/users?q=member', { cookie: adminCookie });
  assert.equal(usersResponse.status, 200);
  const usersData = await usersResponse.json();
  assert.equal(usersData.total, 1);
  assert.equal(usersData.users[0].username, 'member.user');
  assert.equal('password_hash' in usersData.users[0], false);
  const memberId = usersData.users[0].id;

  const foreignOriginGrant = await api(origin, `/api/admin/users/${memberId}/subscription`, {
    cookie: adminCookie,
    method: 'POST',
    body: { days: 30 },
    requestOrigin: 'https://example.com'
  });
  assert.equal(foreignOriginGrant.status, 403);

  const futureExpiry = Date.now() + 2 * 24 * 60 * 60 * 1000;
  const beforeGrantDatabase = new DatabaseSync(databasePath);
  beforeGrantDatabase.prepare('UPDATE users SET subscription_until = ? WHERE id = ?')
    .run(futureExpiry, memberId);
  beforeGrantDatabase.close();
  const grant = await api(origin, `/api/admin/users/${memberId}/subscription`, {
    cookie: adminCookie,
    method: 'POST',
    body: { days: 30 }
  });
  assert.equal(grant.status, 200);
  const grantData = await grant.json();
  assert.equal(grantData.subscription.plan, 'admin');
  assert.ok(Date.parse(grantData.subscription.expiresAt) >= futureExpiry + 29 * 24 * 60 * 60 * 1000);

  const revoke = await api(origin, `/api/admin/users/${memberId}/subscription/revoke`, {
    cookie: adminCookie,
    method: 'POST'
  });
  assert.equal(revoke.status, 200);

  const adminUsers = await api(origin, '/api/admin/users?q=admin.user', { cookie: adminCookie });
  const adminId = (await adminUsers.json()).users[0].id;
  const protectedAdmin = await api(origin, `/api/admin/users/${adminId}`, {
    cookie: adminCookie,
    method: 'DELETE'
  });
  assert.equal(protectedAdmin.status, 400);

  const paymentDatabase = new DatabaseSync(databasePath);
  paymentDatabase.prepare(`
    INSERT INTO payments (user_id, provider_payment_id, amount_kopecks, plan_code, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(memberId, 'member-payment', 99000, 'monthly', 'paid', Date.now());
  paymentDatabase.close();

  const deleted = await api(origin, `/api/admin/users/${memberId}`, {
    cookie: adminCookie,
    method: 'DELETE'
  });
  assert.equal(deleted.status, 200);
  const deletedAccount = await api(origin, '/api/me', { cookie: memberCookie });
  assert.equal((await deletedAccount.json()).user, null);

  const verifyDatabase = new DatabaseSync(databasePath);
  assert.equal(
    verifyDatabase.prepare('SELECT user_id FROM payments WHERE provider_payment_id = ?')
      .get('member-payment').user_id,
    null
  );
  assert.deepEqual(verifyDatabase.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(verifyDatabase.prepare('SELECT COUNT(*) AS count FROM user_consents WHERE user_id = ?')
    .get(memberId).count, 0);
  verifyDatabase.close();
});
