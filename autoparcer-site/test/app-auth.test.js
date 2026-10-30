'use strict';

const assert = require('node:assert/strict');
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

test('desktop API authenticates users, reports subscription expiry and revokes tokens', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'autoparcer-app-auth-'));
  const databasePath = path.join(dataDirectory, 'accounts.sqlite');
  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const serverPath = path.join(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: databasePath,
      NODE_ENV: 'test',
      PUBLIC_ORIGIN: origin
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
  const registration = await fetch(`${origin}/api/register`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      username: 'desktop.user',
      password: 'correct-horse-battery',
      acceptedTerms: true,
      personalDataConsent: true
    })
  });
  assert.equal(registration.status, 201);

  const crossOriginLogin = await fetch(`${origin}/api/app/login`, {
    method: 'POST',
    headers: {
      Origin: 'https://example.com',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ username: 'desktop.user', password: 'correct-horse-battery' })
  });
  assert.equal(crossOriginLogin.status, 403);

  const login = await fetch(`${origin}/api/app/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'desktop.user', password: 'correct-horse-battery' })
  });
  assert.equal(login.status, 200);
  const loginData = await login.json();
  assert.match(loginData.accessToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(loginData.user.subscription.active, false);
  assert.equal(loginData.user.subscription.expiresAt, null);

  const firstDeviceHeaders = { Authorization: `Bearer ${loginData.accessToken}` };
  const secondLogin = await fetch(`${origin}/api/app/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'desktop.user', password: 'correct-horse-battery' })
  });
  assert.equal(secondLogin.status, 200);
  const secondLoginData = await secondLogin.json();
  const replacedDeviceProfile = await fetch(`${origin}/api/app/me`, { headers: firstDeviceHeaders });
  assert.equal(replacedDeviceProfile.status, 401);
  assert.equal((await replacedDeviceProfile.json()).code, 'session_replaced');

  const websiteSessionProfile = await fetch(`${origin}/api/me`, {
    headers: { Cookie: registration.headers.get('set-cookie').split(';')[0] }
  });
  assert.equal(websiteSessionProfile.status, 200);
  assert.equal((await websiteSessionProfile.json()).user.username, 'desktop.user');

  const tokenHeaders = { Authorization: `Bearer ${secondLoginData.accessToken}` };
  const database = new DatabaseSync(databasePath);
  database.prepare('UPDATE users SET subscription_until = ? WHERE username = ?')
    .run(Date.now() + 24 * 60 * 60 * 1000, 'desktop.user');
  database.close();

  const activeProfile = await fetch(`${origin}/api/app/me`, { headers: tokenHeaders });
  assert.equal(activeProfile.status, 200);
  const activeUserData = await activeProfile.json();
  assert.equal(activeUserData.user.subscription.active, true);
  assert.ok(Date.parse(activeUserData.user.subscription.expiresAt) > Date.now());

  const expiredAt = Date.now() - 24 * 60 * 60 * 1000;
  const expiredDatabase = new DatabaseSync(databasePath);
  expiredDatabase.prepare('UPDATE users SET subscription_until = ? WHERE username = ?')
    .run(expiredAt, 'desktop.user');
  expiredDatabase.close();
  const expiredProfile = await fetch(`${origin}/api/app/me`, { headers: tokenHeaders });
  assert.equal(expiredProfile.status, 200);
  const expiredUserData = await expiredProfile.json();
  assert.equal(expiredUserData.user.subscription.active, false);
  assert.equal(Date.parse(expiredUserData.user.subscription.expiresAt), expiredAt);

  const logout = await fetch(`${origin}/api/app/logout`, {
    method: 'POST',
    headers: tokenHeaders
  });
  assert.equal(logout.status, 200);
  const revokedProfile = await fetch(`${origin}/api/app/me`, { headers: tokenHeaders });
  assert.equal(revokedProfile.status, 401);
});
