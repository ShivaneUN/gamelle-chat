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
  if (process.env.GAMELLE_STORE) {
    const root = path.resolve(process.env.GAMELLE_STORE);
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    return root;
  }
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
    else if (name === 'public-url.json' || name === 'accounts.json' || name === 'sessions.json' || name === 'accounts-wipe.json' || name === 'sessions-close.json') continue;
    else if (!fs.existsSync(to)) {
      try { fs.copyFileSync(from, to); } catch (e) {}
    }
  }
}

const STORE = storageRoot();

const app = express();

function setUncached(res) {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  res.setHeader('Surrogate-Control', 'no-store');
}

// Le lien public est toujours /controller.html, sans ?v=.
// Ces en-têtes empêchent le téléphone et Cloudflare de figer cette adresse.
app.use((req, res, next) => {
  if (String(req.path || '').startsWith('/media/')) return next();
  setUncached(res);
  next();
});

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

// Port 3000 en HTTP : le tunnel nommé envoie le domaine en clair (ingress Cloudflare).
// Un serveur TLS sur ce port cassait le lien domaine. La tablette ouvre http://127.0.0.1.
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5e7,
  // 4G / tunnel Cloudflare : pings trop serrés → fausse déco contrôleur.
  pingTimeout: 60000,
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

/** Les copies ne réimportent plus de comptes : un identifiant déjà présent n’est jamais doublé. */
function mergeAccountsFrom() {
  return;
}

console.log('Stockage persistant :', STORE);

app.use((req, res, next) => {
  // Ne pas toucher à autoplay : un header trop strict coupe bip / TTS / audio en HTTPS local
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

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
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('saveJsonFile', file, e && e.message);
    try {
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (e2) {
      console.error('saveJsonFile.retry', file, e2 && e2.message);
      throw e2;
    }
  }
}

function isLocalRequest(req) {
  // Trafic Cloudflare / tunnel : jamais « tablette locale » (cloudflared proxyfie en 127.0.0.1).
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['cf-visitor']) {
    return false;
  }
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (host.endsWith('.trycloudflare.com') || host === 'api.trycloudflare.com') return false;
  if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    // Nom de domaine public (Named Tunnel) ≠ keyhole tablette.
    if (host.includes('.') && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  }
  const raw = String(req.socket && req.socket.remoteAddress || '');
  const ip = raw.replace(/^::ffff:/i, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function isPrivateIp(ip) {
  const h = String(ip || '').replace(/^::ffff:/i, '').toLowerCase();
  if (h === '127.0.0.1' || h === '::1' || h === 'localhost') return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(h)) return true;
  return false;
}

function isLanRequest(req) {
  if (!req) return false;
  const headers = req.headers || {};
  if (headers['cf-connecting-ip'] || headers['cf-ray'] || headers['cf-visitor']) return false;
  const host = String(headers.host || '').split(':')[0].toLowerCase();
  if (host.endsWith('.trycloudflare.com') || host === 'api.trycloudflare.com') return false;
  if (host && host.includes('.') && host !== 'localhost' && !isPrivateIp(host)) return false;
  const ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/i, '');
  return isPrivateIp(ip);
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

// Une seule fois : la 0.1.28 repart sans les anciens comptes.
// Les copies APK / trash ne sont plus fusionnées : le fichier du serveur est la seule source.
const ACCOUNTS_RESET_ID = '0.1.29';
function blankAccountCopy(file, data) {
  try {
    if (!file || !fs.existsSync(file)) return;
    const resolved = path.resolve(file);
    if (resolved === path.resolve(ACCOUNTS_FILE) || resolved === path.resolve(SESSIONS_FILE)) return;
    fs.writeFileSync(file, JSON.stringify(data));
  } catch (e) {}
}
function resetAccountsOnce() {
  const marker = path.join(DATA_DIR, 'accounts-wipe.json');
  let done = '';
  try {
    done = String(JSON.parse(fs.readFileSync(marker, 'utf8')).id || '');
  } catch (e) {}
  if (done === ACCOUNTS_RESET_ID) return;
  writeAccounts({ users: [] });
  writeSessions({ sessions: [] });
  if (isMobileBundle()) {
    [
      path.join(__dirname, 'data'),
      path.join(__dirname, '..', 'nodejs-project-trash', 'data'),
    ].forEach((dir) => {
      blankAccountCopy(path.join(dir, 'accounts.json'), { users: [] });
      blankAccountCopy(path.join(dir, 'sessions.json'), { sessions: [] });
    });
  }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ id: ACCOUNTS_RESET_ID }));
  } catch (e) {}
  console.log('Comptes effacés pour la mise à jour 0.1.29.');
}
resetAccountsOnce();

// Un identifiant = un compte. On garde le premier (celui qui existait déjà)
// et on retire les lignes recopiées ensuite.
function dedupeAccounts() {
  const accounts = readAccounts();
  const kept = [];
  const seenName = new Set();
  const seenId = new Set();
  const droppedIds = [];
  for (const u of accounts.users) {
    if (!u || typeof u !== 'object') continue;
    const name = normUser(u.username);
    const id = u.id ? String(u.id) : '';
    if (!name || seenName.has(name) || (id && seenId.has(id))) {
      if (id) droppedIds.push(id);
      continue;
    }
    seenName.add(name);
    if (id) seenId.add(id);
    kept.push(u);
  }
  if (kept.length === accounts.users.length && droppedIds.length === 0) return;
  writeAccounts({ users: kept });
  if (droppedIds.length) {
    const sessions = readSessions();
    const next = sessions.sessions.filter((s) => s && !droppedIds.includes(String(s.userId)));
    if (next.length !== sessions.sessions.length) writeSessions({ sessions: next });
  }
  console.log('Comptes en double retirés :', accounts.users.length - kept.length);
}
dedupeAccounts();

// Ferme les sessions encore ouvertes une fois : plus personne n'est « déjà connecté ».
const SESSIONS_CLOSE_ID = '0.1.32';
function closeOpenSessionsOnce() {
  const marker = path.join(DATA_DIR, 'sessions-close.json');
  let done = '';
  try {
    done = String(JSON.parse(fs.readFileSync(marker, 'utf8')).id || '');
  } catch (e) {}
  if (done === SESSIONS_CLOSE_ID) return;
  writeSessions({ sessions: [] });
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ id: SESSIONS_CLOSE_ID }));
  } catch (e) {}
  console.log('Sessions ouvertes fermées.');
}
closeOpenSessionsOnce();

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}

function normUser(s) {
  return String(s || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .normalize('NFC')
    .toLowerCase();
}

function findUserByName(accounts, username) {
  const want = normUser(username);
  if (!want || !accounts || !Array.isArray(accounts.users)) return null;
  return accounts.users.find((u) => u && u.username && normUser(u.username) === want) || null;
}

function accountNames(accounts) {
  return (accounts && accounts.users || [])
    .map((u) => (u && u.username ? String(u.username) : ''))
    .filter(Boolean);
}

function passwordMatches(user, password) {
  const hashHex = String(user && user.passHash || '').trim().toLowerCase();
  const salt = String(user && user.salt || '');
  if (!/^[0-9a-f]+$/i.test(hashHex) || hashHex.length < 32 || !salt) return false;
  const expected = Buffer.from(hashHex, 'hex');
  if (!expected.length) return false;
  try {
    const got = Buffer.from(hashPassword(password, salt), 'hex');
    if (got.length !== expected.length) return false;
    return crypto.timingSafeEqual(got, expected);
  } catch (e) {
    return false;
  }
}

function passwordAccepted(user, password) {
  const raw = String(password ?? '');
  const seen = [];
  const push = (value) => {
    const s = String(value ?? '');
    if (!seen.includes(s)) seen.push(s);
  };
  push(raw);
  try { push(raw.normalize('NFC')); } catch (e) {}
  try { push(raw.normalize('NFD')); } catch (e) {}
  seen.slice().forEach((s) => push(s.replace(/[\u200B-\u200D\uFEFF]/g, '')));
  for (const candidate of seen) {
    if (passwordMatches(user, candidate)) return true;
  }
  return false;
}

function publicUser(u) {
  return { id: u.id, username: u.username, createdAt: u.createdAt || null };
}

function getUserByToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  const sessions = readSessions();
  const s = sessions.sessions.find((x) => x && x.token === t);
  if (!s) return null;
  const ageMs = Date.now() - Number(s.createdAt || 0);
  if (Number.isFinite(ageMs) && ageMs > SESSION_MAX_AGE_SEC * 1000) {
    destroySession(t);
    return null;
  }
  const accounts = readAccounts();
  const u = accounts.users.find((x) => x && x.id === s.userId);
  if (!u) return null;
  return { id: u.id, username: u.username, token: t };
}

function sessionTokenCandidates(req) {
  const out = [];
  const push = (value) => {
    const token = String(value || '').trim();
    if (token && !out.includes(token)) out.push(token);
  };
  // Le Bearer est le jeton réel du téléphone. Un vieux cookie ne doit pas le masquer.
  const auth = String((req && req.headers && req.headers.authorization) || '');
  if (/^bearer\s+/i.test(auth)) push(auth.replace(/^bearer\s+/i, ''));
  try {
    if (req && req.query && req.query.access) push(req.query.access);
  } catch (e) {}
  if (req) push(parseCookies(req)[SESSION_COOKIE]);
  return out;
}

function extractSessionToken(req) {
  const candidates = sessionTokenCandidates(req);
  for (const token of candidates) {
    if (getUserByToken(token)) return token;
  }
  return candidates[0] || '';
}

function getSessionUser(req) {
  return getUserByToken(extractSessionToken(req));
}

function getSocketSessionUser(socket) {
  if (!socket) return null;
  const fromReq = getSessionUser(socket.request);
  if (fromReq) return fromReq;
  const auth = (socket.handshake && socket.handshake.auth) || {};
  if (auth.token) return getUserByToken(auth.token);
  const q = (socket.handshake && socket.handshake.query) || {};
  if (q.access) return getUserByToken(q.access);
  return null;
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

function destroySessionsForUser(userId) {
  if (!userId) return;
  const sessions = readSessions();
  sessions.sessions = sessions.sessions.filter((s) => !(s && s.userId === userId));
  writeSessions(sessions);
}

/**
 * Le même compte change de réseau (Wi-Fi → 4G) : la nouvelle prise remplace l’ancienne
 * tout de suite. Pas de déconnexion du compte, la session reste ouverte.
 */
function replaceControllerSockets(userId, keepSocketId) {
  if (!userId || !io || !io.sockets || !io.sockets.sockets) return;
  for (const s of [...io.sockets.sockets.values()]) {
    if (!s || s.id === keepSocketId) continue;
    if (!s.data || s.data.role !== 'controller' || s.data.userId !== userId) continue;
    s.data.replaced = true;
    const code = s.data.code;
    if (code && rooms[code] && rooms[code].controllerIds) rooms[code].controllerIds.delete(s.id);
    try { s.disconnect(true); } catch (e) {}
  }
}

/** Ferme vraiment les sockets contrôleur de ce compte (déconnexion demandée). */
function disconnectControllersForUser(userId, exceptSocketId) {
  if (!userId || !io || !io.sockets || !io.sockets.sockets) return;
  for (const s of io.sockets.sockets.values()) {
    if (!s || s.id === exceptSocketId) continue;
    if (s.data && s.data.role === 'controller' && s.data.userId === userId) {
      try { s.emit('logged-out', { error: 'Déconnecté du serveur' }); } catch (e) {}
      try { s.disconnect(true); } catch (e) {}
    }
  }
}

function userHasLiveController(userId) {
  if (!userId || !io || !io.sockets || !io.sockets.sockets) return false;
  for (const s of io.sockets.sockets.values()) {
    if (!s || !s.connected) continue;
    if (s.data && s.data.role === 'controller' && s.data.userId === userId) return true;
  }
  return false;
}

function touchSession(token) {
  if (!token) return;
  const sessions = readSessions();
  const s = sessions.sessions.find((x) => x && x.token === token);
  if (!s) return;
  const now = Date.now();
  // Evite d'écrire le JSON à chaque join/ping (flash Android / crash IO).
  if (s.lastSeen && now - Number(s.lastSeen) < 60 * 1000) return;
  s.lastSeen = now;
  writeSessions(sessions);
}

function requestIsHttps(req) {
  if (req && req.secure) return true;
  const xf = String((req && req.headers && req.headers['x-forwarded-proto']) || '');
  return xf.includes('https');
}

function setSessionCookie(res, token, req) {
  const secure = requestIsHttps(req);
  let c = `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}`;
  if (secure) c += '; Secure';
  // setHeader (pas append) : certains reverse-proxy / Express 5 gèrent mal multi Set-Cookie.
  res.setHeader('Set-Cookie', c);
}

function clearSessionCookie(res, req) {
  const secure = requestIsHttps(req);
  let c = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  if (secure) c += '; Secure';
  res.setHeader('Set-Cookie', c);
}

function htmlWithAbsoluteLogo(html, req) {
  const base = (publicUrl || `${req.protocol}://${req.get('host') || 'localhost'}`).replace(/\/$/, '');
  return String(html || '')
    .replace(/content="\/logo\.png"/g, `content="${base}/logo.png"`)
    .replace(/href="\/(favicon-[^"]+|apple-touch-icon\.png)"/g, `href="${base}/$1"`);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlFreshnessGuard(version) {
  const ver = String(version || '');
  if (!ver) return '';
  const meta = `<meta name="gamelle-version" content="${ver.replace(/"/g, '')}">`;
  const script = `<script>(function(){var pageVer=${JSON.stringify(ver)};` +
    `fetch("/api/info",{cache:"no-store",credentials:"same-origin"})` +
    `.then(function(r){return r.json()})` +
    `.then(function(info){var live=info&&String(info.version||"");if(!live||live===pageVer)return;` +
    `try{if(sessionStorage.getItem("gamelle-html-reload")===live)return;sessionStorage.setItem("gamelle-html-reload",live)}catch(e){}` +
    `fetch(location.pathname+location.search,{cache:"reload",credentials:"same-origin",headers:{Accept:"text/html"}})` +
    `.then(function(r){return r.text()})` +
    `.then(function(html){if(!html||html.indexOf('name="gamelle-version" content="'+live+'"')<0)return;document.open();document.write(html);document.close()})` +
    `}).catch(function(){})})();</script>`;
  return meta + script;
}

function sendHtml(res, req, file, extra) {
  const full = path.join(__dirname, 'public', file);
  fs.readFile(full, 'utf8', (err, html) => {
    if (err) {
      res.status(404).send('Not found');
      return;
    }
    const info = extra || {};
    const version = info.version || updater.pkgVersion();
    let out = htmlWithAbsoluteLogo(html, req)
      .replace('<!--LOGIN_ERROR-->', escapeHtml(info.error || ''))
      .replace(/<!--SERVER_VER-->/g, escapeHtml(version));
    if (out.includes('<head>') && !out.includes('name="gamelle-version"')) {
      out = out.replace('<head>', '<head>' + htmlFreshnessGuard(version));
    }
    const assetVer = encodeURIComponent(version);
    out = out.replace(
      /(src|href)="(\/[^"]+?\.(?:js|css))(?:\?[^"]*)?"/gi,
      (_, attr, url) => `${attr}="${url}?v=${assetVer}"`
    );
    setUncached(res);
    if (file === 'controller.html') res.setHeader('X-Gamelle-Page', 'controller');
    res.type('html').send(out);
  });
}

app.get(['/', '/index.html', '/login'], (req, res) => {
  let user = null;
  try { user = getSessionUser(req); } catch (e) { user = null; }
  if (user && !req.query.e) {
    return res.redirect(302, '/controller.html');
  }
  sendHtml(res, req, 'index.html', {
    error: String(req.query.e || ''),
    version: updater.pkgVersion(),
  });
});

app.get('/controller.html', (req, res) => {
  // access=<token> : pose un cookie si possible, puis sert la page (pas de redirect
  // qui re-demanderait le cookie — critique quand Safari/CF bloque HttpOnly).
  const access = String((req.query && req.query.access) || '').trim();
  if (access) {
    const user = getUserByToken(access);
    if (!user) return res.redirect(302, '/?next=controller&reason=session');
    setSessionCookie(res, access, req);
    return sendHtml(res, req, 'controller.html');
  }
  if (!isLanRequest(req) && !getSessionUser(req)) {
    return sendHtml(res, req, 'index.html', {
      error: '',
      version: updater.pkgVersion(),
    });
  }
  sendHtml(res, req, 'controller.html');
});

app.get('/receiver.html', (req, res) => {
  sendHtml(res, req, 'receiver.html');
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(js|mjs|css|html)$/i.test(String(filePath || ''))) setUncached(res);
  },
}));

function requireSessionOrLocal(req, res, next) {
  if (isLocalRequest(req) || getSessionUser(req)) return next();
  res.status(401).type('text').send('Connexion requise');
}
app.use('/media/receiver', requireSessionOrLocal, express.static(RECEIVER_DIR));
app.use('/media/controller', requireSessionOrLocal, express.static(CONTROLLER_DIR));
app.use('/media/audio', requireSessionOrLocal, express.static(AUDIO_DIR));

app.get('/api/auth/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.json({ ok: true, authenticated: false });
  res.json({
    ok: true,
    authenticated: true,
    user: { id: user.id, username: user.username },
  });
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
  const wanted = normUser(username);
  if (accounts.users.some((u) => u && normUser(u.username) === wanted)) {
    return res.status(409).json({ ok: false, error: 'Identifiant déjà pris' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const passHash = hashPassword(password, salt);
  const usedIds = new Set(accounts.users.map((u) => (u && u.id ? String(u.id) : '')).filter(Boolean));
  let id = crypto.randomBytes(8).toString('hex');
  while (usedIds.has(id)) id = crypto.randomBytes(8).toString('hex');
  const user = {
    id,
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

function wantsJsonLogin(req) {
  const ct = String((req.headers && req.headers['content-type']) || '');
  const accept = String((req.headers && req.headers.accept) || '');
  return ct.includes('application/json') || accept.includes('application/json');
}

function sendLoginFail(req, res, status, error, code) {
  if (wantsJsonLogin(req)) return res.status(status).json({ ok: false, error, code: code || '' });
  return res.redirect(302, '/login?e=' + encodeURIComponent(error));
}

function sendLoginOk(req, res, user, token, replaced) {
  try { setSessionCookie(res, token, req); } catch (e) {}
  if (wantsJsonLogin(req)) {
    return res.json({ ok: true, user: publicUser(user), token, replaced: !!replaced });
  }
  return res.redirect(302, '/controller.html?access=' + encodeURIComponent(token));
}

app.post('/api/auth/login', (req, res) => {
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const username = String(body['gamelle-id'] || body['gamelle-user'] || body.username || '').trim();
    const password = String(body['gamelle-secret'] || body['gamelle-pass'] || body.password || '');
    const accounts = readAccounts();
    if (!username || !password) {
      return sendLoginFail(req, res, 401, 'Identifiant et mot de passe requis.', 'empty');
    }
    if (!accounts.users.length) {
      return sendLoginFail(req, res, 401, 'Aucun compte sur la tablette. Ouvre Comptes et crée-en un.', 'no-accounts');
    }
    const user = findUserByName(accounts, username);
    const known = accountNames(accounts);
    if (!user || !user.salt || !user.passHash) {
      const error = known.length
        ? `Pas de compte « ${username} ». Comptes sur la tablette : ${known.join(', ')}.`
        : 'Aucun compte sur la tablette. Ouvre Comptes et crée-en un.';
      return sendLoginFail(req, res, 401, error, 'unknown-user');
    }
    let ok = false;
    try {
      ok = passwordAccepted(user, password);
    } catch (e) {
      return sendLoginFail(req, res, 500, 'Vérification impossible. Réessaie.', 'verify-failed');
    }
    if (!ok) {
      return sendLoginFail(req, res, 401, `Mot de passe incorrect pour « ${user.username} ».`, 'bad-password');
    }

    let current = null;
    try { current = getSessionUser(req); } catch (e) { current = null; }
    if (current && current.id === user.id) {
      try { touchSession(current.token); } catch (e) {}
      return sendLoginOk(req, res, user, current.token, false);
    }

    // Une vraie session encore ouverte bloque. Un socket resté après la déconnexion, non.
    if (userHasLiveController(user.id) && findSessionsForUser(user.id).length) {
      return sendLoginFail(
        req,
        res,
        409,
        'Ce compte est déjà connecté sur un autre appareil. Déconnecte-toi là-bas avant de te connecter ici.',
        'SESSION_ACTIVE'
      );
    }
    disconnectControllersForUser(user.id);
    destroySessionsForUser(user.id);

    const token = createSession(user.id);
    const check = readSessions().sessions.find((s) => s && s.token === token);
    if (!check) {
      return sendLoginFail(req, res, 500, 'Impossible d’enregistrer la session. Réessaie.', 'session');
    }
    return sendLoginOk(req, res, user, token, false);
  } catch (e) {
    console.error('login', e && e.message);
    return sendLoginFail(req, res, 500, 'Connexion impossible. Réessaie.', 'crash');
  }
});

app.post('/api/auth/logout', (req, res) => {
  const user = getSessionUser(req);
  if (user && user.id) {
    destroySessionsForUser(user.id);
    disconnectControllersForUser(user.id);
  }
  clearSessionCookie(res, req);
  res.json({ ok: true, loggedOut: true });
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

app.get('/api/info', (req, res) => {
  const trusted = isLocalRequest(req) || !!getSessionUser(req);
  const body = {
    publicUrl: publicUrl || readNativePublicUrl(),
    version: updater.pkgVersion(),
  };
  if (trusted) {
    body.localUrl = `http://${getLocalIp()}:${PORT}`;
    body.pairCode = readActiveCode();
  }
  res.json(body);
});

app.get('/api/active-code', (req, res) => {
  if (!isLocalRequest(req) && !getSessionUser(req)) {
    return res.status(401).json({ ok: false, error: 'Connexion requise' });
  }
  res.json({ code: readActiveCode() });
});

const linkState = {
  code: String(Math.floor(100000 + Math.random() * 900000)),
};
const pendingSatellites = new Map();
let pairingMode = { on: false, name: '' };
let pairOffer = null;

function cleanCamName(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

function cleanNearby(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  rows.slice(0, 12).forEach((row) => {
    const host = String(row && row.host || '').trim().slice(0, 64);
    if (!isPrivateIp(host)) return;
    const kind = row && row.kind === 'camera' ? 'camera' : 'gamelle';
    const port = Math.max(1, Math.min(65535, Number(row && row.port) || (kind === 'camera' ? 80 : 3000)));
    out.push({
      kind,
      name: cleanCamName(row && row.name) || (kind === 'camera' ? 'Caméra Wi-Fi' : 'Caméra'),
      host,
      port,
    });
  });
  return out;
}

function isSatelliteJoinUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (!u.pathname.endsWith('/satellite.html')) return false;
    return !!u.searchParams.get('k');
  } catch (e) {
    return false;
  }
}

app.get('/api/link', (req, res) => {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ ok: false, error: 'Réservé à la tablette' });
  }
  const room = readActiveCode();
  const url = `http://${getLocalIp()}:${PORT}/satellite.html?k=${linkState.code}&c=${encodeURIComponent(room)}`;
  res.json({ ok: true, code: linkState.code, url });
});

app.post('/api/pairing', (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ ok: false, error: 'Réservé à la tablette' });
  const on = !!(req.body && req.body.on);
  const name = cleanCamName(req.body && req.body.name);
  pairingMode = { on, name: name || pairingMode.name };
  if (!on) pairOffer = null;
  res.json({ ok: true, on: pairingMode.on, name: pairingMode.name });
});

app.post('/api/pair-join', (req, res) => {
  if (!isLanRequest(req)) return res.status(403).json({ ok: false, error: 'Réservé au Wi-Fi' });
  if (!pairingMode.on) return res.status(409).json({ ok: false, error: 'Pas en jumelage' });
  const url = String((req.body && req.body.url) || '').trim();
  if (!isSatelliteJoinUrl(url)) return res.status(400).json({ ok: false, error: 'Lien refusé' });
  pairOffer = { url, at: Date.now() };
  res.json({ ok: true });
});

app.get('/api/pair-offer', (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ ok: false, error: 'Réservé à la tablette' });
  const offer = pairOffer;
  pairOffer = null;
  const fresh = offer && (Date.now() - offer.at) < 20000;
  res.json({ ok: true, url: fresh ? offer.url : '' });
});

app.post('/api/alarm-stop', (_req, res) => {
  stopAllRoomAlarms();
  res.json({ ok: true });
});
app.get('/api/alarm-stop', (_req, res) => {
  stopAllRoomAlarms();
  res.json({ ok: true });
});

app.get('/c/:code', (req, res) => {
  const code = String(req.params.code || '').trim();
  if (!/^[0-9A-Za-z]{4,12}$/.test(code)) return res.redirect('/');
  if (!isLanRequest(req) && !getSessionUser(req)) {
    return res.redirect(302, '/?next=controller&code=' + encodeURIComponent(code));
  }
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
  for (const code in rooms) {
    if (!code || code === 'undefined' || code === 'null') continue;
    const vol = Number(rooms[code].outputVolume);
    dump[code] = {
      schedules: rooms[code].schedules,
      messages: rooms[code].messages,
      manualAlarm: rooms[code].manualAlarm || { messageId: '', sound1: 'beep', sound2: '', duration: 30 },
      outputVolume: Number.isFinite(vol) ? Math.max(0, Math.min(100, Math.round(vol))) : 70,
      lastFired: rooms[code]._lastFired || {},
    };
  }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(dump, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(dump, null, 2)); } catch (e2) {}
  }
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
  let delta = nowMin - schedMin;
  // Rattrapage juste après minuit (ex. 23:59 → 00:01).
  if (delta < -12 * 60) delta += 24 * 60;
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
  if (id === 'beep' || id === 'chime' || id === 'bell' || id === 'siren' || id === 'alert' || id === 'ding' || id === 'whistle' || id === 'knock' || id === 'phone' || id === 'horn') {
    return { type: 'builtin', id };
  }
  const msg = (room.messages || []).find((m) => m.id === id);
  // Message disparu / id invalide → ignorer (évite un 2e bip fantôme « un seul son »).
  if (!msg) return null;
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
  const key = String(code || '').trim();
  if (!key || key === 'undefined' || key === 'null') {
    throw new Error('pair code invalide');
  }
  if (!rooms[key]) {
    const saved = persisted[key] || {};
    const lastFired = (saved.lastFired && typeof saved.lastFired === 'object') ? { ...saved.lastFired } : {};
    const vol = Number(saved.outputVolume);
    rooms[key] = {
      schedules: (saved.schedules || []).map(normalizeSchedule),
      messages: saved.messages || [],
      manualAlarm: saved.manualAlarm || { messageId: '', sound1: 'beep', sound2: '', duration: 30 },
      outputVolume: Number.isFinite(vol) ? Math.max(0, Math.min(100, Math.round(vol))) : 70,
      _lastFired: lastFired,
      controllerIds: new Set(),
      receiverId: null,
      satelliteId: null,
      names: { main: 'Tablette', cam2: 'Caméra 2' },
      camOn: false,
      screenOn: true,
      cameras: [],
    };
  }
  if (!rooms[key].controllerIds) rooms[key].controllerIds = new Set();
  if (!Number.isFinite(Number(rooms[key].outputVolume))) rooms[key].outputVolume = 70;
  return rooms[key];
}

/** Charge le salon actif (+ données) dès le boot. Les autres codes restent en fichier mais ne tickent pas. */
function hydrateRoomsFromPersisted() {
  const active = readActiveCode();
  if (active) {
    try { getRoom(active); } catch (e) {}
  }
  // Si l’actif n’a aucun horaire mais un ancien code en a, on fusionne vers l’actif (anti-fantômes).
  if (active && rooms[active] && !(rooms[active].schedules || []).length) {
    let bestCode = null;
    let bestW = 0;
    Object.keys(persisted || {}).forEach((code) => {
      if (code === active) return;
      const w = roomWeight(persisted[code]);
      if (w > bestW) {
        bestW = w;
        bestCode = code;
      }
    });
    if (bestCode && bestW > 0) {
      const src = persisted[bestCode] || {};
      rooms[active].schedules = (src.schedules || []).map(normalizeSchedule);
      if (!(rooms[active].messages || []).length) rooms[active].messages = src.messages || [];
      if (src.manualAlarm) rooms[active].manualAlarm = src.manualAlarm;
      if (src.lastFired) rooms[active]._lastFired = { ...src.lastFired };
      try { persist(); } catch (e) {}
    }
  }
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

function deviceSnapshot(code) {
  const room = rooms[code];
  if (!room) return { main: false, satellite: false, pending: [] };
  const pending = [];
  pendingSatellites.forEach((id, guest) => {
    if (io.sockets.sockets.get(id)) pending.push(String(guest));
  });
  if (!room.names) room.names = { main: 'Tablette', cam2: 'Caméra 2' };
  const satelliteOn = !!(room.satelliteId && io.sockets.sockets.get(room.satelliteId));
  if (satelliteOn) room.hadSatellite = true;
  return {
    main: !!(room.receiverId && io.sockets.sockets.get(room.receiverId)),
    satellite: satelliteOn,
    satelliteKnown: !!room.hadSatellite,
    names: room.names,
    mediaSync: !!room.mediaSync,
    pending,
  };
}

function emitDevices(code) {
  if (!code) return;
  const snap = deviceSnapshot(code);
  emitToRole(code, 'receiver', 'devices', snap);
  emitToRole(code, 'controller', 'devices', snap);
  emitToRole(code, 'satellite', 'devices', snap);
}

function emitToTargets(code, target, event, payload) {
  const room = rooms[code];
  if (!room) return;
  const all = !target || target === 'all' || target === 'ensemble';
  if (all || target === 'main') {
    const s = room.receiverId && io.sockets.sockets.get(room.receiverId);
    if (s) s.emit(event, payload);
  }
  if (all || target === 'cam2') {
    const s = room.satelliteId && io.sockets.sockets.get(room.satelliteId);
    if (s) s.emit(event, payload);
  }
}

function acceptSatellite(sock, roomCode) {
  if (!sock || !roomCode) return;
  const room = getRoom(roomCode);
  if (room.satelliteId && room.satelliteId !== sock.id) {
    const prev = io.sockets.sockets.get(room.satelliteId);
    if (prev) {
      try { prev.disconnect(true); } catch (e) {}
    }
  }
  sock.join(roomCode);
  sock.data.code = roomCode;
  sock.data.role = 'satellite';
  sock.data.deviceId = 'cam2';
  room.satelliteId = sock.id;
  if (!room.names) room.names = { main: 'Tablette', cam2: 'Caméra 2' };
  const wanted = cleanCamName(sock.data.camName);
  if (wanted) room.names.cam2 = wanted;
  sock.emit('satellite-ok', { name: room.names.cam2 || 'Caméra 2' });
  emitDevices(roomCode);
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
  const seen = new Set();
  for (const id of room.controllerIds) {
    const s = io.sockets.sockets.get(id);
    if (!s || s.data.replaced) continue;
    const uid = s.data && s.data.userId ? String(s.data.userId) : '';
    const key = uid || ('socket:' + id);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = s.data && s.data.username ? String(s.data.username) : '';
    names.push(name || 'Contrôleur');
  }
  names.sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  io.to(code).emit('peers', {
    controllers: seen.size,
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
    const vol = Number(room.outputVolume);
    s.emit('room-state', {
      schedules: room.schedules,
      messages: room.messages,
      media,
      manualAlarm: room.manualAlarm || { messageId: '', duration: 30 },
      screenOn: room.screenOn !== false,
      camOn: !!room.camOn,
      outputVolume: Number.isFinite(vol) ? Math.max(0, Math.min(100, Math.round(vol))) : 70,
    });
  });
}

function sharedPairCode() {
  try {
    const active = ensureActiveCode();
    if (active && String(active).trim().length >= 4) return String(active).trim();
  } catch (e) {}
  return '';
}

function pullControllersTo(pair) {
  if (!pair || !io || !io.sockets || !io.sockets.sockets) return;
  for (const s of io.sockets.sockets.values()) {
    if (!s || !s.data || s.data.role !== 'controller' || s.data.code === pair) continue;
    const prev = s.data.code;
    if (prev) {
      try { s.leave(prev); } catch (e) {}
      const old = rooms[prev];
      if (old && old.controllerIds) {
        old.controllerIds.delete(s.id);
        emitPeers(prev, old);
      }
    }
    let room;
    try { room = getRoom(pair); } catch (e) { continue; }
    s.join(pair);
    s.data.code = pair;
    room.controllerIds.add(s.id);
    s.emit('active-code', { code: pair });
    emitPeers(pair, room);
  }
}

io.on('connection', (socket) => {
  socket.on('join', ({ code, role }) => {
    if (role !== 'controller' && role !== 'receiver') {
      socket.emit('join-error', { error: 'Rôle invalide' });
      return;
    }
    if (role === 'controller') {
      const user = getSocketSessionUser(socket);
      if (!user && !isLanRequest(socket.request)) {
        socket.emit('auth-required', { error: 'Connexion requise' });
        socket.disconnect(true);
        return;
      }
      if (user) {
        socket.data.userId = user.id;
        socket.data.username = user.username;
        touchSession(user.token);
      } else {
        socket.data.username = 'Local';
      }
    }
    if (role === 'receiver' && !isLocalRequest(socket.request)) {
      socket.emit('join-error', { error: 'Récepteur réservé à la tablette' });
      socket.disconnect(true);
      return;
    }
    const pair = sharedPairCode();
    if (!pair || pair.length < 4 || pair === 'undefined') {
      socket.emit('join-error', { error: 'Code de jumelage invalide' });
      return;
    }
    if (socket.data.code && socket.data.code !== pair) {
      const prev = socket.data.code;
      try { socket.leave(prev); } catch (e) {}
      const old = rooms[prev];
      if (old) {
        old.controllerIds.delete(socket.id);
        if (old.receiverId === socket.id) old.receiverId = null;
        emitPeers(prev, old);
      }
    }
    let room;
    try {
      room = getRoom(pair);
    } catch (e) {
      socket.emit('join-error', { error: 'Code de jumelage invalide' });
      return;
    }
    socket.join(pair);
    socket.data.code = pair;
    socket.data.role = role;

    if (role === 'controller') {
      if (socket.data.userId) replaceControllerSockets(socket.data.userId, socket.id);
      room.controllerIds.add(socket.id);
    }
    if (role === 'receiver') {
      room.receiverId = socket.id;
      writeActiveCode(pair);
      pullControllersTo(pair);
    }
    socket.emit('active-code', { code: pair });

    emitPeers(pair, room);
    if (role === 'receiver' || role === 'controller') emitDevices(pair);
    if (role === 'controller') {
      if (Array.isArray(room.nearby)) socket.emit('nearby', room.nearby);
      if (room.pairUrl) socket.emit('link-share', { url: room.pairUrl });
    }

    const media = role === 'receiver' ? receiverMedia() : controllerMedia();
    const joinVol = Number(room.outputVolume);
    socket.emit('room-state', {
      schedules: room.schedules,
      messages: room.messages,
      media,
      manualAlarm: room.manualAlarm || { messageId: '', duration: 30 },
      screenOn: room.screenOn !== false,
      camOn: !!room.camOn,
      outputVolume: Number.isFinite(joinVol) ? Math.max(0, Math.min(100, Math.round(joinVol))) : 70,
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
    if (socket.data.role === 'receiver') {
      emitToRole(socket.data.code, 'controller', 'signal', payload);
    } else if (socket.data.role === 'controller') {
      emitToRole(socket.data.code, 'receiver', 'signal', payload);
    }
  });

  // Relais caméra JPEG : un seul envoi aux contrôleurs (évite le double flux qui tuait les FPS)
  socket.on('satellite-hello', ({ k, name } = {}) => {
    const roomCode = readActiveCode();
    if (!roomCode) {
      socket.emit('satellite-wait', { error: 'Tablette principale pas prête' });
      return;
    }
    const wanted = cleanCamName(name);
    if (wanted) socket.data.camName = wanted;
    const key = String(k || '').trim();
    if (key && key === linkState.code) {
      acceptSatellite(socket, roomCode);
      return;
    }
    const guest = String(Math.floor(100000 + Math.random() * 900000));
    pendingSatellites.set(guest, socket.id);
    socket.data.pendingGuest = guest;
    socket.emit('satellite-wait', { guest });
    emitDevices(roomCode);
  });

  socket.on('nearby-report', (rows) => {
    if (socket.data.role !== 'receiver' || !socket.data.code || !isLocalRequest(socket.request)) return;
    const room = getRoom(socket.data.code);
    room.nearby = cleanNearby(rows);
    emitToRole(socket.data.code, 'controller', 'nearby', room.nearby);
  });

  socket.on('link-share', ({ url } = {}) => {
    if (socket.data.role !== 'receiver' || !socket.data.code || !isLocalRequest(socket.request)) return;
    const clean = String(url || '').trim();
    if (!isSatelliteJoinUrl(clean)) return;
    const room = getRoom(socket.data.code);
    room.pairUrl = clean;
    emitToRole(socket.data.code, 'controller', 'link-share', { url: clean });
  });

  socket.on('pair-nearby', ({ host, port } = {}) => {
    if (socket.data.role !== 'controller' || !socket.data.code) return;
    const cleanHost = String(host || '').trim();
    const cleanPort = Math.max(1, Math.min(65535, Number(port) || 3000));
    if (!isPrivateIp(cleanHost)) return;
    emitToRole(socket.data.code, 'receiver', 'pair-nearby', { host: cleanHost, port: cleanPort });
  });

  socket.on('accept-guest', ({ guest } = {}) => {
    const role = socket.data.role;
    if (role === 'receiver') {
      if (!isLocalRequest(socket.request)) return;
    } else if (role !== 'controller' || !socket.data.code) {
      return;
    }
    const code = String(guest || '').trim();
    const id = pendingSatellites.get(code);
    const other = id && io.sockets.sockets.get(id);
    if (!other) return;
    pendingSatellites.delete(code);
    acceptSatellite(other, socket.data.code);
  });

  socket.on('rename-device', ({ id, name } = {}) => {
    if (!socket.data.code) return;
    const role = socket.data.role;
    if (role !== 'receiver' && role !== 'controller' && role !== 'satellite') return;
    if (role === 'satellite' && id !== 'cam2') return;
    if (id !== 'main' && id !== 'cam2') return;
    const clean = String(name || '').trim().slice(0, 24);
    if (!clean) return;
    const room = getRoom(socket.data.code);
    if (!room.names) room.names = { main: 'Tablette', cam2: 'Caméra 2' };
    room.names[id] = clean;
    emitDevices(socket.data.code);
  });

  socket.on('drop-satellite', () => {
    if (socket.data.role !== 'receiver' || !socket.data.code) return;
    const room = getRoom(socket.data.code);
    const other = room.satelliteId && io.sockets.sockets.get(room.satelliteId);
    if (other) {
      try { other.disconnect(true); } catch (e) {}
    }
    room.satelliteId = null;
    emitDevices(socket.data.code);
  });

  socket.on('live-frame', (data) => {
    if (!socket.data.code || (socket.data.role !== 'receiver' && socket.data.role !== 'satellite')) return;
    if (socket.data.role === 'satellite') {
      let jpeg = null;
      if (typeof data === 'string') jpeg = data;
      else if (data && typeof data.jpeg === 'string') jpeg = data.jpeg;
      else if (Buffer.isBuffer(data)) jpeg = data.toString('base64');
      if (!jpeg) return;
      const packet = { deviceId: 'cam2', jpeg };
      emitToRole(socket.data.code, 'controller', 'live-frame', packet);
      const room = rooms[socket.data.code];
      const main = room && room.receiverId && io.sockets.sockets.get(room.receiverId);
      if (main) main.emit('live-frame', packet);
      return;
    }
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
      const target = (payload && payload.target) || 'main';
      if (target === 'all' || target === 'main') {
        emitToRole(socket.data.code, 'receiver', 'talk-audio', payload);
      }
      if (target === 'all' || target === 'cam2') {
        const room = rooms[socket.data.code];
        const sat = room && room.satelliteId && io.sockets.sockets.get(room.satelliteId);
        if (sat) sat.emit('talk-audio', payload);
      }
    } else if (socket.data.role === 'receiver' || socket.data.role === 'satellite') {
      emitToRole(socket.data.code, 'controller', 'talk-audio', payload);
      if (socket.data.role === 'receiver') {
        const target = payload && payload.target;
        if (target === 'all' || target === 'cam2') {
          const room = rooms[socket.data.code];
          const sat = room && room.satelliteId && io.sockets.sockets.get(room.satelliteId);
          if (sat) sat.emit('talk-audio', payload);
        }
      }
    }
  });

  // ACK lecture voix côté récepteur → indicateur Micro vert/rouge sur le contrôleur
  socket.on('talk-audio-ack', (payload) => {
    if (!socket.data.code || socket.data.role !== 'receiver') return;
    emitToRole(socket.data.code, 'controller', 'talk-audio-ack', payload || { ok: false });
  });

  // Volume sortie récepteur (0–100), sync ctrl ↔ recv + persist
  socket.on('set-receiver-volume', (payload) => {
    if (!socket.data.code) return;
    const room = getRoom(socket.data.code);
    const raw = payload && payload.volume != null ? payload.volume : payload;
    const vol = Math.max(0, Math.min(100, Math.round(Number(raw))));
    if (!Number.isFinite(vol)) return;
    room.outputVolume = vol;
    try { persist(); } catch (e) {}
    io.to(socket.data.code).emit('receiver-volume', { volume: vol });
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
    if (!socket.data.code) return;
    const room = getRoom(socket.data.code);
    room.schedules = (schedules || []).map(normalizeSchedule);
    persist();
    broadcastRoomState(socket.data.code, room);
  });

  socket.on('update-manual-alarm', ({ messageId, duration, sound1, sound2, title }) => {
    if (!socket.data.code) return;
    const room = getRoom(socket.data.code);
    if (!room.manualAlarm) room.manualAlarm = { messageId: '', sound1: 'beep', sound2: '', duration: 30 };
    if (messageId !== undefined) room.manualAlarm.messageId = messageId || '';
    if (sound1 !== undefined) room.manualAlarm.sound1 = sound1 || '';
    if (sound2 !== undefined) room.manualAlarm.sound2 = sound2 || '';
    if (sound2 !== undefined && messageId === undefined) room.manualAlarm.messageId = sound2 || '';
    if (duration !== undefined) room.manualAlarm.duration = Math.min(120, Math.max(5, Number(duration) || 30));
    if (title !== undefined) {
      const text = String(title || '').trim().slice(0, 40);
      room.manualAlarm.title = text || "C'est l'heure !";
    }
    persist();
    broadcastRoomState(socket.data.code, room);
  });

  // --- Bibliothèque de messages personnalisés : indépendante des horaires, réutilisable ---
  socket.on('save-message', ({ id, name, text }) => {
    if (!socket.data.code) return;
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
    if (!socket.data.code) return;
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
      if (!socket.data.code) return;
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
    if (!socket.data.code) return;
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
  socket.on('switch-camera', (payload) => {
    if (!socket.data.code) return;
    emitToTargets(socket.data.code, payload && payload.target, 'switch-camera', payload);
  });
  socket.on('torch', (payload) => {
    if (!socket.data.code) return;
    emitToTargets(socket.data.code, payload && payload.target, 'torch', payload);
  });
  socket.on('torch-status', (payload) => emitToRole(socket.data.code, 'controller', 'torch-status', payload));

  socket.on('set-media-sync', (payload) => {
    if (!socket.data.code) return;
    if (socket.data.role !== 'receiver' && socket.data.role !== 'controller') return;
    const room = getRoom(socket.data.code);
    room.mediaSync = !!(payload && payload.on);
    const msg = { on: room.mediaSync };
    emitToRole(socket.data.code, 'receiver', 'media-sync', msg);
    emitToRole(socket.data.code, 'controller', 'media-sync', msg);
  });

  socket.on('take-photo', (payload) => {
    if (!socket.data.code) return;
    const target = (payload && payload.target) || 'main';
    emitToTargets(socket.data.code, target, 'take-photo', payload || {});
  });
  socket.on('screen-on', (payload) => {
    if (!socket.data.code) return;
    const target = (payload && payload.target) || 'main';
    const room = getRoom(socket.data.code);
    if (target === 'all' || target === 'main') {
      room.screenOn = true;
      if (room._restoreScreenOff !== undefined) room._restoreScreenOff = false;
      notifyFlutter('screen', 'on');
    }
    emitToTargets(socket.data.code, target, 'screen-on', payload || {});
    emitToRole(socket.data.code, 'controller', 'screen-on');
  });
  socket.on('screen-off', (payload) => {
    if (!socket.data.code) return;
    const target = (payload && payload.target) || 'main';
    const room = getRoom(socket.data.code);
    if (target === 'all' || target === 'main') {
      room.screenOn = false;
      if (room._restoreScreenOff !== undefined) room._restoreScreenOff = false;
      notifyFlutter('screen', 'off');
    }
    emitToTargets(socket.data.code, target, 'screen-off', payload || {});
    emitToRole(socket.data.code, 'controller', 'screen-off');
  });
  socket.on('start-video', (payload) => {
    if (!socket.data.code) return;
    const target = (payload && payload.target) || 'main';
    emitToTargets(socket.data.code, target, 'start-video', payload || {});
  });
  socket.on('stop-video', (payload) => {
    if (!socket.data.code) return;
    const target = (payload && payload.target) || 'main';
    emitToTargets(socket.data.code, target, 'stop-video', payload || {});
  });

  // --- Réception du média capturé par le récepteur : permanent + copie purgeable ---
  socket.on('media-captured', ({ type, data, ext }) => {
    if (!socket.data.code) return;
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

  // --- Suppression manuelle ---
  // Contrôleur : copie contrôleur seulement. Récepteur : archive tablette + copie.
  socket.on('delete-media', (payload) => {
    if (!socket.data.code) return;
    const raw = typeof payload === 'string'
      ? payload
      : String((payload && payload.name) || '');
    const safe = path.basename(raw.replace(/\\/g, '/'));
    if (!safe || safe !== raw.replace(/^.*[/\\]/, '') || safe.includes('..')) return;
    const permanent = socket.data.role === 'receiver'
      || !!(payload && typeof payload === 'object' && payload.permanent);
    try {
      const ctrl = path.join(CONTROLLER_DIR, safe);
      if (fs.existsSync(ctrl)) fs.unlinkSync(ctrl);
      if (permanent) {
        const recv = path.join(RECEIVER_DIR, safe);
        if (fs.existsSync(recv)) fs.unlinkSync(recv);
      }
    } catch (e) {
      console.error('delete-media:', e.message);
    }
    broadcastRoomState(socket.data.code, getRoom(socket.data.code));
  });

  socket.on('disconnect', () => {
    if (socket.data.pendingGuest) pendingSatellites.delete(socket.data.pendingGuest);
    const code = socket.data.code;
    if (!code) return;
    const room = getRoom(code);
    room.controllerIds.delete(socket.id);
    if (room.satelliteId === socket.id) {
      room.satelliteId = null;
      emitDevices(code);
    }
    if (room.receiverId === socket.id) {
      room.receiverId = null;
      room.camOn = false;
      room.cameras = [];
      room.battery = null;
      delete liveJpegs[code];
      emitToRole(code, 'controller', 'cam-status', { on: false });
      emitToRole(code, 'controller', 'battery-status', { level: null, offline: true });
    }
    if (!socket.data.replaced) emitPeers(code, room);
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
    title: (room.manualAlarm && room.manualAlarm.title) || "C'est l'heure !",
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

function stopAllRoomAlarms() {
  const codes = new Set(Object.keys(rooms));
  const active = readActiveCode();
  if (active) codes.add(active);
  codes.forEach((code) => {
    try { stopRoomAlarm(code); } catch (e) {}
  });
}

// --- Vérifie toutes les 5s : horaires du code ACTIF (+ rattrapage si minute sautée) ---
const SCHEDULE_GRACE_MINUTES = 15;

function checkScheduledAlarms() {
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const active = readActiveCode();
  if (!active) return;
  let room;
  try {
    room = getRoom(active);
  } catch (e) {
    return;
  }
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
  if (!due.length) return;
  const duration = Math.max.apply(null, due.map((s) => s.duration || 30));
  const sequence = [];
  due.forEach((s) => {
    soundsForSchedule(room, s).forEach((part) => sequence.push(part));
  });
  startRoomAlarm(active, { duration, sequence });
  try { persist(); } catch (e) {}
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
  console.error('Serveur HTTP:', err && err.message ? err.message : err);
});
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIp();
  console.log('\n=== Gamelle Chat ===');
  console.log(`Sur la tablette (récepteur) : http://127.0.0.1:${PORT}`);
  console.log(`Même WiFi                   : http://${ip}:${PORT}`);
  console.log('Domaine : le tunnel nommé parle en HTTP à ce serveur (ingress Cloudflare inchangé).');
  // Sur la tablette, Android ouvre le seul cloudflared. Node n'en lance pas un second.
  if (process.env.TUNNEL === '0' || isMobileBundle()) {
    console.log(isMobileBundle()
      ? 'Tunnel : un seul connecteur, ouvert par l’application.'
      : 'Tunnel distant désactivé (TUNNEL=0). Hors WiFi, ça ne marchera pas.');
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

let activeTunnelStop = null;
let domainWatchTimer = null;
let domainRetryTimer = null;
let tunnelStartLock = false;
let lastDomainBlockLog = '';

function logDomainBlock(message) {
  if (!message || message === lastDomainBlockLog) return;
  lastDomainBlockLog = message;
  console.warn(message);
  console.warn('Le domaine reste fermé tant que cette installation n’est pas la version publiée.');
}

function clearDomainWatch() {
  if (domainWatchTimer) {
    clearInterval(domainWatchTimer);
    domainWatchTimer = null;
  }
}

function stopActiveTunnel() {
  const stop = activeTunnelStop;
  activeTunnelStop = null;
  publicUrl = null;
  if (typeof stop === 'function') {
    try { stop(); } catch (e) {}
  }
}

function armDomainWatch() {
  clearDomainWatch();
  // Déjà ouvert : un trou de GitHub ne coupe pas. Une release plus récente, si.
  domainWatchTimer = setInterval(() => {
    domainGate().then((gate) => {
      if (gate.gate !== 'behind') return;
      logDomainBlock(gate.message);
      console.warn('Tunnel coupé : une version plus récente est publiée.');
      clearDomainWatch();
      stopActiveTunnel();
    }).catch(() => {});
  }, 2 * 60 * 1000);
  if (domainWatchTimer.unref) domainWatchTimer.unref();
}

function scheduleDomainOpen(origin) {
  if (domainRetryTimer) return;
  domainRetryTimer = setTimeout(() => {
    domainRetryTimer = null;
    startPublicTunnel(origin).catch(() => {});
  }, 45 * 1000);
  if (domainRetryTimer.unref) domainRetryTimer.unref();
}

function httpsGet(url, follow, left) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: { 'User-Agent': 'GamelleChat', Accept: '*/*' },
      timeout: 20000,
    }, (res) => {
      const loc = String(res.headers.location || '');
      if (follow && res.statusCode >= 300 && res.statusCode < 400 && loc && left > 0) {
        res.resume();
        httpsGet(new URL(loc, url).toString(), true, left - 1).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, location: loc, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function fetchLatestReleaseTag() {
  const latest = await httpsGet('https://github.com/ShivaneUN/gamelle-chat/releases/latest', false, 0);
  const fromLoc = decodeURIComponent((latest.location.split('/releases/tag/')[1] || '').split('/')[0].split('?')[0]).trim();
  if (fromLoc) return fromLoc;
  const atom = await httpsGet('https://github.com/ShivaneUN/gamelle-chat/releases.atom', true, 4);
  if (atom.status < 200 || atom.status >= 300) throw new Error('releases.atom HTTP ' + atom.status);
  const match = atom.body.match(/\/releases\/tag\/([^<"\s]+)/);
  if (match && match[1]) return decodeURIComponent(match[1]).trim();
  throw new Error('Aucune release GitHub trouvée.');
}

async function domainGate() {
  const local = updater.pkgVersion();
  const forced = process.env.GAMELLE_LATEST_TAG;
  if (forced === 'unknown') return updater.domainGateFrom('fail', '', local);
  if (forced) return updater.domainGateFrom('ok', forced, local);
  try {
    return updater.domainGateFrom('ok', await fetchLatestReleaseTag(), local);
  } catch (e) {
    return updater.domainGateFrom('fail', '', local);
  }
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
  activeTunnelStop = stop;
  armDomainWatch();
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
  activeTunnelStop = stop;
  armDomainWatch();
}

async function startPublicTunnel(origin) {
  if (isMobileBundle() || process.env.TUNNEL === '0') {
    console.log('Tunnel Node ignoré : un seul connecteur, celui de l’application.');
    return;
  }
  if (tunnelStartLock) return;
  tunnelStartLock = true;
  try {
    const gate = await domainGate();
    if (gate.gate !== 'allowed') {
      logDomainBlock(gate.message);
      scheduleDomainOpen(origin);
      return;
    }
    lastDomainBlockLog = '';
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
  } finally {
    tunnelStartLock = false;
  }
}
