'use strict';
// Fenwick Patient Portal: a small, deterministic web app for QA training.
// Zero dependencies: Node.js 20+ built-in modules only.
// WARNING: plain-text passwords and in-memory state. Training use only.

const http = require('http');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
function positiveNumber(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
}

const CONFIG = {
  port: Number(process.env.PORT || 3000),
  lockThreshold: Math.max(1, Math.floor(positiveNumber(process.env.LOCK_THRESHOLD, 3))),
  lockMinutes: positiveNumber(process.env.LOCK_MINUTES, 1),
  flakyBanner: process.env.FLAKY_BANNER === 'on',
  enableTestReset: process.env.ENABLE_TEST_RESET === 'on',
};

// ---------------------------------------------------------------------------
// Data (fictional, in memory)
// ---------------------------------------------------------------------------
const USERS = {
  tomsmith: { password: 'SuperSecretPassword!' },
};

const APPOINTMENTS = [
  { id: 1, title: 'General check-up', when: '12 March 2027, 09:30', where: 'Room 4, Fenwick Clinic' },
  { id: 2, title: 'Blood test', when: '19 March 2027, 11:00', where: 'Laboratory, Fenwick Clinic' },
  { id: 3, title: 'Physiotherapy review', when: '2 April 2027, 14:15', where: 'Room 9, Fenwick Clinic' },
];

const FLASH = {
  login: { cls: 'success', text: 'You logged into a secure area!' },
  logout: { cls: 'success', text: 'You logged out of the secure area!' },
  username: { cls: 'error', text: 'Your username is invalid!' },
  password: { cls: 'error', text: 'Your password is invalid!' },
  locked: { cls: 'error', text: 'Your account is locked. Try again later.' },
};

const sessions = new Map(); // token -> { username, confirmed: Set<number> }
const locks = new Map(); // username -> { failures, lockedUntil }

// ---------------------------------------------------------------------------
// Lock logic
// ---------------------------------------------------------------------------
function currentLock(username, now) {
  const state = locks.get(username);
  if (state && state.lockedUntil && now >= state.lockedUntil) {
    locks.delete(username); // lock expired: unlock and reset the failure count
    return undefined;
  }
  return state;
}

function isLocked(state, now) {
  return Boolean(state && state.lockedUntil && now < state.lockedUntil);
}

function recordFailure(username, now) {
  const state = locks.get(username) || { failures: 0, lockedUntil: 0 };
  state.failures += 1;
  if (state.failures >= CONFIG.lockThreshold) {
    state.lockedUntil = now + CONFIG.lockMinutes * 60 * 1000;
  }
  locks.set(username, state);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    try {
      cookies[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      cookies[key] = '';
    }
  }
  return cookies;
}

function cookie(name, value, maxAge) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

const clearCookie = (name) => cookie(name, '', 0);

function send(res, status, body, setCookies = [], type = 'text/html; charset=utf-8') {
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  if (setCookies.length) headers['Set-Cookie'] = setCookies;
  res.writeHead(status, headers);
  res.end(body);
}

function redirect(res, location, setCookies = [], status = 302) {
  const headers = { Location: location, 'Cache-Control': 'no-store' };
  if (setCookies.length) headers['Set-Cookie'] = setCookies;
  res.writeHead(status, headers);
  res.end();
}

// Redirect with a one-time flash message carried in the `flash` cookie.
function flashRedirect(res, location, flashKey, extraCookies = []) {
  redirect(res, location, [...extraCookies, cookie('flash', flashKey)], 303);
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 100000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(new URLSearchParams(data)));
    req.on('error', reject);
  });
}

function getSession(req) {
  const token = parseCookies(req).session;
  return token && sessions.has(token) ? { token, data: sessions.get(token) } : null;
}

// Reads and consumes the flash cookie. Returns the message (or null) and the
// Set-Cookie header that clears it.
function takeFlash(req) {
  const key = parseCookies(req).flash;
  if (key === undefined) return { message: null, cookies: [] };
  return { message: FLASH[key] || null, cookies: [clearCookie('flash')] };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
const CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         font-size: 16px; line-height: 1.5; color: #1d2733; background: #f4f6f8; }
  header { background: #1f4e79; color: #fff; padding: 12px 16px; }
  header p { margin: 0; font-weight: 600; letter-spacing: .02em; }
  main { max-width: 640px; margin: 24px auto; padding: 24px; background: #fff;
         border: 1px solid #d7dde3; border-radius: 6px; }
  h1 { margin-top: 0; font-size: 1.6rem; }
  h2 { margin: 0 0 4px; font-size: 1.1rem; }
  #flash { margin-bottom: 16px; }
  #flash.success, #flash.error { padding: 10px 14px; border-radius: 4px; border: 1px solid; }
  #flash.success { background: #e6f4ea; border-color: #7cc08f; color: #1e5631; }
  #flash.error { background: #fdecea; border-color: #e3908a; color: #7a1f17; }
  label { display: block; margin: 12px 0 4px; font-weight: 600; }
  .appointment label { display: inline; margin: 0 0 0 4px; }
  input[type=text], input[type=password] { width: 100%; padding: 8px; font-size: 1rem;
         border: 1px solid #9aa6b2; border-radius: 4px; }
  button { margin-top: 16px; padding: 8px 18px; font-size: 1rem; color: #fff;
           background: #1f4e79; border: 0; border-radius: 4px; cursor: pointer; }
  ul.appointments { list-style: none; padding: 0; margin: 0; }
  li.appointment { padding: 12px 0; border-bottom: 1px solid #e3e7eb; }
  li.appointment p { margin: 0 0 6px; color: #4a5866; }
  #appointment-status { font-weight: 600; }
  nav { margin-top: 20px; display: flex; gap: 16px; }
  a { color: #1f4e79; }
`;

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - Fenwick Patient Portal</title>
<style>${CSS}</style>
</head>
<body>
<header><p>Fenwick Patient Portal</p></header>
<main>
${body}
</main>
</body>
</html>
`;
}

function flashHtml(message) {
  if (!message) return '<div id="flash"></div>';
  return `<div id="flash" class="${message.cls}">${escapeHtml(message.text)}</div>`;
}

function loginPage(message) {
  return layout('Login Page', `${flashHtml(message)}
<h1>Login Page</h1>
<p>Sign in with your patient username and password.</p>
<form id="login" method="post" action="/login">
  <label for="username">Username</label>
  <input type="text" id="username" name="username" autocomplete="username">
  <label for="password">Password</label>
  <input type="password" id="password" name="password" autocomplete="current-password">
  <button type="submit">Login</button>
</form>`);
}

// With FLAKY_BANNER=on, the success banner is not in the HTML. An inline
// script inserts it after a random 0-1500 ms delay. It always appears.
function flakyBannerScript(message) {
  return `<script>
(function () {
  var delay = Math.floor(Math.random() * 1501);
  setTimeout(function () {
    var el = document.createElement('div');
    el.id = 'flash';
    el.className = ${JSON.stringify(message.cls)};
    el.textContent = ${JSON.stringify(message.text)};
    var main = document.querySelector('main');
    main.insertBefore(el, main.firstChild);
  }, delay);
})();
</script>`;
}

function securePage(username, message) {
  const delayed = CONFIG.flakyBanner && message && message.cls === 'success';
  return layout('Secure Area', `${delayed ? '' : flashHtml(message)}
<h1>Secure Area</h1>
<p>Welcome, <strong>${escapeHtml(username)}</strong>. This is the secure area of the patient portal.</p>
<nav>
  <a href="/appointments">Appointments</a>
  <a href="/logout">Logout</a>
</nav>${delayed ? `\n${flakyBannerScript(message)}` : ''}`);
}

function appointmentsPage(confirmed) {
  const items = APPOINTMENTS.map((a) => `  <li class="appointment" data-appointment-id="${a.id}">
    <h2>${escapeHtml(a.title)}</h2>
    <p>${escapeHtml(a.when)} &middot; ${escapeHtml(a.where)}</p>
    <input type="checkbox" id="appointment-${a.id}" name="confirmed" value="${a.id}"${confirmed.has(a.id) ? ' checked' : ''}>
    <label for="appointment-${a.id}">Confirm appointment</label>
  </li>`).join('\n');
  return layout('Appointments', `<div id="flash"></div>
<h1>Appointments</h1>
<form id="appointments" method="post" action="/appointments">
<ul class="appointments">
${items}
</ul>
<button type="submit">Save</button>
</form>
<p id="appointment-status">Confirmed: ${confirmed.size} of ${APPOINTMENTS.length}</p>
<nav>
  <a href="/secure">Secure Area</a>
  <a href="/logout">Logout</a>
</nav>`);
}

function notFoundPage() {
  return layout('Not Found', `<h1>Not Found</h1>
<p>The page you requested does not exist.</p>
<p><a href="/login">Go to the login page</a></p>`);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
async function handleLogin(req, res) {
  const form = await readForm(req);
  const username = form.get('username') || '';
  const password = form.get('password') || '';
  const now = Date.now();

  if (isLocked(currentLock(username, now), now)) return flashRedirect(res, '/login', 'locked');

  const user = Object.prototype.hasOwnProperty.call(USERS, username) ? USERS[username] : null;
  if (!user) {
    recordFailure(username, now);
    return flashRedirect(res, '/login', 'username');
  }
  if (user.password !== password) {
    recordFailure(username, now);
    return flashRedirect(res, '/login', 'password');
  }

  locks.delete(username); // success resets the failure count
  const previous = getSession(req);
  if (previous) sessions.delete(previous.token);
  const token = crypto.randomBytes(16).toString('hex');
  sessions.set(token, { username, confirmed: new Set() });
  return flashRedirect(res, '/secure', 'login', [cookie('session', token)]);
}

async function handleAppointments(req, res, session) {
  const form = await readForm(req);
  const valid = new Set(APPOINTMENTS.map((a) => a.id));
  session.data.confirmed = new Set(form.getAll('confirmed').map(Number).filter((id) => valid.has(id)));
  return redirect(res, '/appointments', [], 303);
}

async function route(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const method = req.method;

  if (method === 'GET' && pathname === '/') return redirect(res, '/login');

  if (pathname === '/login') {
    if (method === 'GET') {
      const flash = takeFlash(req);
      return send(res, 200, loginPage(flash.message), flash.cookies);
    }
    if (method === 'POST') return handleLogin(req, res);
  }

  if (method === 'GET' && pathname === '/logout') {
    const session = getSession(req);
    if (session) sessions.delete(session.token);
    return flashRedirect(res, '/login', 'logout', [clearCookie('session')]);
  }

  if (pathname === '/secure' || pathname === '/appointments') {
    const session = getSession(req);
    if (method === 'GET' || method === 'POST') {
      if (!session) return redirect(res, '/login', [clearCookie('flash')]);
      if (method === 'GET' && pathname === '/secure') {
        const flash = takeFlash(req);
        return send(res, 200, securePage(session.data.username, flash.message), flash.cookies);
      }
      if (method === 'GET') return send(res, 200, appointmentsPage(session.data.confirmed));
      if (pathname === '/appointments') return handleAppointments(req, res, session);
    }
  }

  if (CONFIG.enableTestReset && method === 'POST' && pathname === '/__reset') {
    sessions.clear();
    locks.clear();
    return send(res, 200, 'reset\n', [], 'text/plain; charset=utf-8');
  }

  return send(res, 404, notFoundPage());
}

function createServer() {
  return http.createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, 'Internal Server Error\n', [], 'text/plain; charset=utf-8');
      else res.end();
    });
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(CONFIG.port, () => {
    const { port } = server.address();
    console.log(`Fenwick Patient Portal listening on http://localhost:${port}/login`);
    console.log(
      `Config: LOCK_THRESHOLD=${CONFIG.lockThreshold} LOCK_MINUTES=${CONFIG.lockMinutes} ` +
        `FLAKY_BANNER=${CONFIG.flakyBanner ? 'on' : 'off'} ENABLE_TEST_RESET=${CONFIG.enableTestReset ? 'on' : 'off'}`
    );
  });
}

module.exports = { createServer, CONFIG };
