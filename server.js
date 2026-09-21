const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const selfsigned = require('selfsigned');
const updater = require('./update-service');

function isMobileBundle() {
  return path.basename(__dirname) === 'nodejs-project';
}

function storageRoot() {
  if (!isMobileBundle()) return __dirname;
  const root = path.join(__dirname, '..', 'gamelle-persist');
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

function copyDirIfMissing(src, dest) {
  if (!src || src === dest || !fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  let names = [];
  try { names = fs.readdirSync(src); } catch (e) { return; }
  for (const name of names) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    let st;
    try { st = fs.statSync(from); } catch (e) { continue; }
    if (st.isDirectory()) copyDirIfMissing(from, to);
    else if (name === 'public-url.json') continue;
    else if (!fs.existsSync(to)) {
      try { fs.copyFileSync(from, to); } catch (e) {}
    }
  }
}

const STORE = storageRoot();

const app = express();

// --- Certificat HTTPS auto-signé, généré une seule fois et réutilisé ensuite ---
// Nécessaire pour que le navigateur autorise la caméra et le micro sur une IP locale
// (Chrome/Android bloque ces accès en http:// sauf sur localhost).
const CERT_DIR = path.join(STORE, 'certs');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');
copyDirIfMissing(path.join(__dirname, 'certs'), CERT_DIR);
copyDirIfMissing(path.join(__dirname, '..', 'nodejs-project-trash', 'certs'), CERT_DIR);
if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

function generateCert() {
  // OpenSSL 3 (Termux/Android) refuse les clés < 2048 bits : "ee key too small"
  const pems = selfsigned.generate([{ name: 'commonName', value: 'gamelle-chat.local' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
  });
  fs.writeFileSync(KEY_PATH, pems.private);
  fs.writeFileSync(CERT_PATH, pems.cert);
}

if (!fs.existsSync(KEY_PATH) || !fs.existsSync(CERT_PATH)) {
  generateCert();
  console.log('Certificat HTTPS généré (uniquement au premier démarrage).');
}

function createHttpsServer() {
  return https.createServer({ key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CERT_PATH) }, app);
}

let server;
try {
  server = createHttpsServer();
} catch (e) {
  if (e.code === 'ERR_SSL_EE_KEY_TOO_SMALL' || (e.message && String(e.message).includes('ee key too small'))) {
    console.log('Ancien certificat trop faible pour OpenSSL, régénération en 2048 bits...');
    generateCert();
    server = createHttpsServer();
  } else {
    throw e;
  }
}
const io = new Server(server, {
  maxHttpBufferSize: 5e7,
  pingTimeout: 30000,
  pingInterval: 25000,
  cors: { origin: true, credentials: true },
});

let publicUrl = null;
const PORT = Number(process.env.PORT) || 3000;
const liveJpegs = {};

// --- Dossiers de stockage ---
const RECEIVER_DIR = path.join(STORE, 'uploads', 'receiver');
const CONTROLLER_DIR = path.join(STORE, 'uploads', 'controller');
const AUDIO_DIR = path.join(STORE, 'uploads', 'audio');
const DATA_DIR = path.join(STORE, 'data');
const DATA_FILE = path.join(DATA_DIR, 'schedules.json');
const ACTIVE_CODE_FILE = path.join(DATA_DIR, 'active-code.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSION_COOKIE = 'gamelle_session';
const SESSION_MAX_AGE_SEC = 365 * 24 * 3600;
copyDirIfMissing(path.join(__dirname, 'uploads', 'receiver'), RECEIVER_DIR);
copyDirIfMissing(path.join(__dirname, 'uploads', 'controller'), CONTROLLER_DIR);
copyDirIfMissing(path.join(__dirname, 'uploads', 'audio'), AUDIO_DIR);
copyDirIfMissing(path.join(__dirname, 'data'), DATA_DIR);
copyDirIfMissing(path.join(__dirname, '..', 'nodejs-project-trash', 'data'), DATA_DIR);
copyDirIfMissing(path.join(__dirname, '..', 'nodejs-project-trash', 'uploads', 'receiver'), RECEIVER_DIR);
copyDirIfMissing(path.join(__dirname, '..', 'nodejs-project-trash', 'uploads', 'controller'), CONTROLLER_DIR);
copyDirIfMissing(path.join(__dirname, '..', 'nodejs-project-trash', 'uploads', 'audio'), AUDIO_DIR);
[RECEIVER_DIR, CONTROLLER_DIR, AUDIO_DIR, DATA_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

function roomWeight(room) {
  if (!room) return 0;
  return ((room.schedules && room.schedules.length) || 0) + ((room.messages && room.messages.length) || 0);
}

function mergeSchedulesFrom(srcFile) {
  if (!srcFile || srcFile === DATA_FILE || !fs.existsSync(srcFile)) return;
  let incoming = {};
  try { incoming = JSON.parse(fs.readFileSync(srcFile, 'utf8')); } catch (e) { return; }
  let current = {};
  try {
    if (fs.existsSync(DATA_FILE)) current = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {}
  if (!incoming || typeof incoming !== 'object') return;
  let changed = false;
  Object.keys(incoming).forEach((code) => {
    if (roomWeight(incoming[code]) > roomWeight(current[code])) {
      current[code] = incoming[code];
      changed = true;
    }
  });
  if (changed) {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(current, null, 2)); } catch (e) {}
  }
}

mergeSchedulesFrom(path.join(__dirname, 'data', 'schedules.json'));
mergeSchedulesFrom(path.join(__dirname, '..', 'nodejs-project-trash', 'data', 'schedules.json'));

/** Reunion des comptes (par id puis username) — évite la perte à l’OTA. */
function mergeAccountsFrom(srcFile) {
  if (!srcFile || srcFile === ACCOUNTS_FILE || !fs.existsSync(srcFile)) return;
  let incoming = null;
  try { incoming = JSON.parse(fs.readFileSync(srcFile, 'utf8')); } catch (e) { return; }
  if (!incoming || !Array.isArray(incoming.users) || !incoming.users.length) return;
  let current = { users: [] };
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) current = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  } catch (e) {}
  if (!current || typeof current !== 'object') current = { users: [] };
  if (!Array.isArray(current.users)) current.users = [];
  const byId = new Map();
  const byName = new Map();
  current.users.forEach((u) => {
    if (!u || typeof u !== 'object') return;
    if (u.id) byId.set(String(u.id), u);
    if (u.username) byName.set(String(u.username).toLowerCase(), u);
  });
  let changed = false;
  incoming.users.forEach((u) => {
    if (!u || typeof u !== 'object' || !u.username || !u.passHash || !u.salt) return;
    const id = u.id ? String(u.id) : '';
    const name = String(u.username).toLowerCase();
    if (id && byId.has(id)) return;
    if (byName.has(name)) return;
    current.users.push(u);
    if (id) byId.set(id, u);
    byName.set(name, u);
    changed = true;
  });
  if (changed) {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(current, null, 2));
    } catch (e) {}
  }
}

mergeAccountsFrom(path.join(__dirname, 'data', 'accounts.json'));
mergeAccountsFrom(path.join(__dirname, '..', 'nodejs-project-trash', 'data', 'accounts.json'));
console.log('Stockage persistant :', STORE);

app.use((req, res, next) => {
  // Ne pas toucher à autoplay : un header trop strict coupe bip / TTS / audio en HTTPS local
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
  next();
});

app.use(express.json({ limit: '50mb' }));

function loadJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : fallback;
  } catch (e) {
    return fallback;
  }
}

function saveJsonFile(file, data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {}
}

function isLocalRequest(req) {
  const raw = String(req.socket && req.socket.remoteAddress || '');
  const ip = raw.replace(/^::ffff:/i, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function parseCookies(req) {
  const out = {};
  const raw = String(req.headers && req.headers.cookie || '');
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) return;
    try {
      out[k] = decodeURIComponent(v);
    } catch (e) {
      out[k] = v;
    }
  });
  return out;
}

function readAccounts() {
  const j = loadJsonFile(ACCOUNTS_FILE, { users: [] });
  if (!Array.isArray(j.users)) j.users = [];
  return j;
}

function writeAccounts(data) {
  saveJsonFile(ACCOUNTS_FILE, data);
}

function readSessions() {
  const j = loadJsonFile(SESSIONS_FILE, { sessions: [] });
  if (!Array.isArray(j.sessions)) j.sessions = [];
  return j;
}

function writeSessions(data) {
  saveJsonFile(SESSIONS_FILE, data);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}

function publicUser(u) {
  return { id: u.id, username: u.username, createdAt: u.createdAt || null };
}

function getSessionUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const sessions = readSessions();
  const s = sessions.sessions.find((x) => x && x.token === token);
  if (!s) return null;
  const accounts = readAccounts();
  const u = accounts.users.find((x) => x && x.id === s.userId);
  if (!u) return null;
  return { id: u.id, username: u.username, token };
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = readSessions();
  sessions.sessions.push({
    token,
    userId,
    createdAt: Date.now(),
    lastSeen: Date.now(),
  });
  // garder max 200 sessions
  if (sessions.sessions.length > 200) {
    sessions.sessions = sessions.sessions.slice(-200);
  }
  writeSessions(sessions);
  return token;
}

function destroySession(token) {
  if (!token) return;
  const sessions = readSessions();
  sessions.sessions = sessions.sessions.filter((x) => x && x.token !== token);
  writeSessions(sessions);
}

function setSessionCookie(res, token, req) {
  const secure = !!(req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https'));
  let c = `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}`;
  if (secure) c += '; Secure';
  res.append('Set-Cookie', c);
}

function clearSessionCookie(res, req) {
  const secure = !!(req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https'));
  let c = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  if (secure) c += '; Secure';
  res.append('Set-Cookie', c);
}

function htmlWithAbsoluteLogo(html, req) {
  const base = (publicUrl || `${req.protocol}://${req.get('host') || 'localhost'}`).replace(/\/$/, '');
  return String(html || '')
    .replace(/content="\/logo\.png"/g, `content="${base}/logo.png"`)
    .replace(/href="\/(favicon-[^"]+|apple-touch-icon\.png)"/g, `href="${base}/$1"`);
}

function sendHtml(res, req, file) {
  const full = path.join(__dirname, 'public', file);
  fs.readFile(full, 'utf8', (err, html) => {
    if (err) {
      res.status(404).send('Not found');
      return;
    }
    res.type('html').send(htmlWithAbsoluteLogo(html, req));
  });
}

app.get(['/', '/index.html'], (req, res) => {
  const user = getSessionUser(req);
  if (user) {
    return res.redirect(302, '/controller.html');
  }
  sendHtml(res, req, 'index.html');
});

app.get('/controller.html', (req, res) => {
  if (!getSessionUser(req)) {
    return res.redirect(302, '/?next=controller');
  }
  sendHtml(res, req, 'controller.html');
});

app.get('/receiver.html', (req, res) => {
  sendHtml(res, req, 'receiver.html');
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/media/receiver', express.static(RECEIVER_DIR));
app.use('/media/controller', express.static(CONTROLLER_DIR));
app.use('/media/audio', express.static(AUDIO_DIR));

app.get('/api/auth/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.json({ ok: true, authenticated: false });
  res.json({ ok: true, authenticated: true, user: { id: user.id, username: user.username } });
});

app.get('/api/auth/users', (req, res) => {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ ok: false, error: 'Réservé à la tablette' });
  }
  const accounts = readAccounts();
  res.json({ ok: true, users: accounts.users.map(publicUser) });
});

app.post('/api/auth/register', (req, res) => {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ ok: false, error: 'Réservé à la tablette' });
  }
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (username.length < 2 || username.length > 32) {
    return res.status(400).json({ ok: false, error: 'Identifiant invalide' });
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    return res.status(400).json({ ok: false, error: 'Identifiant : lettres, chiffres, . _ -' });
  }
  if (password.length < 4 || password.length > 128) {
    return res.status(400).json({ ok: false, error: 'Mot de passe trop court' });
  }
  const accounts = readAccounts();
  if (accounts.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ ok: false, error: 'Identifiant déjà pris' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const passHash = hashPassword(password, salt);
  const user = {
    id: crypto.randomBytes(8).toString('hex'),
    username,
    salt,
    passHash,
    createdAt: Date.now(),
  };
  accounts.users.push(user);
  writeAccounts(accounts);
  res.status(201).json({ ok: true, user: publicUser(user) });
});

function findSessionsForUser(userId) {
  const sessions = readSessions();
  return sessions.sessions.filter((s) => s && s.userId === userId);
}

app.post('/api/auth/login', (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const accounts = readAccounts();
  const user = accounts.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user || !user.salt || !user.passHash) {
    return res.status(401).json({ ok: false, error: 'Identifiants incorrects' });
  }
  let ok = false;
  try {
    const hash = hashPassword(password, user.salt);
    ok = crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.passHash, 'hex'));
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    return res.status(401).json({ ok: false, error: 'Identifiants incorrects' });
  }

  // Déjà connecté sur CET appareil (même cookie) → OK, pas de nouvelle session.
  const current = getSessionUser(req);
  if (current && current.id === user.id) {
    return res.json({ ok: true, user: publicUser(user) });
  }

  // Une session existe déjà ailleurs → refuser (pas de déco auto).
  const existing = findSessionsForUser(user.id);
  if (existing.length > 0) {
    return res.status(409).json({
      ok: false,
      error: 'Ce compte est déjà connecté sur un autre appareil. Déconnecte-toi là-bas avant de te connecter ici.',
      code: 'SESSION_ACTIVE',
    });
  }

  const token = createSession(user.id);
  setSessionCookie(res, token, req);
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const user = getSessionUser(req);
  if (user && user.token) destroySession(user.token);
  clearSessionCookie(res, req);
  res.json({ ok: true });
});

app.delete('/api/auth/users/:id', (req, res) => {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ ok: false, error: 'Réservé à la tablette' });
  }
  const id = String(req.params.id || '');
  const accounts = readAccounts();
  const before = accounts.users.length;
  accounts.users = accounts.users.filter((u) => u && u.id !== id);
  if (accounts.users.length === before) {
    return res.status(404).json({ ok: false, error: 'Compte introuvable' });
  }
  writeAccounts(accounts);
  const sessions = readSessions();
  sessions.sessions = sessions.sessions.filter((s) => s && s.userId !== id);
  writeSessions(sessions);
  res.json({ ok: true });
});

function loadTunnelConfig() {
  const defaults = {
    publicUrl: '',
    allowedSuffixes: ['trycloudflare.com'],
  };
  const candidates = [
    path.join(STORE, 'tunnel.config.json'),
    path.join(__dirname, 'tunnel.config.json'),
  ];
  for (const cfgPath of candidates) {
    try {
      if (!fs.existsSync(cfgPath)) continue;
      const j = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const publicUrl = String((j && j.publicUrl) || '').replace(/\/$/, '');
      if (!publicUrl || publicUrl.includes('TON-')) continue;
      const suffixes = Array.isArray(j && j.allowedSuffixes) && j.allowedSuffixes.length
        ? j.allowedSuffixes.map((s) => String(s).toLowerCase())
        : defaults.allowedSuffixes;
      // Autorise le domaine de l’URL configurée.
      try {
        const host = new URL(publicUrl).hostname.toLowerCase();
        const parts = host.split('.');
        if (parts.length >= 2) suffixes.push(parts.slice(-2).join('.'), host);
      } catch (e) {}
      return {
        publicUrl,
        allowedSuffixes: [...new Set(suffixes.concat(defaults.allowedSuffixes))],
      };
    } catch (e) {}
  }
  return defaults;
}

const tunnelConfig = loadTunnelConfig();

function readTunnelToken() {
  const fromEnv = process.env.CLOUDFLARE_TUNNEL_TOKEN || process.env.TUNNEL_TOKEN;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const candidates = [
    path.join(STORE, 'tunnel.token'),
    path.join(__dirname, 'tunnel.token'),
  ];
  for (const tokenPath of candidates) {
    try {
      if (!fs.existsSync(tokenPath)) continue;
      const raw = fs.readFileSync(tokenPath, 'utf8').trim();
      if (!raw || raw.includes('REMPLACE_MOI') || raw.includes('TON-')) continue;
      const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '';
      if (line.length >= 40) return line;
    } catch (e) {}
  }
  return '';
}

function isAllowedPublicUrl(url) {
  try {
    const host = (new URL(String(url)).hostname || '').toLowerCase();
    if (!host || host === 'api.trycloudflare.com') return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    return (tunnelConfig.allowedSuffixes || []).some((suffix) => {
      const s = String(suffix).toLowerCase();
      return host === s || host.endsWith('.' + s);
    });
  } catch (e) {
    return false;
  }
}

function readNativePublicUrl() {
  try {
    const extra = path.join(DATA_DIR, 'public-url.json');
    if (!fs.existsSync(extra)) return null;
    const j = JSON.parse(fs.readFileSync(extra, 'utf8'));
    if (j && j.url) {
      const url = String(j.url).replace(/\/$/, '');
      if (isAllowedPublicUrl(url)) return url;
    }
  } catch (e) {}
  return null;
}

app.get('/api/info', (_req, res) => {
  res.json({
    publicUrl: publicUrl || readNativePublicUrl(),
    localUrl: `https://${getLocalIp()}:${PORT}`,
    version: updater.pkgVersion(),
    pairCode: readActiveCode(),
  });
});

app.get('/api/active-code', (_req, res) => {
  res.json({ code: readActiveCode() });
});

app.post('/api/alarm-stop', (_req, res) => {
  const code = readActiveCode();
  if (code) stopRoomAlarm(code);
  res.json({ ok: true });
});
app.get('/api/alarm-stop', (_req, res) => {
  const code = readActiveCode();
  if (code) stopRoomAlarm(code);
  res.json({ ok: true });
});

app.get('/c/:code', (req, res) => {
  const code = String(req.params.code || '').trim();
  if (!/^[0-9A-Za-z]{4,12}$/.test(code)) return res.redirect('/');
  if (!getSessionUser(req)) return res.redirect(302, '/?next=controller');
  try {
    res.setHeader('Cache-Control', 'no-store');
  } catch (e) {}
  sendHtml(res, req, 'controller.html');
});

app.get('/api/update/status', (_req, res) => {
  try {
    res.json(updater.getStatus());
  } catch (e) {
    res.status(500).json({ ok: false, git: false, available: false, message: e.message || 'Erreur' });
  }
});

app.post('/api/update/apply', (_req, res) => {
  try { persist(); } catch (e) {}
  let result;
  try {
    result = updater.applyUpdate();
  } catch (e) {
    return res.status(500).json({ ok: false, restart: false, message: e.message || 'Erreur' });
  }
  res.json(result);
  if (result && result.restart) {
    setTimeout(() => updater.restartServer(), 700);
  }
});

app.get('/api/live/:code', (req, res) => {
  const frame = liveJpegs[req.params.code];
  if (!frame) return res.status(204).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store, no-cache');
  res.send(frame);
});

// --- Persistance des horaires + bibliothèque de messages (survit à un redémarrage) ---
function loadPersisted() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) { console.error('Erreur lecture schedules.json:', e.message); }
  return {};
}
function persist() {
  let dump = {};
  try {
    if (fs.existsSync(DATA_FILE)) dump = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
  } catch (e) {}
  for (const code in rooms) dump[code] = {
    schedules: rooms[code].schedules,
    messages: rooms[code].messages,
    manualAlarm: rooms[code].manualAlarm || { messageId: '', sound1: 'beep', sound2: '', duration: 30 },
    lastFired: rooms[code]._lastFired || {},
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(dump, null, 2));
}

function notifyFlutter(tag, message) {
  try { require('flutter-bridge').send(tag, String(message)); } catch (e) {}
}

function readActiveCode() {
  try {
    if (fs.existsSync(ACTIVE_CODE_FILE)) {
      const j = JSON.parse(fs.readFileSync(ACTIVE_CODE_FILE, 'utf8'));
      if (j && j.code && String(j.code).trim().length >= 4) return String(j.code).trim();
    }
  } catch (e) {}
  const keys = Object.keys(persisted || {});
  const nonempty = keys.filter((k) => roomWeight(persisted[k]) > 0);
  if (nonempty.length) return nonempty[0];
  if (keys.length) return keys[0];
  return null;
}

function writeActiveCode(code) {
  if (!code || String(code).trim().length < 4) return;
  try {
    fs.writeFileSync(ACTIVE_CODE_FILE, JSON.stringify({ code: String(code).trim() }));
  } catch (e) {}
}

function ensureActiveCode() {
  let code = readActiveCode();
  if (!code) {
    code = String(Math.floor(100000 + Math.random() * 900000));
  }
  writeActiveCode(code);
  return code;
}

function allWeekDays() {
  return [0, 1, 2, 3, 4, 5, 6];
}

function normalizeDays(days) {
  if (!Array.isArray(days) || !days.length) return allWeekDays();
  const set = new Set(days.map(Number).filter((n) => n >= 0 && n <= 6));
  if (!set.size) return allWeekDays();
  return allWeekDays().filter((n) => set.has(n));
}

function scheduleMatchesWeekday(s, weekday) {
  return normalizeDays(s && s.days).includes(Number(weekday));
}

function parseTimeToMinutes(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Horaire dû maintenant, ou rattrapé si le tick a sauté la minute
 * (Doze / veille Android peut retarder setInterval de plusieurs minutes).
 */
function scheduleIsDue(s, now, graceMinutes) {
  const schedMin = parseTimeToMinutes(s && s.time);
  if (schedMin == null) return false;
  if (!scheduleMatchesWeekday(s, now.getDay())) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const delta = nowMin - schedMin;
  const grace = Math.max(0, Number(graceMinutes) || 0);
  return delta >= 0 && delta <= grace;
}

function remapBuiltinSound(id) {
  if (id === 'kibble' || id === 'meow') return 'beep';
  return id || '';
}

function normalizeSchedule(s) {
  if (!s) return { id: 's' + Date.now(), time: '08:00', duration: 30, sound1: 'beep', sound2: '', messageId: '', days: allWeekDays() };
  let sound1;
  let sound2;
  if (s.sound1 !== undefined || s.sound2 !== undefined) {
    sound1 = remapBuiltinSound(s.sound1 || '');
    sound2 = remapBuiltinSound(s.sound2 || s.messageId || '');
  } else {
    sound1 = 'beep';
    sound2 = s.messageId || '';
  }
  return {
    id: s.id || ('s' + Date.now()),
    time: s.time || '08:00',
    duration: Math.min(120, Math.max(5, Number(s.duration) || 30)),
    sound1,
    sound2,
    messageId: s.messageId || sound2 || '',
    days: normalizeDays(s.days),
  };
}

function resolveAlarmSound(room, id) {
  if (!id) return null;
  if (id === 'beep' || id === 'chime') {
    return { type: 'builtin', id };
  }
  const msg = (room.messages || []).find((m) => m.id === id);
  if (!msg) return { type: 'builtin', id: 'beep' };
  return {
    type: 'message',
    text: (msg.text || '').trim(),
    audioUrl: msg.audioUrl || null,
    name: msg.name || '',
  };
}

function soundsForSchedule(room, s) {
  const n = normalizeSchedule(s);
  const out = [];
  const a = resolveAlarmSound(room, n.sound1);
  const b = resolveAlarmSound(room, n.sound2);
  if (a) out.push(a);
  if (b && n.sound2 !== n.sound1) out.push(b);
  if (!out.length) out.push({ type: 'builtin', id: 'beep' });
  return out;
}

function assignMessageToAlarms(room, messageId) {
  if (!room.manualAlarm) room.manualAlarm = { messageId: '', sound1: 'beep', sound2: '', duration: 30 };
  room.manualAlarm.messageId = messageId;
  room.manualAlarm.sound2 = messageId;
  if (!room.manualAlarm.sound1) room.manualAlarm.sound1 = 'beep';
  if (!room.schedules.length) {
    room.schedules.push({ id: 's' + Date.now(), time: '08:00', messageId, sound1: 'beep', sound2: messageId, duration: 30, days: allWeekDays() });
  } else {
    room.schedules.forEach((s) => {
      s.messageId = messageId;
      s.sound2 = messageId;
      if (!s.sound1) s.sound1 = 'beep';
    });
  }
}

const persisted = loadPersisted();
ensureActiveCode();

// rooms[code] = { controllerIds: Set, receiverId, schedules, messages, _lastFired, camOn, cameras }
const rooms = {};
function getRoom(code) {
  if (!rooms[code]) {
    const saved = persisted[code] || {};
    const lastFired = (saved.lastFired && typeof saved.lastFired === 'object') ? { ...saved.lastFired } : {};
    rooms[code] = {
      schedules: (saved.schedules || []).map(normalizeSchedule),
      messages: saved.messages || [],
      manualAlarm: saved.manualAlarm || { messageId: '', sound1: 'beep', sound2: '', duration: 30 },
      _lastFired: lastFired,
      controllerIds: new Set(),
      receiverId: null,
      camOn: false,
      screenOn: true,
      cameras: [],
    };
  }
  if (!rooms[code].controllerIds) rooms[code].controllerIds = new Set();
  return rooms[code];
}

/** Charge les salons persistés dès le boot (sinon aucun horaire ne sonne tant que personne n’a join). */
function hydrateRoomsFromPersisted() {
  const codes = new Set(Object.keys(persisted || {}));
  const active = readActiveCode();
  if (active) codes.add(active);
  codes.forEach((code) => {
    if (!code) return;
    const saved = persisted[code];
    if (code === active || roomWeight(saved) > 0) getRoom(code);
  });
}
hydrateRoomsFromPersisted();

function emitToRole(code, role, event, payload) {
  const socketIds = io.sockets.adapter.rooms.get(code);
  if (!socketIds) return;
  socketIds.forEach((id) => {
    const s = io.sockets.sockets.get(id);
    if (s && s.data.role === role) s.emit(event, payload);
  });
}

/** Relais live JPEG : volatile si dispo (drop sous charge 4G), sinon emit normal. */
function emitLiveFrame(code, payload) {
  const socketIds = io.sockets.adapter.rooms.get(code);
  if (!socketIds) return;
  socketIds.forEach((id) => {
    const s = io.sockets.sockets.get(id);
    if (!s || s.data.role !== 'controller') return;
    try {
      if (s.volatile && typeof s.volatile.emit === 'function') {
        s.volatile.emit('live-frame', payload);
      } else {
        s.emit('live-frame', payload);
      }
    } catch (e) {
      try { s.emit('live-frame', payload); } catch (e2) {}
    }
  });
}

function emitPeers(code, room) {
  for (const id of [...room.controllerIds]) {
    if (!io.sockets.sockets.get(id)) room.controllerIds.delete(id);
  }
  if (room.receiverId && !io.sockets.sockets.get(room.receiverId)) room.receiverId = null;
  const names = [];
  for (const id of room.controllerIds) {
    const s = io.sockets.sockets.get(id);
    const name = s && s.data && s.data.username ? String(s.data.username) : '';
    names.push(name || 'Contrôleur');
  }
  names.sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  io.to(code).emit('peers', {
    controllers: room.controllerIds.size,
    receiver: !!room.receiverId,
    names,
  });
}

function listMedia(dir, urlPrefix) {
  return fs.readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { name: f, url: `${urlPrefix}/${f}`, ts: stat.mtimeMs, type: f.endsWith('.webm') ? 'video' : 'photo' };
    })
    .sort((a, b) => b.ts - a.ts);
}
function controllerMedia() { return listMedia(CONTROLLER_DIR, '/media/controller'); }
function receiverMedia() { return listMedia(RECEIVER_DIR, '/media/receiver'); }

// Envoie à chaque socket du salon sa propre vue (contrôleur = purgé 24h, récepteur = permanent)
function broadcastRoomState(code, room) {
  const socketIds = io.sockets.adapter.rooms.get(code);
  if (!socketIds) return;
  socketIds.forEach((socketId) => {
    const s = io.sockets.sockets.get(socketId);
    if (!s) return;
    const media = s.data.role === 'receiver' ? receiverMedia() : controllerMedia();
    s.emit('room-state', {
      schedules: room.schedules,
      messages: room.messages,
      media,
      manualAlarm: room.manualAlarm || { messageId: '', duration: 30 },
    });
  });
}

io.on('connection', (socket) => {
  socket.on('join', ({ code, role }) => {
    if (role === 'controller') {
      const user = getSessionUser(socket.request);
      if (!user) {
        socket.emit('auth-required', { error: 'Connexion requise' });
        socket.disconnect(true);
        return;
      }
      socket.data.userId = user.id;
      socket.data.username = user.username;
    }
    const room = getRoom(code);
    socket.join(code);
    socket.data.code = code;
    socket.data.role = role;

    if (role === 'controller') room.controllerIds.add(socket.id);
    if (role === 'receiver') {
      room.receiverId = socket.id;
      writeActiveCode(code);
    }

    emitPeers(code, room);

    const media = role === 'receiver' ? receiverMedia() : controllerMedia();
    socket.emit('room-state', {
      schedules: room.schedules,
      messages: room.messages,
      media,
      manualAlarm: room.manualAlarm || { messageId: '', duration: 30 },
    });
    if (room._alarmUntil && room._alarmUntil > Date.now() && room._alarmPayload) {
      socket.emit('alarm', room._alarmPayload);
    }
    // Un contrôleur qui arrive plus tard récupère tout de suite la caméra déjà allumée
    if (role === 'controller') {
      if (room.camOn) socket.emit('cam-status', { on: true });
      if (room.cameras && room.cameras.length) socket.emit('camera-list', room.cameras);
      if (room.battery) socket.emit('battery-status', room.battery);
      socket.emit(room.screenOn === false ? 'screen-off' : 'screen-on');
    }
  });

  socket.on('trigger-alarm', (payload) => {
    if (!socket.data.code) return;
    startRoomAlarm(socket.data.code, payload || {});
  });

  socket.on('stop-alarm', () => {
    if (!socket.data.code) return;
    stopRoomAlarm(socket.data.code);
  });

  // --- Relais WebRTC (signaling) : channel 'cam' (récepteur->contrôleur) ou 'talk' (contrôleur->récepteur) ---
  socket.on('signal', (payload) => {
    if (!socket.data.code) return;
    socket.to(socket.data.code).emit('signal', payload);
  });

  // Relais caméra JPEG : un seul envoi aux contrôleurs (évite le double flux qui tuait les FPS)
  socket.on('live-frame', (data) => {
    if (!socket.data.code || socket.data.role !== 'receiver') return;
    let out = null;
    let forApi = null;
    if (typeof data === 'string') {
      out = data;
      try { forApi = Buffer.from(data, 'base64'); } catch (e) {}
    } else if (data && typeof data === 'object' && typeof data.jpeg === 'string') {
      out = data.jpeg;
      try { forApi = Buffer.from(data.jpeg, 'base64'); } catch (e) {}
    } else if (data) {
      try {
        if (Buffer.isBuffer(data)) {
          out = data;
          forApi = data;
        } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
          // rare côté Node ; Socket.io envoie plutôt Buffer
          out = data;
        } else if (data instanceof ArrayBuffer) {
          out = data;
          forApi = Buffer.from(data);
        } else if (ArrayBuffer.isView(data)) {
          out = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
          forApi = out;
        }
      } catch (e) {
        out = null;
      }
    }
    if (!out) return;
    if (forApi && forApi.length) liveJpegs[socket.data.code] = forApi;
    emitLiveFrame(socket.data.code, out);
  });

  // Relais voix : contrôleur ↔ récepteur (pas entre contrôleurs)
  socket.on('talk-audio', (payload) => {
    if (!socket.data.code || !payload) return;
    if (socket.data.role === 'controller') {
      emitToRole(socket.data.code, 'receiver', 'talk-audio', payload);
    } else if (socket.data.role === 'receiver') {
      emitToRole(socket.data.code, 'controller', 'talk-audio', payload);
    }
  });

  socket.on('cam-status', (payload) => {
    if (!socket.data.code || socket.data.role !== 'receiver') return;
    getRoom(socket.data.code).camOn = !!payload.on;
    if (!payload.on) delete liveJpegs[socket.data.code];
    emitToRole(socket.data.code, 'controller', 'cam-status', payload);
  });

  socket.on('battery-status', (payload) => {
    if (!socket.data.code || socket.data.role !== 'receiver') return;
    const room = getRoom(socket.data.code);
    const level = payload && Number.isFinite(Number(payload.level))
      ? Math.max(0, Math.min(100, Math.round(Number(payload.level))))
      : null;
    room.battery = {
      level,
      charging: !!(payload && payload.charging),
      unsupported: !!(payload && payload.unsupported) || level == null,
    };
    emitToRole(socket.data.code, 'controller', 'battery-status', room.battery);
  });

  // --- Horaires : modifiables depuis n'importe quel appareil, synchronisés sur les 2 ---
  socket.on('update-schedules', (schedules) => {
    const room = getRoom(socket.data.code);
    room.schedules = (schedules || []).map(normalizeSchedule);
    persist();
    broadcastRoomState(socket.data.code, room);
  });

  socket.on('update-manual-alarm', ({ messageId, duration, sound1, sound2 }) => {
    if (!socket.data.code) return;
    const room = getRoom(socket.data.code);
    if (!room.manualAlarm) room.manualAlarm = { messageId: '', sound1: 'beep', sound2: '', duration: 30 };
    if (messageId !== undefined) room.manualAlarm.messageId = messageId || '';
    if (sound1 !== undefined) room.manualAlarm.sound1 = sound1 || '';
    if (sound2 !== undefined) room.manualAlarm.sound2 = sound2 || '';
    if (sound2 !== undefined && messageId === undefined) room.manualAlarm.messageId = sound2 || '';
    if (duration !== undefined) room.manualAlarm.duration = Math.min(120, Math.max(5, Number(duration) || 30));
    persist();
    broadcastRoomState(socket.data.code, room);
  });

  // --- Bibliothèque de messages personnalisés : indépendante des horaires, réutilisable ---
  socket.on('save-message', ({ id, name, text }) => {
    const room = getRoom(socket.data.code);
    let msg = room.messages.find((m) => m.id === id);
    if (!msg) {
      msg = { id: id || 'm' + Date.now(), name: name || 'Message', text: text || '', audioUrl: null };
      room.messages.push(msg);
    } else {
      msg.name = name;
      msg.text = text;
    }
    persist();
    broadcastRoomState(socket.data.code, room);
  });

  socket.on('delete-message', ({ id }) => {
    const room = getRoom(socket.data.code);
    const msg = room.messages.find((m) => m.id === id);
    if (msg && msg.audioUrl) {
      const p = path.join(AUDIO_DIR, path.basename(msg.audioUrl));
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    room.messages = room.messages.filter((m) => m.id !== id);
    // Détache ce message des horaires qui l'utilisaient
    room.schedules.forEach((s) => {
      if (s.messageId === id) s.messageId = null;
      if (s.sound2 === id) s.sound2 = '';
      if (s.sound1 === id) s.sound1 = 'beep';
    });
    if (room.manualAlarm) {
      if (room.manualAlarm.messageId === id) room.manualAlarm.messageId = '';
      if (room.manualAlarm.sound2 === id) room.manualAlarm.sound2 = '';
      if (room.manualAlarm.sound1 === id) room.manualAlarm.sound1 = 'beep';
    }
    persist();
    broadcastRoomState(socket.data.code, room);
  });

  socket.on('save-message-audio', ({ messageId, data, ext }) => {
    try {
      const room = getRoom(socket.data.code);
      if (!messageId || !data) {
        socket.emit('audio-save-error', { error: 'Enregistrement vide' });
        return;
      }
      let msg = room.messages.find((m) => m.id === messageId);
      if (!msg) {
        msg = { id: messageId, name: 'Audio', text: '', audioUrl: null };
        room.messages.push(msg);
      }
      const buffer = Buffer.from(data, 'base64');
      if (buffer.length < 200) {
        socket.emit('audio-save-error', { error: 'Enregistrement trop court. Recouche plus longtemps.' });
        return;
      }
      if (msg.audioUrl) {
        const old = path.join(AUDIO_DIR, path.basename(msg.audioUrl));
        if (fs.existsSync(old)) fs.unlinkSync(old);
      }
      const safeExt = (ext || 'webm').replace(/[^a-z0-9]/gi, '') || 'webm';
      const filename = `audio_${messageId}_${Date.now()}.${safeExt}`;
      fs.writeFileSync(path.join(AUDIO_DIR, filename), buffer);
      msg.audioUrl = `/media/audio/${filename}`;
      assignMessageToAlarms(room, msg.id);
      persist();
      broadcastRoomState(socket.data.code, room);
      socket.emit('audio-saved', { id: msg.id, audioUrl: msg.audioUrl });
    } catch (e) {
      console.error('Erreur sauvegarde audio message:', e.message);
      socket.emit('audio-save-error', { error: e.message });
    }
  });

  socket.on('assign-alarm-sound', ({ messageId }) => {
    if (!socket.data.code || !messageId) return;
    const room = getRoom(socket.data.code);
    if (!(room.messages || []).some((m) => m.id === messageId)) return;
    assignMessageToAlarms(room, messageId);
    persist();
    broadcastRoomState(socket.data.code, room);
  });

  socket.on('delete-message-audio', ({ messageId }) => {
    const room = getRoom(socket.data.code);
    const msg = room.messages.find((m) => m.id === messageId);
    if (msg && msg.audioUrl) {
      const p = path.join(AUDIO_DIR, path.basename(msg.audioUrl));
      if (fs.existsSync(p)) fs.unlinkSync(p);
      msg.audioUrl = null;
    }
    persist();
    broadcastRoomState(socket.data.code, room);
  });

  // --- Choix de la caméra du récepteur, relayé dans les 2 sens ---
  socket.on('camera-list', (cams) => {
    if (!socket.data.code) return;
    getRoom(socket.data.code).cameras = cams || [];
    emitToRole(socket.data.code, 'controller', 'camera-list', cams);
  });
  socket.on('switch-camera', (payload) => emitToRole(socket.data.code, 'receiver', 'switch-camera', payload));
  socket.on('torch', (payload) => emitToRole(socket.data.code, 'receiver', 'torch', payload));
  socket.on('torch-status', (payload) => emitToRole(socket.data.code, 'controller', 'torch-status', payload));

  socket.on('take-photo', () => emitToRole(socket.data.code, 'receiver', 'take-photo'));
  socket.on('screen-on', () => {
    if (!socket.data.code) return;
    const room = getRoom(socket.data.code);
    room.screenOn = true;
    // Choix explicite pendant une alarme → ne pas forcer le retour off.
    if (room._restoreScreenOff !== undefined) room._restoreScreenOff = false;
    notifyFlutter('screen', 'on');
    emitToRole(socket.data.code, 'receiver', 'screen-on');
    emitToRole(socket.data.code, 'controller', 'screen-on');
  });
  socket.on('screen-off', () => {
    if (!socket.data.code) return;
    const room = getRoom(socket.data.code);
    room.screenOn = false;
    if (room._restoreScreenOff !== undefined) room._restoreScreenOff = false;
    notifyFlutter('screen', 'off');
    emitToRole(socket.data.code, 'receiver', 'screen-off');
    emitToRole(socket.data.code, 'controller', 'screen-off');
  });
  socket.on('start-video', () => emitToRole(socket.data.code, 'receiver', 'start-video'));
  socket.on('stop-video', () => emitToRole(socket.data.code, 'receiver', 'stop-video'));

  // --- Réception du média capturé par le récepteur : permanent + copie purgeable ---
  socket.on('media-captured', ({ type, data, ext }) => {
    try {
      const buffer = Buffer.from(data, 'base64');
      const filename = `${Date.now()}_${type}.${ext}`;
      fs.writeFileSync(path.join(RECEIVER_DIR, filename), buffer);
      fs.writeFileSync(path.join(CONTROLLER_DIR, filename), buffer);
      broadcastRoomState(socket.data.code, getRoom(socket.data.code));
    } catch (e) {
      console.error('Erreur sauvegarde media:', e.message);
    }
  });

  // --- Suppression manuelle : ne s'applique qu'à la copie contrôleur (le récepteur garde tout) ---
  socket.on('delete-media', (name) => {
    const p = path.join(CONTROLLER_DIR, name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    broadcastRoomState(socket.data.code, getRoom(socket.data.code));
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code) return;
    const room = getRoom(code);
    room.controllerIds.delete(socket.id);
    if (room.receiverId === socket.id) {
      room.receiverId = null;
      room.camOn = false;
      room.cameras = [];
      room.battery = null;
      delete liveJpegs[code];
      emitToRole(code, 'controller', 'cam-status', { on: false });
      emitToRole(code, 'controller', 'battery-status', { level: null, offline: true });
    }
    emitPeers(code, room);
  });
});

function startRoomAlarm(code, { messageId, duration, text, audioUrl, name, sound1, sound2, sequence } = {}) {
  const room = getRoom(code);
  const dur = Math.min(120, Math.max(5, Number(duration) || 30));
  let seq = Array.isArray(sequence) ? sequence.filter(Boolean) : [];
  if (!seq.length) {
    const fake = {
      sound1: sound1 !== undefined ? remapBuiltinSound(sound1) : 'beep',
      sound2: sound2 !== undefined ? sound2 : (messageId || ''),
      messageId: messageId || '',
      duration: dur,
    };
    seq = soundsForSchedule(room, fake);
  }
  if (room._alarmTimer) clearTimeout(room._alarmTimer);
  const firstMsg = seq.find((p) => p && p.type === 'message') || {};
  const spoken = (firstMsg.text || text || firstMsg.name || name || '').trim();
  room._alarmPayload = {
    message: spoken,
    audioUrl: firstMsg.audioUrl || audioUrl || null,
    duration: dur,
    sequence: seq,
  };
  room._alarmUntil = Date.now() + dur * 1000;
  // Mémorise si l’écran était off avant l’alarme (pour le remettre après).
  if (room._restoreScreenOff === undefined) {
    room._restoreScreenOff = room.screenOn === false;
  }
  room.screenOn = true;
  io.to(code).emit('alarm', room._alarmPayload);
  notifyFlutter('screen', 'on');
  notifyFlutter('alarm', JSON.stringify({
    message: spoken || 'C’est l’heure !',
    duration: dur,
  }));
  // Boutons Écran réc+ctrl → on pendant l’alarme.
  emitToRole(code, 'receiver', 'screen-on');
  emitToRole(code, 'controller', 'screen-on');
  room._alarmTimer = setTimeout(() => stopRoomAlarm(code), dur * 1000);
}

function stopRoomAlarm(code) {
  const room = rooms[code];
  if (!room) return;
  if (room._alarmTimer) clearTimeout(room._alarmTimer);
  room._alarmTimer = null;
  room._alarmPayload = null;
  room._alarmUntil = 0;
  const restoreOff = room._restoreScreenOff === true;
  room._restoreScreenOff = undefined;
  io.to(code).emit('alarm-stop');
  notifyFlutter('alarm-stop', '');
  if (restoreOff) {
    room.screenOn = false;
    notifyFlutter('screen', 'off');
    emitToRole(code, 'receiver', 'screen-off');
    emitToRole(code, 'controller', 'screen-off');
  }
}

// --- Vérifie toutes les 5s : horaires du jour (+ rattrapage si minute sautée) ---
const SCHEDULE_GRACE_MINUTES = 3;

function checkScheduledAlarms() {
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let anyFired = false;
  for (const code in rooms) {
    const room = rooms[code];
    if (!room._lastFired) room._lastFired = {};
    const due = [];
    (room.schedules || []).forEach((raw) => {
      const s = normalizeSchedule(raw);
      if (!scheduleIsDue(s, now, SCHEDULE_GRACE_MINUTES)) return;
      const key = `${s.id}|${day}|${s.time}`;
      if (room._lastFired[s.id] === key) return;
      room._lastFired[s.id] = key;
      due.push(s);
    });
    if (!due.length) continue;
    anyFired = true;
    const duration = Math.max.apply(null, due.map((s) => s.duration || 30));
    const sequence = [];
    due.forEach((s) => {
      soundsForSchedule(room, s).forEach((part) => sequence.push(part));
    });
    startRoomAlarm(code, { duration, sequence });
  }
  if (anyFired) {
    try { persist(); } catch (e) {}
  }
}

setInterval(checkScheduledAlarms, 5000);
// Premier passage tôt après démarrage (hydratation déjà faite).
setTimeout(checkScheduledAlarms, 2000);

// --- Purge auto après 24h : UNIQUEMENT sur le stockage contrôleur (le récepteur garde tout) ---
setInterval(() => {
  const now = Date.now();
  const affectedCodes = new Set();
  fs.readdirSync(CONTROLLER_DIR).forEach((f) => {
    const p = path.join(CONTROLLER_DIR, f);
    const stat = fs.statSync(p);
    if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
      fs.unlinkSync(p);
      for (const code in rooms) affectedCodes.add(code);
    }
  });
  affectedCodes.forEach((code) => broadcastRoomState(code, rooms[code]));
}, 30 * 60 * 1000);

function getLocalIp() {
  // Termux / certains environnements Android refusent uv_interface_addresses (errno 13)
  try {
    const nets = os.networkInterfaces();
    if (!nets) return 'localhost';
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if ((net.family === 'IPv4' || net.family === 4) && !net.internal) return net.address;
      }
    }
  } catch (e) {}
  return 'localhost';
}

const TUNNEL_PORT = Number(process.env.TUNNEL_PORT) || (PORT + 1);
const httpOrigin = http.createServer(app);
io.attach(httpOrigin);
httpOrigin.on('error', (err) => {
  console.warn('Origine tunnel HTTP:', err.message || err);
});
httpOrigin.listen(TUNNEL_PORT, '127.0.0.1', () => {
  console.log(`Origine tunnel (HTTP local) : http://127.0.0.1:${TUNNEL_PORT}`);
});

server.on('error', (err) => {
  console.error('Serveur HTTPS:', err && err.message ? err.message : err);
});
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIp();
  console.log('\n=== Gamelle Chat ===');
  console.log(`Sur la tablette (récepteur) : https://localhost:${PORT}`);
  console.log(`Même WiFi                   : https://${ip}:${PORT}`);
  console.log('⚠️  En local : le navigateur affichera un avertissement (certificat auto-signé).');
  console.log('   Clique sur "Avancé" puis "Continuer" — normal.');
  if (process.env.TUNNEL === '0') {
    console.log('Tunnel distant désactivé (TUNNEL=0). Hors WiFi, ça ne marchera pas.');
    console.log('================================================\n');
  } else {
    console.log('Ouverture de l\'accès distant (autre WiFi / 4G)...');
    startPublicTunnel(`http://127.0.0.1:${TUNNEL_PORT}`);
  }
});

function markPublicUrl(url) {
  publicUrl = String(url || '').replace(/\/$/, '');
  if (!publicUrl) return;
  console.log(`Depuis n'importe où (4G / autre WiFi) : ${publicUrl}`);
  console.log('Scanne le QR ou ouvre cette URL sur le Contrôleur.');
  console.log('================================================\n');
}

async function ensureCloudflaredBin() {
  const cf = await import('cloudflared');
  const bin = cf.bin || (cf.default && cf.default.bin);
  const install = cf.install || (cf.default && cf.default.install);
  if (!fs.existsSync(bin)) {
    console.log('Téléchargement de cloudflared (une seule fois)...');
    await install(bin);
  }
  return { cf, bin };
}

async function startNamedTunnel(bin, token, fixedUrl) {
  console.log(`Tunnel nommé Cloudflare → ${fixedUrl}`);
  markPublicUrl(fixedUrl);
  const child = spawn(bin, ['tunnel', '--no-autoupdate', 'run', '--token', token], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let connected = false;
  const onData = (buf) => {
    const text = String(buf || '');
    if (!connected && /Registered tunnel connection/i.test(text)) {
      connected = true;
      console.log('Tunnel nommé connecté.');
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (err) => {
    console.warn('Tunnel nommé:', err.message || err);
  });
  child.on('exit', (code) => {
    if (publicUrl) console.warn('Tunnel distant fermé (code', code, '). Relance le serveur pour le rétablir.');
    publicUrl = null;
  });
  const stop = () => {
    try { child.kill(); } catch (e) {}
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function startQuickTunnel(cf, origin) {
  const Tunnel = cf.Tunnel || (cf.default && cf.default.Tunnel);
  const tunnelOpts = origin.startsWith('https:') ? { '--no-tls-verify': true } : {};
  const tunnel = Tunnel.quick(origin, tunnelOpts);
  tunnel.once('url', (url) => {
    markPublicUrl(url);
  });
  tunnel.on('error', (err) => {
    console.warn('Tunnel:', err.message || err);
  });
  tunnel.on('exit', (code) => {
    if (publicUrl) console.warn('Tunnel distant fermé (code', code, '). Relance le serveur pour le rétablir.');
    publicUrl = null;
  });
  const stop = () => { try { tunnel.stop(); } catch (e) {} };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function startPublicTunnel(origin) {
  try {
    const { cf, bin } = await ensureCloudflaredBin();
    const token = readTunnelToken();
    const fixedUrl = tunnelConfig.publicUrl;
    if (token && fixedUrl && isAllowedPublicUrl(fixedUrl)) {
      await startNamedTunnel(bin, token, fixedUrl);
      return;
    }
    if (token && !fixedUrl) {
      console.warn('Token tunnel présent mais tunnel.config.json sans publicUrl — fallback quick tunnel.');
    } else if (!token && fixedUrl) {
      console.warn('URL fixe configurée mais tunnel.token manquant — fallback quick tunnel (URL variable).');
      console.warn('Crée un Named Tunnel Cloudflare et mets le token dans tunnel.token');
    }
    await startQuickTunnel(cf, origin);
  } catch (e) {
    console.warn('Accès distant indisponible:', e.message);
    console.warn('Les 2 appareils devront être sur le même WiFi (ou relance après npm install).');
    console.log('================================================\n');
  }
}
