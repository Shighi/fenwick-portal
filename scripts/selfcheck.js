'use strict';
// Self-check for the Fenwick Patient Portal. Starts the server on a spare port
// with a fixed configuration, runs checks with the built-in fetch, and exits
// non-zero if any check fails.

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const LOCK_THRESHOLD = 3;
const LOCK_MINUTES = 1;
const USERNAME = 'tomsmith';
const PASSWORD = 'SuperSecretPassword!';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startServer(port) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      LOCK_THRESHOLD: String(LOCK_THRESHOLD),
      LOCK_MINUTES: String(LOCK_MINUTES),
      FLAKY_BANNER: 'off',
      ENABLE_TEST_RESET: 'on',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start within 5 s')), 5000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('exit', (code) => reject(new Error(`Server exited early with code ${code}`)));
  });
}

// Minimal browser-like client: keeps cookies and follows redirects manually.
class Client {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }

  async request(method, pathname, form) {
    let url = new URL(pathname, this.base);
    let body = form ? new URLSearchParams(form).toString() : undefined;
    const hops = [];
    for (let i = 0; i < 5; i++) {
      const headers = {};
      if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
      const cookieHeader = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookieHeader) headers.cookie = cookieHeader;

      const res = await fetch(url, { method, body, headers, redirect: 'manual' });
      for (const setCookie of res.headers.getSetCookie()) {
        const [pair, ...attrs] = setCookie.split(';');
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === '' || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) this.jar.delete(name);
        else this.jar.set(name, value);
      }
      hops.push({ status: res.status, path: url.pathname });

      if (res.status >= 300 && res.status < 400) {
        await res.arrayBuffer();
        url = new URL(res.headers.get('location'), url);
        method = 'GET';
        body = undefined;
        continue;
      }
      return { status: res.status, path: url.pathname, hops, html: await res.text() };
    }
    throw new Error('Too many redirects');
  }

  get(pathname) {
    return this.request('GET', pathname);
  }

  post(pathname, form) {
    return this.request('POST', pathname, form);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectPath(r, expected) {
  assert(r.path === expected, `expected to end on ${expected}, ended on ${r.path} (hops: ${JSON.stringify(r.hops)})`);
}

function expectFlash(r, cls, text) {
  const count = (r.html.match(/id="flash"/g) || []).length;
  assert(count === 1, `expected exactly one #flash element, found ${count}`);
  const want = cls ? `<div id="flash" class="${cls}">${text}</div>` : '<div id="flash"></div>';
  assert(r.html.includes(want), `expected ${want}\n       got ${(r.html.match(/<div id="flash"[^>]*>[^<]*<\/div>/) || ['(none)'])[0]}`);
}

async function main() {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const server = await startServer(port);
  let failures = 0;
  let total = 0;

  async function check(name, fn) {
    total++;
    await fetch(`${base}/__reset`, { method: 'POST' }); // isolate every check
    try {
      await fn(new Client(base));
      console.log(`  ok    ${name}`);
    } catch (err) {
      failures++;
      console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
  }

  console.log(`Self-check against ${base} (LOCK_THRESHOLD=${LOCK_THRESHOLD}, LOCK_MINUTES=${LOCK_MINUTES})`);

  try {
    await check('GET / redirects to /login', async (c) => {
      const r = await c.get('/');
      assert(r.hops[0].status === 302, `expected 302, got ${r.hops[0].status}`);
      expectPath(r, '/login');
      expectFlash(r, null);
      assert(r.html.includes('<h1>Login Page</h1>'), 'missing "Login Page" heading');
    });

    await check('correct login redirects to /secure and shows the success message', async (c) => {
      const r = await c.post('/login', { username: USERNAME, password: PASSWORD });
      expectPath(r, '/secure');
      assert(c.jar.has('session'), 'no "session" cookie was set');
      expectFlash(r, 'success', 'You logged into a secure area!');
      assert(r.html.includes('<h1>Secure Area</h1>'), 'missing "Secure Area" heading');
      assert(r.html.includes('<a href="/logout">Logout</a>'), 'missing Logout link');
    });

    await check('wrong password shows the password error', async (c) => {
      const r = await c.post('/login', { username: USERNAME, password: 'wrong' });
      expectPath(r, '/login');
      expectFlash(r, 'error', 'Your password is invalid!');
    });

    await check('unknown username shows the username error', async (c) => {
      const r = await c.post('/login', { username: 'nobody', password: PASSWORD });
      expectPath(r, '/login');
      expectFlash(r, 'error', 'Your username is invalid!');
    });

    await check('empty submit shows the username error', async (c) => {
      const r = await c.post('/login', { username: '', password: '' });
      expectFlash(r, 'error', 'Your username is invalid!');
    });

    await check(`after ${LOCK_THRESHOLD} failures the correct password shows the locked message`, async (c) => {
      for (let i = 1; i <= LOCK_THRESHOLD; i++) {
        const r = await c.post('/login', { username: USERNAME, password: `wrong-${i}` });
        expectFlash(r, 'error', 'Your password is invalid!');
      }
      const r = await c.post('/login', { username: USERNAME, password: PASSWORD });
      expectPath(r, '/login');
      expectFlash(r, 'error', 'Your account is locked. Try again later.');
      assert(!c.jar.has('session'), 'a session cookie was set while locked');
    });

    await check('/appointments redirects to /login without a session', async (c) => {
      const r = await c.get('/appointments');
      assert(r.hops[0].status === 302, `expected 302, got ${r.hops[0].status}`);
      expectPath(r, '/login');
      expectFlash(r, null);
    });

    await check('/secure redirects to /login without a session', async (c) => {
      const r = await c.get('/secure');
      expectPath(r, '/login');
      expectFlash(r, null);
    });

    await check('logout shows the logout message and ends the session', async (c) => {
      await c.post('/login', { username: USERNAME, password: PASSWORD });
      const r = await c.get('/logout');
      expectPath(r, '/login');
      expectFlash(r, 'success', 'You logged out of the secure area!');
      const after = await c.get('/secure');
      expectPath(after, '/login');
    });

    await check('appointment confirmations persist across reloads', async (c) => {
      await c.post('/login', { username: USERNAME, password: PASSWORD });
      let r = await c.get('/appointments');
      assert(r.html.includes('<p id="appointment-status">Confirmed: 0 of 3</p>'), 'expected "Confirmed: 0 of 3"');
      for (const id of [1, 2, 3]) assert(r.html.includes(`id="appointment-${id}"`), `missing #appointment-${id}`);
      await c.request('POST', '/appointments', [['confirmed', '1'], ['confirmed', '3']]);
      r = await c.get('/appointments');
      assert(r.html.includes('<p id="appointment-status">Confirmed: 2 of 3</p>'), 'expected "Confirmed: 2 of 3"');
      assert(/id="appointment-1"[^>]*checked/.test(r.html), '#appointment-1 should be checked');
      assert(!/id="appointment-2"[^>]*checked/.test(r.html), '#appointment-2 should not be checked');
    });

    await check('unknown path returns 404', async (c) => {
      const r = await c.get('/does-not-exist');
      assert(r.status === 404, `expected 404, got ${r.status}`);
    });
  } finally {
    server.removeAllListeners('exit');
    server.kill();
  }

  console.log(`\n${total - failures} of ${total} checks passed.`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
