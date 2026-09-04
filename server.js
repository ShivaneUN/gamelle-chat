const express = require('express');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const selfsigned = require('selfsigned');
const updater = require('./update-service');

const app = express();

// --- Certificat HTTPS auto-signé, généré une seule fois et réutilisé ensuite ---
// Nécessaire pour que le navigateur autorise la caméra et le micro sur une IP locale
// (Chrome/Android bloque ces accès en http:// sauf sur localhost).
const CERT_DIR = path.join(__dirname, 'certs');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');
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
const io = new Server(server, { maxHttpBufferSize: 5e7, pingTimeout: 30000, pingInterval: 25000 });

let publicUrl = null;
const PORT = Number(process.env.PORT) || 3000;
const liveJpegs = {};

// --- Dossiers de stockage ---
const RECEIVER_DIR = path.join(__dirname, 'uploads', 'receiver');   // photos/vidéos : permanent
const CONTROLLER_DIR = path.join(__dirname, 'uploads', 'controller'); // photos/vidéos : purgé 24h
const AUDIO_DIR = path.join(__dirname, 'uploads', 'audio');          // messages vocaux enregistrés : permanent
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'schedules.json');
[RECEIVER_DIR, CONTROLLER_DIR, AUDIO_DIR, DATA_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

app.use((req, res, next) => {
  // Ne pas toucher à autoplay : un header trop strict coupe bip / TTS / audio en HTTPS local
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media/receiver', express.static(RECEIVER_DIR));
app.use('/media/controller', express.static(CONTROLLER_DIR));
app.use('/media/audio', express.static(AUDIO_DIR));
app.use(express.json({ limit: '50mb' }));

app.get('/api/info', (_req, res) => {
  res.json({
    publicUrl,
    localUrl: `https://${getLocalIp()}:${PORT}`,
    version: updater.pkgVersion(),
  });
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
  const dump = {};
  for (const code in rooms) dump[code] = {
    schedules: rooms[code].schedules,
    messages: rooms[code].messages,
    manualAlarm: rooms[code].manualAlarm || { messageId: '', duration: 30 },
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(dump, null, 2));
}

function assignMessageToAlarms(room, messageId) {
  if (!room.manualAlarm) room.manualAlarm = { messageId: '', duration: 30 };
  room.manualAlarm.messageId = messageId;
  if (!room.schedules.length) {
    room.schedules.push({ id: 's' + Date.now(), time: '08:00', messageId, duration: 30 });
  } else {
    room.schedules.forEach((s) => { s.messageId = messageId; });
  }
}

const persisted = loadPersisted();

// rooms[code] = { controllerIds: Set, receiverId, schedules, messages, _lastFired, camOn, cameras }
const rooms = {};
function getRoom(code) {
  if (!rooms[code]) {
    const saved = persisted[code] || {};
    rooms[code] = {
      schedules: saved.schedules || [],
      messages: saved.messages || [],
      manualAlarm: saved.manualAlarm || { messageId: '', duration: 30 },
      _lastFired: {},
      controllerIds: new Set(),
      receiverId: null,
      camOn: false,
      cameras: [],
    };
  }
  if (!rooms[code].controllerIds) rooms[code].controllerIds = new Set();
  return rooms[code];
}

function emitToRole(code, role, event, payload) {
  const socketIds = io.sockets.adapter.rooms.get(code);
  if (!socketIds) return;
  socketIds.forEach((id) => {
    const s = io.sockets.sockets.get(id);
    if (s && s.data.role === role) s.emit(event, payload);
  });
}

function emitPeers(code, room) {
  for (const id of [...room.controllerIds]) {
    if (!io.sockets.sockets.get(id)) room.controllerIds.delete(id);
  }
  if (room.receiverId && !io.sockets.sockets.get(room.receiverId)) room.receiverId = null;
  io.to(code).emit('peers', {
    controllers: room.controllerIds.size,
    receiver: !!room.receiverId,
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
    const room = getRoom(code);
    socket.join(code);
    socket.data.code = code;
    socket.data.role = role;

    if (role === 'controller') room.controllerIds.add(socket.id);
    if (role === 'receiver') room.receiverId = socket.id;

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

  // Relais caméra JPEG : tous les contrôleurs reçoivent le même flux
  socket.on('live-frame', (data) => {
    if (!socket.data.code || socket.data.role !== 'receiver') return;
    const b64 = typeof data === 'string' ? data : (data && data.jpeg);
    if (!b64) return;
    try { liveJpegs[socket.data.code] = Buffer.from(b64, 'base64'); } catch (e) {}
    emitToRole(socket.data.code, 'controller', 'live-frame', b64);
    socket.to(socket.data.code).emit('live-frame', b64);
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
    room.schedules = schedules;
    persist();
    broadcastRoomState(socket.data.code, room);
  });

  socket.on('update-manual-alarm', ({ messageId, duration }) => {
    if (!socket.data.code) return;
    const room = getRoom(socket.data.code);
    if (!room.manualAlarm) room.manualAlarm = { messageId: '', duration: 30 };
    if (messageId !== undefined) room.manualAlarm.messageId = messageId || '';
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
    room.schedules.forEach((s) => { if (s.messageId === id) s.messageId = null; });
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

  socket.on('take-photo', () => emitToRole(socket.data.code, 'receiver', 'take-photo'));
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

function startRoomAlarm(code, { messageId, duration, text, audioUrl, name } = {}) {
  const room = getRoom(code);
  const dur = Math.min(120, Math.max(5, Number(duration) || 30));
  const msg = messageId ? (room.messages || []).find((m) => m.id === messageId) : null;
  if (room._alarmTimer) clearTimeout(room._alarmTimer);
  const spoken = ((msg && msg.text) || text || (msg && msg.name) || name || '').trim();
  room._alarmPayload = {
    message: spoken,
    audioUrl: (msg && msg.audioUrl) || audioUrl || null,
    duration: dur,
  };
  room._alarmUntil = Date.now() + dur * 1000;
  io.to(code).emit('alarm', room._alarmPayload);
  room._alarmTimer = setTimeout(() => stopRoomAlarm(code), dur * 1000);
}

function stopRoomAlarm(code) {
  const room = rooms[code];
  if (!room) return;
  if (room._alarmTimer) clearTimeout(room._alarmTimer);
  room._alarmTimer = null;
  room._alarmPayload = null;
  room._alarmUntil = 0;
  io.to(code).emit('alarm-stop');
}

// --- Vérifie toutes les 15s si une sonnerie doit se déclencher ---
setInterval(() => {
  const now = new Date();
  const current = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  for (const code in rooms) {
    const room = rooms[code];
    (room.schedules || []).forEach((s) => {
      const key = s.id + current;
      if (s.time === current && room._lastFired[s.id] !== key) {
        room._lastFired[s.id] = key;
        startRoomAlarm(code, { messageId: s.messageId, duration: s.duration });
      }
    });
  }
}, 15000);

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
    startPublicTunnel(`https://127.0.0.1:${PORT}`);
  }
});

async function startPublicTunnel(origin) {
  try {
    const cf = await import('cloudflared');
    const Tunnel = cf.Tunnel || (cf.default && cf.default.Tunnel);
    const bin = cf.bin || (cf.default && cf.default.bin);
    const install = cf.install || (cf.default && cf.default.install);
    if (!fs.existsSync(bin)) {
      console.log('Téléchargement de cloudflared (une seule fois)...');
      await install(bin);
    }
    const tunnel = Tunnel.quick(origin, { '--no-tls-verify': true });
    tunnel.once('url', (url) => {
      publicUrl = url.replace(/\/$/, '');
      console.log(`Depuis n'importe où (4G / autre WiFi) : ${publicUrl}`);
      console.log('Ouvre cette URL sur le Contrôleur, même code de jumelage.');
      console.log('================================================\n');
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
  } catch (e) {
    console.warn('Accès distant indisponible:', e.message);
    console.warn('Les 2 appareils devront être sur le même WiFi (ou relance après npm install).');
    console.log('================================================\n');
  }
}
