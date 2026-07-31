import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8791';
const here = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(here, '../..');
const ACCOUNTS_FILE = path.join(here, '.accounts.json');
const ADMIN = { username: 'localadmin', password: 'Local-Admin-2026!', displayName: '本地管理员' };
const BOOTSTRAP_SECRET = 'local-bootstrap-secret';

const jar = new Map();

async function call(as, url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (jar.has(as)) headers.set('Cookie', jar.get(as));
  if (options.json) {
    headers.set('Content-Type', 'application/json');
    options.body = JSON.stringify(options.json);
  }
  const response = await fetch(BASE + url, { ...options, headers });
  const cookie = response.headers.get('set-cookie');
  if (cookie) jar.set(as, cookie.split(';')[0]);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${url} → ${response.status} ${data.message || ''}`);
  return data;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/bootstrap/status`);
      if (response.status < 500) return;
      // A 500 here means the tables are missing; the schema step below fixes it.
      return;
    } catch {
      await new Promise((resolve) => { setTimeout(resolve, 1000); });
    }
  }
  throw new Error('本地 wrangler dev 没有起来');
}

export default async function globalSetup() {
  execSync('npx wrangler d1 execute notebook-chat --local --file=schema.sql --persist-to .wrangler/test-state -y', {
    cwd: workerRoot,
    stdio: 'ignore',
    shell: true,
  });
  await waitForServer();

  const status = await call('admin', '/api/bootstrap/status');
  if (!status.ready) {
    await call('admin', '/api/bootstrap', {
      method: 'POST',
      headers: { 'x-bootstrap-secret': BOOTSTRAP_SECRET },
      json: ADMIN,
    });
  } else {
    await call('admin', '/api/login', { method: 'POST', json: ADMIN });
  }

  const suffix = Date.now().toString(36).slice(-5);
  const password = `Starpost-${suffix}-Pass!`;
  const people = [
    { key: 'alice', username: `alice_${suffix}`, displayName: '爱丽丝', password },
    { key: 'bob', username: `bob_${suffix}`, displayName: '鲍勃', password },
    { key: 'carol', username: `carol_${suffix}`, displayName: '卡罗尔', password },
  ];

  for (const person of people) {
    const invite = await call('admin', '/api/admin/invitations', {
      method: 'POST',
      json: { label: `e2e-${person.key}-${suffix}`, maxUses: 1, days: 1 },
    });
    const created = await call(person.key, '/api/register', {
      method: 'POST',
      json: {
        username: person.username,
        displayName: person.displayName,
        password: person.password,
        invite: invite.code,
      },
    });
    person.id = created.user.id;
  }

  const accounts = Object.fromEntries(people.map((person) => [person.key, person]));
  accounts.admin = ADMIN;
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
}
