function setBtnLabel(btn, label, className) {
  if (!btn) return;
  if (className) btn.className = className;
  const lbl = btn.querySelector('.lbl');
  if (lbl) lbl.textContent = label;
  else btn.textContent = label;
}

function saveSessionToken(token) {
  if (!token) return;
  try { sessionStorage.setItem('gamelleSession', String(token)); } catch (e) {}
  try { localStorage.removeItem('gamelleSession'); } catch (e) {}
}
function readSessionToken() {
  try {
    const q = new URLSearchParams(location.search).get('access');
    if (q && String(q).trim()) return String(q).trim();
  } catch (e) {}
  try { return sessionStorage.getItem('gamelleSession') || ''; } catch (e) {}
  return '';
}
function clearSessionToken() {
  try { sessionStorage.removeItem('gamelleSession'); } catch (e) {}
  try { localStorage.removeItem('gamelleSession'); } catch (e) {}
}
(function dropAccessFromUrl() {
  try {
    const params = new URLSearchParams(location.search);
    const access = (params.get('access') || '').trim();
    if (!access) return;
    saveSessionToken(access);
    params.delete('access');
    const q = params.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + (location.hash || ''));
  } catch (e) {}
})();
function authHeaders(extra) {
  const h = Object.assign({}, extra || {});
  const t = readSessionToken();
  if (t) h.Authorization = 'Bearer ' + t;
  return h;
}
function authFetch(url, opts) {
  const o = Object.assign({ credentials: 'same-origin' }, opts || {});
  o.headers = authHeaders(o.headers || {});
  return fetch(url, o);
}
// <img>/<video> ne peuvent pas envoyer Bearer → access= en query si token local.
function withAccess(url) {
  const t = readSessionToken();
  if (!t || !url) return url;
  const s = String(url);
  if (!s.startsWith('/media/')) return s;
  if (/[?&]access=/.test(s)) return s;
  return s + (s.includes('?') ? '&' : '?') + 'access=' + encodeURIComponent(t);
}

const refreshBtn = document.getElementById('refreshBtn');
function reloadControllerPage() {
  try { location.reload(); } catch (e) { location.href = location.href; }
}
if (refreshBtn) refreshBtn.onclick = reloadControllerPage;

// Wi-Fi → 5G : la page figée se recharge toute seule, une seule fois.
(function refreshWhenCellular() {
  let sawOffline = false;
  let lastType = '';
  try { lastType = (navigator.connection && navigator.connection.type) || ''; } catch (e) {}
  function reloadOnce() {
    const now = Date.now();
    let prev = 0;
    try { prev = Number(sessionStorage.getItem('gamelle-net-reload') || 0); } catch (e) {}
    if (prev && now - prev < 10000) return;
    try { sessionStorage.setItem('gamelle-net-reload', String(now)); } catch (e) {}
    reloadControllerPage();
  }
  window.addEventListener('offline', () => { sawOffline = true; });
  window.addEventListener('online', () => {
    if (!sawOffline) return;
    sawOffline = false;
    reloadOnce();
  });
  try {
    const conn = navigator.connection;
    if (conn && conn.addEventListener) {
      conn.addEventListener('change', () => {
        const next = String(conn.type || '');
        if (next === 'cellular' && lastType && lastType !== 'cellular') reloadOnce();
        if (next) lastType = next;
      });
    }
  } catch (e) {}
})();

function readControllerCode() {
  const params = new URLSearchParams(location.search);
  let next = (params.get('code') || '').trim();
  if (next.length >= 4) {
    try { sessionStorage.setItem('gamellePairCode', next); } catch (e) {}
    try { localStorage.setItem('gamellePairCode', next); } catch (e) {}
    try {
      const url = new URL(location.href);
      url.searchParams.delete('code');
      history.replaceState(null, '', '/controller.html');
    } catch (e) {}
    return next;
  }
  const m = String(location.pathname || '').match(/\/c\/([^/]+)\/?$/);
  if (m && m[1]) {
    next = decodeURIComponent(m[1]).trim();
    if (next.length >= 4) {
      try { sessionStorage.setItem('gamellePairCode', next); } catch (e) {}
      try { localStorage.setItem('gamellePairCode', next); } catch (e) {}
      location.replace('/controller.html' + (readSessionToken() ? ('?access=' + encodeURIComponent(readSessionToken())) : ''));
      throw new Error('code-redirect');
    }
  }
  try {
    const saved = sessionStorage.getItem('gamellePairCode') || localStorage.getItem('gamellePairCode');
    if (saved && String(saved).trim().length >= 4) return String(saved).trim();
  } catch (e) {}
  return '';
}
let code = readControllerCode();
const statusEl = document.getElementById('status');
const remoteVideo = document.getElementById('remoteVideo');
const remoteRelay = document.getElementById('remoteRelay');
const liveHint = document.getElementById('liveHint');
const gallery = document.getElementById('gallery');
const cameraSelect = document.getElementById('cameraSelect');

if (!code) {
  const waitHint = document.getElementById('liveHint');
  if (statusEl) {
    statusEl.textContent = 'Hors ligne';
    statusEl.className = 'status off';
  }
  if (waitHint) waitHint.textContent = 'En attente du serveur…';
  const waitForCode = () => {
    authFetch('/api/active-code').then(async (r) => {
      if (r.status === 401) {
        clearSessionToken();
        location.replace('/?next=controller');
        return;
      }
      const j = await r.json().catch(() => ({}));
      const c = String((j && j.code) || '').trim();
      if (c.length >= 4) {
        try { sessionStorage.setItem('gamellePairCode', c); } catch (e) {}
        try { localStorage.setItem('gamellePairCode', c); } catch (e) {}
        location.replace('/controller.html' + (readSessionToken() ? ('?access=' + encodeURIComponent(readSessionToken())) : ''));
        return;
      }
      setTimeout(waitForCode, 2500);
    }).catch(() => {
      setTimeout(waitForCode, 2500);
    });
  };
  waitForCode();
  throw new Error('code-redirect');
}

const sessionToken = readSessionToken();
const socket = io({
  withCredentials: true,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 800,
  reconnectionDelayMax: 5000,
  transports: ['polling', 'websocket'],
  auth: sessionToken ? { token: sessionToken } : undefined,
  query: sessionToken ? { access: sessionToken } : undefined,
});
window.__gamelleTarget = 'main';
window.__gamelleSync = false;
function controlTarget() {
  if (window.__gamelleSync) return 'all';
  return window.__gamelleTarget || 'main';
}
function mediaTarget() {
  return window.__gamelleMediaSync ? 'all' : 'main';
}
let pcCam = null;   // reçoit la caméra du récepteur (WebRTC si 1 seul ctrl)
let talkStream = null;
let peerControllerCount = 0;
let webrtcLive = false;
let camWanted = false;
let authKicked = false;
let authRetrying = false;
const MIC_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

socket.on('connect', () => {
  authKicked = false;
  socket.emit('join', { code, role: 'controller' });
});
socket.on('active-code', ({ code: next } = {}) => {
  const c = String(next || '').trim();
  if (c.length < 4) return;
  code = c;
  try { sessionStorage.setItem('gamellePairCode', c); } catch (e) {}
  try { localStorage.setItem('gamellePairCode', c); } catch (e) {}
});
socket.on('auth-required', async () => {
  if (authRetrying || authKicked) return;
  authRetrying = true;
  try {
    const r = await authFetch('/api/auth/me');
    const j = await r.json().catch(() => ({}));
    if (j && j.authenticated) {
      setTimeout(() => {
        authRetrying = false;
        try { socket.connect(); } catch (e) { authRetrying = false; }
      }, 600);
      return;
    }
    if (!r || r.status >= 500) {
      authRetrying = false;
      setTimeout(() => { try { socket.connect(); } catch (e) {} }, 1500);
      return;
    }
  } catch (e) {
    authRetrying = false;
    setTimeout(() => { try { socket.connect(); } catch (err) {} }, 1500);
    return;
  }
  authKicked = true;
  authRetrying = false;
  clearSessionToken();
  location.replace('/?next=controller');
});
socket.on('logged-out', () => {
  authKicked = true;
  clearSessionToken();
  try { socket.disconnect(); } catch (e) {}
  location.replace('/');
});
socket.on('session-replaced', () => {
  authKicked = true;
  clearSessionToken();
  location.replace('/?reason=session');
});
socket.on('connect_error', () => {
  if (authKicked) return;
  setStatus(false, 'Hors ligne');
  if (liveHint) liveHint.textContent = 'En attente du serveur…';
});
socket.on('disconnect', (reason) => {
  if (!authKicked) {
    setStatus(false, 'Hors ligne');
    if (liveHint) liveHint.textContent = 'En attente du serveur…';
  }
  if (reason === 'io server disconnect' && !authKicked) {
    setTimeout(() => {
      try { socket.connect(); } catch (e) {}
    }, 1000);
  }
});

const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
  logoutBtn.onclick = async () => {
    authKicked = true;
    try {
      await authFetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {}
    try { socket.disconnect(); } catch (e) {}
    clearSessionToken();
    location.replace('/');
  };
}
socket.on('peers', ({ receiver, controllers, names }) => {
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  window.__GAMELLE_PEER_NAMES__ = list;
  peerControllerCount = Number(controllers) || 0;
  if (receiver) {
    const n = peerControllerCount;
    let extra = '';
    if (n > 1) extra = ` · ${n} contrôleurs`;
    else if (list[0]) extra = ` · ${list[0]}`;
    setStatus(true, 'En ligne' + extra);
  } else {
    setStatus(false, 'Hors ligne');
    renderReceiverBattery({ offline: true });
  }
  renderPeersPop();
  syncControllerLiveTransport();
});
let livePollTimer = null;
let lastSocketFrameAt = 0;

function noteSocketFrame() {
  lastSocketFrameAt = Date.now();
  if (livePollTimer) stopLivePoll();
}

function ensureLiveFallback() {
  if (typeof camWanted !== 'undefined' && !camWanted) return;
  if (webrtcLive) {
    if (livePollTimer) stopLivePoll();
    return;
  }
  if (Date.now() - lastSocketFrameAt < 1200) {
    if (livePollTimer) stopLivePoll();
    return;
  }
  if (!livePollTimer) startLivePoll();
}

function setLivePlaceholder(show) {
  const el = document.getElementById('livePlaceholder');
  if (!el) return;
  el.classList.toggle('on', !!show);
  el.style.display = show ? 'block' : 'none';
}

function showRelayLive() {
  if (webrtcLive) return;
  if (remoteVideo) {
    remoteVideo.classList.remove('on');
    remoteVideo.style.display = 'none';
  }
  remoteRelay.classList.add('on');
  remoteRelay.style.display = 'block';
  setLivePlaceholder(false);
  liveHint.textContent = 'Vue live';
}

function showWebrtcLive() {
  webrtcLive = true;
  if (remoteRelay) {
    remoteRelay.classList.remove('on');
    remoteRelay.style.display = 'none';
  }
  if (remoteVideo) {
    remoteVideo.classList.add('on');
    remoteVideo.style.display = 'block';
  }
  setLivePlaceholder(false);
  liveHint.textContent = 'Vue live · direct';
  stopLivePoll();
}

let lastRelayObjectUrl = null;
let relayShown = false;
let relayDecoding = false;
let pendingRelayFrame = null;

function showRelayLiveOnce() {
  if (relayShown) return;
  relayShown = true;
  showRelayLive();
}

function frameToBlob(data) {
  if (!data) return null;
  if (typeof data === 'string') {
    try {
      const bin = atob(data);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: 'image/jpeg' });
    } catch (e) {
      return null;
    }
  }
  if (data instanceof Blob) return data;
  try {
    return new Blob([data], { type: 'image/jpeg' });
  } catch (e) {
    return null;
  }
}

/** Affiche la frame via <img> + object-fit contain (fiable sur iOS ; canvas y coupe l’image). */
function flushRelayFrame() {
  if (relayDecoding || pendingRelayFrame == null) return;
  const data = pendingRelayFrame;
  pendingRelayFrame = null;
  relayDecoding = true;

  const finish = () => {
    relayDecoding = false;
    if (pendingRelayFrame != null) flushRelayFrame();
  };

  const blob = frameToBlob(data);
  if (!blob || !remoteRelay) {
    finish();
    return;
  }

  const url = URL.createObjectURL(blob);
  const prev = lastRelayObjectUrl;
  const onDone = () => {
    if (prev) {
      try { URL.revokeObjectURL(prev); } catch (e) {}
    }
    lastRelayObjectUrl = url;
    finish();
  };
  remoteRelay.onload = onDone;
  remoteRelay.onerror = onDone;
  remoteRelay.src = url;
  showRelayLiveOnce();
}

function applyFrame(data) {
  if (!data || webrtcLive) return;
  noteSocketFrame();
  // Garde uniquement la dernière frame (drop le reste = moins de freeze).
  pendingRelayFrame = data;
  flushRelayFrame();
}

socket.on('live-frame', (data) => {
  if (data && typeof data === 'object' && data.deviceId === 'cam2' && typeof data.jpeg === 'string') {
    const img = document.getElementById('cam2Relay');
    if (img) {
      img.src = 'data:image/jpeg;base64,' + data.jpeg;
      img.classList.add('on');
    }
    if (window.__gamelleTarget === 'cam2' && !window.__gamelleSimult) applyFrame(data.jpeg);
    return;
  }
  if (window.__gamelleTarget === 'cam2' && !window.__gamelleSimult) return;
  if (typeof data === 'string') {
    applyFrame(data);
    return;
  }
  if (data && typeof data === 'object' && typeof data.jpeg === 'string') {
    applyFrame(data.jpeg);
    return;
  }
  applyFrame(data);
});

function startLivePoll() {
  stopLivePoll();
  const tick = () => {
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth < 2) return;
      remoteRelay.src = img.src;
      showRelayLive();
    };
    img.src = '/api/live/' + encodeURIComponent(code) + '?t=' + Date.now();
  };
  tick();
  livePollTimer = setInterval(tick, 280);
}
function stopLivePoll() {
  if (livePollTimer) { clearInterval(livePollTimer); livePollTimer = null; }
}
setInterval(() => {
  try {
    if (remoteVideo && remoteVideo.srcObject) {
      if (webrtcHasPicture()) markWebrtcPicture();
      else if (webrtcLive && webrtcFramesAt && Date.now() - webrtcFramesAt > 2000) dropWebrtcPicture();
    }
    ensureLiveFallback();
  } catch (e) {}
}, 1000);

// --- Flash / torche du récepteur ---
let flashOn = false;
const flashBtn = document.getElementById('flashBtn');
function renderFlashBtn() {
  if (!flashBtn) return;
  flashBtn.hidden = false;
  flashBtn.textContent = 'Flash';
  flashBtn.className = 'chip-btn ' + (flashOn ? 'toggle-on' : 'toggle-off');
  flashBtn.title = flashOn ? 'Éteindre le flash' : 'Allumer le flash';
}
if (flashBtn) {
  flashBtn.onclick = () => {
    flashOn = !flashOn;
    socket.emit('torch', { on: flashOn, target: controlTarget() });
    renderFlashBtn();
  };
}
renderFlashBtn();
socket.on('torch-status', (payload) => {
  if (!payload) return;
  if (payload.unsupported) {
    flashOn = false;
    renderFlashBtn();
    if (flashBtn) flashBtn.title = 'Flash non supporté sur cette caméra';
    return;
  }
  if (typeof payload.on === 'boolean') {
    flashOn = payload.on;
    renderFlashBtn();
  }
});

socket.on('cam-status', ({ on }) => {
  setCamDot(on);
  camWanted = !!on;
  if (!on) {
    stopLivePoll();
    stopWebrtcReceiver();
    clearLiveView();
    cameraSelect.style.display = 'none';
    cameraList = [];
    flashOn = false;
    renderFacingBtn();
    renderFlashBtn();
  } else {
    liveHint.textContent = 'Caméra allumée, réception de l\'image…';
    syncControllerLiveTransport();
  }
});
socket.on('room-state', (state) => {
  msgLibrary.setMessages(state.messages);
  schedManager.setSchedules(state.schedules);
  renderGallery(state.media || []);
  if (alarmControls.applySync) alarmControls.applySync(state.manualAlarm);
  if (state && state.outputVolume != null) applyReceiverVolume(state.outputVolume, false);
});

function clearLiveView() {
  stopLivePoll();
  webrtcLive = false;
  remoteVideo.srcObject = null;
  remoteVideo.classList.remove('on');
  remoteVideo.style.display = 'none';
  if (lastRelayObjectUrl) {
    try { URL.revokeObjectURL(lastRelayObjectUrl); } catch (e) {}
    lastRelayObjectUrl = null;
  }
  remoteRelay.removeAttribute('src');
  remoteRelay.classList.remove('on');
  remoteRelay.style.display = 'none';
  relayShown = false;
  setLivePlaceholder(true);
  liveHint.textContent = 'En attente de la caméra du récepteur…';
}

function setStatus(on, text) {
  statusEl.className = 'status ' + (on ? 'on' : 'off');
  statusEl.textContent = text;
  const list = window.__GAMELLE_PEER_NAMES__ || [];
  const canOpen = on && list.length > 0;
  statusEl.style.cursor = canOpen ? 'pointer' : 'default';
  statusEl.title = canOpen ? 'Voir qui est en ligne' : '';
  if (!canOpen) {
    const pop = document.getElementById('peersPop');
    if (pop) pop.hidden = true;
  }
}
setStatus(false, 'Hors ligne');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderPeersPop() {
  const pop = document.getElementById('peersPop');
  if (!pop) return;
  const list = window.__GAMELLE_PEER_NAMES__ || [];
  if (!list.length) {
    pop.hidden = true;
    pop.innerHTML = '';
    return;
  }
  pop.innerHTML = '<div class="peers-pop-title">En ligne</div>' +
    list.map((n) => `<div class="peers-pop-item">${escapeHtml(n)}</div>`).join('');
}

function togglePeersPop(force) {
  const pop = document.getElementById('peersPop');
  if (!pop) return;
  const list = window.__GAMELLE_PEER_NAMES__ || [];
  if (!list.length) {
    pop.hidden = true;
    return;
  }
  renderPeersPop();
  if (typeof force === 'boolean') pop.hidden = !force;
  else pop.hidden = !pop.hidden;
}

if (statusEl) {
  statusEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const list = window.__GAMELLE_PEER_NAMES__ || [];
    if (!list.length) return;
    togglePeersPop();
  });
}
document.addEventListener('click', () => {
  const pop = document.getElementById('peersPop');
  if (pop) pop.hidden = true;
});

function setCamDot(on) {
  const dot = document.getElementById('camDot');
  if (!dot) return;
  dot.classList.toggle('on', !!on);
  dot.title = on ? 'Caméra allumée' : 'Caméra éteinte';
}

function renderReceiverBattery(payload) {
  const el = document.getElementById('recvBattery');
  if (!el) return;
  if (!payload || payload.offline) {
    el.hidden = false;
    el.className = 'battery-badge off';
    el.textContent = '—%';
    el.title = 'Récepteur hors ligne';
    return;
  }
  if (payload.unsupported || payload.level == null) {
    el.hidden = false;
    el.className = 'battery-badge off';
    el.textContent = '—%';
    el.title = 'Batterie du Récepteur indisponible';
    return;
  }
  const pct = payload.level;
  el.hidden = false;
  el.className = 'battery-badge' + (pct <= 20 ? ' low' : pct <= 50 ? ' mid' : '');
  el.textContent = pct + '%' + (payload.charging ? ' ⚡' : '');
  el.title = payload.charging ? 'Récepteur en charge' : 'Batterie du Récepteur';
}

socket.on('battery-status', (payload) => renderReceiverBattery(payload));

const unlockMicBtn = document.getElementById('unlockMicBtn');
let talking = false;
let talkSoundOn = true;
let alarmSoundOn = false;
let micLinkOk = false;
let lastTalkAckAt = 0;
let micAckTimer = null;
let recvVolume = 70;
let volumeDragging = false;

function applyReceiverVolume(vol, emit) {
  const n = Math.max(0, Math.min(100, Math.round(Number(vol))));
  if (!Number.isFinite(n)) return;
  recvVolume = n;
  const slider = document.getElementById('recvVolume');
  const pct = document.getElementById('recvVolumePct');
  if (slider && !volumeDragging) slider.value = String(n);
  if (pct) pct.textContent = n + '%';
  if (typeof setTalkPlaybackVolume === 'function') setTalkPlaybackVolume(n / 100);
  if (typeof setAlarmPlaybackVolume === 'function') setAlarmPlaybackVolume(n / 100);
  if (emit) socket.emit('set-receiver-volume', { volume: n });
}

(function wireVolumeSlider() {
  const slider = document.getElementById('recvVolume');
  if (!slider) return;
  const paint = () => {
    const n = Math.max(0, Math.min(100, Math.round(Number(slider.value) || 0)));
    const pct = document.getElementById('recvVolumePct');
    if (pct) pct.textContent = n + '%';
  };
  slider.addEventListener('pointerdown', () => { volumeDragging = true; });
  slider.addEventListener('pointerup', () => {
    volumeDragging = false;
    applyReceiverVolume(slider.value, true);
  });
  slider.addEventListener('change', () => {
    volumeDragging = false;
    applyReceiverVolume(slider.value, true);
  });
  slider.addEventListener('input', () => {
    paint();
    applyReceiverVolume(slider.value, true);
  });
  applyReceiverVolume(slider.value, false);
})();

socket.on('receiver-volume', (payload) => {
  if (volumeDragging) return;
  const vol = payload && payload.volume != null ? payload.volume : payload;
  applyReceiverVolume(vol, false);
});

function renderMicStatus(state) {
  if (talking) {
    setBtnLabel(unlockMicBtn, 'Micro', micLinkOk ? 'tile-btn mic-ok' : 'tile-btn mic-fail');
    return;
  }
  setBtnLabel(unlockMicBtn, 'Micro', 'tile-btn toggle-off');
}

function clearMicAckWatch() {
  if (micAckTimer) { clearInterval(micAckTimer); micAckTimer = null; }
  micLinkOk = false;
  lastTalkAckAt = 0;
}

function startMicAckWatch() {
  clearMicAckWatch();
  micLinkOk = false;
  renderMicStatus();
  micAckTimer = setInterval(() => {
    if (!talking) { clearMicAckWatch(); renderMicStatus(); return; }
    const ok = lastTalkAckAt > 0 && (Date.now() - lastTalkAckAt) < 1600;
    if (ok !== micLinkOk) {
      micLinkOk = ok;
      renderMicStatus();
    }
  }, 250);
}

socket.on('talk-audio-ack', (payload) => {
  if (!talking) return;
  const ok = !!(payload && payload.ok);
  if (ok) {
    lastTalkAckAt = Date.now();
    if (!micLinkOk) {
      micLinkOk = true;
      renderMicStatus();
    }
  } else {
    lastTalkAckAt = 0;
    if (micLinkOk) {
      micLinkOk = false;
      renderMicStatus();
    }
  }
});

async function refreshMicStatus() {
  if (talking) { renderMicStatus('granted'); return; }
  if (!navigator.permissions || !navigator.permissions.query) {
    renderMicStatus();
    return;
  }
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    renderMicStatus(status.state);
    status.onchange = () => { if (!talking) renderMicStatus(status.state); };
  } catch (e) {
    renderMicStatus();
  }
}
refreshMicStatus();

function unlockSoundEngine() {
  if (typeof unlockTalkAudio === 'function') unlockTalkAudio();
  else {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        if (!window.__gamelleAudioCtx) window.__gamelleAudioCtx = new AC();
        window.__gamelleAudioCtx.resume().catch(() => {});
      }
    } catch (e) {}
  }
}

function renderTalkSoundBtn() {
  const btn = document.getElementById('talkSoundBtn');
  if (!btn) return;
  setBtnLabel(btn, 'Son', talkSoundOn ? 'tile-btn toggle-on' : 'tile-btn toggle-off');
}

function renderAlarmSoundBtn() {
  const btn = document.getElementById('alarmSoundBtn');
  if (!btn) return;
  setBtnLabel(btn, 'Alarme', alarmSoundOn ? 'tile-btn toggle-on' : 'tile-btn toggle-off');
}

document.getElementById('talkSoundBtn').onclick = () => {
  talkSoundOn = !talkSoundOn;
  if (talkSoundOn) unlockSoundEngine();
  renderTalkSoundBtn();
};

document.getElementById('alarmSoundBtn').onclick = () => {
  alarmSoundOn = !alarmSoundOn;
  if (alarmSoundOn) unlockSoundEngine();
  if (alarmControls.setSoundEnabled) alarmControls.setSoundEnabled(alarmSoundOn);
  renderAlarmSoundBtn();
};
renderTalkSoundBtn();
renderAlarmSoundBtn();
if (typeof setTalkGainBoost === 'function') setTalkGainBoost(2.2);

let recvScreenOn = true;
function renderScreenOffBtn() {
  const btn = document.getElementById('screenOffBtn');
  if (!btn) return;
  // Comme Son : label fixe, surbrillance = écran allumé (on).
  setBtnLabel(btn, 'Écran', recvScreenOn ? 'tile-btn toggle-on' : 'tile-btn toggle-off');
}
const screenOffBtn = document.getElementById('screenOffBtn');
if (screenOffBtn) {
  screenOffBtn.onclick = () => {
    recvScreenOn = !recvScreenOn;
    socket.emit(recvScreenOn ? 'screen-on' : 'screen-off', { target: controlTarget() });
    renderScreenOffBtn();
  };
}
renderScreenOffBtn();
socket.on('screen-on', () => {
  recvScreenOn = true;
  renderScreenOffBtn();
});
socket.on('screen-off', () => {
  recvScreenOn = false;
  renderScreenOffBtn();
});

document.addEventListener('pointerdown', unlockSoundEngine);
document.addEventListener('touchstart', unlockSoundEngine, { passive: true });
document.addEventListener('click', unlockSoundEngine);

unlockMicBtn.onclick = () => { talking ? stopTalk() : startTalk(); };

// --- Bibliothèque de messages personnalisés ---
const msgLibrary = createMessageLibrary({
  containerId: 'msgList',
  socket,
  onChange: () => {
    schedManager.render();
    alarmControls.fillMessages();
  },
  onUseForAlarm: (id) => {
    alarmControls.selectMessage(id);
  },
});
document.getElementById('addMsg').onclick = () => msgLibrary.addMessage();

// --- Horaires (composant partagé avec le récepteur, référence la bibliothèque de messages) ---
const schedManager = createScheduleManager({ containerId: 'schedList', socket, getMessages: msgLibrary.getMessages });
document.getElementById('addSched').onclick = () => schedManager.addSchedule();

// --- Alarme manuelle : le son joue sur le récepteur, le contrôleur voit l'état et peut arrêter ---
const alarmControls = createAlarmControls({
  socket,
  getMessages: msgLibrary.getMessages,
  playSound: true,
  isAudioUnlocked: () => alarmSoundOn,
  ensureUnlocked: () => {
    if (!alarmSoundOn) {
      alarmSoundOn = true;
      renderAlarmSoundBtn();
    }
    unlockSoundEngine();
  },
});

function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const sheet = el.querySelector('.modal-sheet');
  if (typeof setModalExpanded === 'function') setModalExpanded(sheet, false);
  el.hidden = false;
  document.body.classList.add('modal-open');
}
function closeModal(id) {
  if (typeof closeSoundSheet === 'function') closeSoundSheet();
  const el = document.getElementById(id);
  if (!el) return;
  const sheet = el.querySelector('.modal-sheet');
  if (typeof setModalExpanded === 'function') setModalExpanded(sheet, false);
  el.hidden = true;
  if (!document.querySelector('.modal:not([hidden])')) {
    document.body.classList.remove('modal-open');
  }
}
document.getElementById('openAlbumBtn').onclick = () => openModal('albumModal');
document.getElementById('openLibraryBtn').onclick = () => openModal('libraryModal');
document.getElementById('openAlarmBtn').onclick = () => {
  openModal('alarmModal');
  alarmControls.fillMessages();
};
document.getElementById('openSchedBtn').onclick = () => {
  openModal('schedModal');
  schedManager.render();
};
document.querySelectorAll('[data-close]').forEach((el) => {
  el.onclick = () => closeModal(el.getAttribute('data-close'));
});

// --- Choix de la caméra du récepteur (Avant / Arrière) ---
let cameraList = [];
let currentCamIndex = 0;
let preferredFacing = 'Arrière';
const facingBtn = document.getElementById('facingBtn');

function classifyCamLabel(label) {
  const l = String(label || '').toLowerCase();
  if (/front|user|avant|face/.test(l)) return 'Avant';
  if (/back|rear|environment|arrière|arriere|world/.test(l)) return 'Arrière';
  return null;
}

function facingModeFor(label) {
  return label === 'Avant' ? 'user' : 'environment';
}

function findCamIndexForFacing(facing) {
  return cameraList.findIndex((c) => classifyCamLabel(c.label) === facing);
}

function renderFacingBtn() {
  if (!facingBtn) return;
  facingBtn.hidden = false;
  facingBtn.textContent = preferredFacing;
  facingBtn.setAttribute('aria-label', 'Caméra ' + preferredFacing);
}

socket.on('camera-list', (cams) => {
  cameraList = Array.isArray(cams) ? cams : [];
  cameraSelect.innerHTML = cameraList
    .map((c) => `<option value="${c.deviceId}">${c.label}</option>`)
    .join('');
  if (!cameraList.length) {
    renderFacingBtn();
    return;
  }
  const matchIdx = findCamIndexForFacing(preferredFacing);
  if (matchIdx >= 0) currentCamIndex = matchIdx;
  else if (currentCamIndex >= cameraList.length) currentCamIndex = 0;
  if (cameraList[currentCamIndex]) cameraSelect.value = cameraList[currentCamIndex].deviceId;
  renderFacingBtn();
});

if (facingBtn) {
  facingBtn.onclick = () => {
    preferredFacing = preferredFacing === 'Avant' ? 'Arrière' : 'Avant';
    const facingMode = facingModeFor(preferredFacing);
    const matchIdx = findCamIndexForFacing(preferredFacing);
    if (matchIdx >= 0) {
      currentCamIndex = matchIdx;
      const cam = cameraList[currentCamIndex];
      cameraSelect.value = cam.deviceId;
      socket.emit('switch-camera', { deviceId: cam.deviceId, facingMode, target: controlTarget() });
    } else {
      socket.emit('switch-camera', { facingMode, target: controlTarget() });
    }
    renderFacingBtn();
  };
}
cameraSelect.onchange = () => {
  const id = cameraSelect.value;
  const idx = cameraList.findIndex((c) => c.deviceId === id);
  if (idx >= 0) {
    currentCamIndex = idx;
    preferredFacing = classifyCamLabel(cameraList[idx].label) || preferredFacing;
  }
  socket.emit('switch-camera', {
    deviceId: id,
    facingMode: facingModeFor(preferredFacing),
    target: controlTarget(),
  });
  renderFacingBtn();
};

// --- WebRTC : réception de la caméra du récepteur (v1 : seulement si 1 contrôleur) ---
function preferWebrtcRecv() {
  return camWanted && peerControllerCount === 1;
}

function webrtcHasPicture() {
  return !!(remoteVideo && remoteVideo.srcObject && remoteVideo.videoWidth > 0);
}

function tellReceiverSeeing(on) {
  try { socket.emit('signal', { channel: 'cam', type: 'seeing', on: !!on }); } catch (e) {}
}

let webrtcFramesAt = 0;
let webrtcRetries = 0;

function markWebrtcPicture() {
  if (!webrtcHasPicture()) return;
  webrtcFramesAt = Date.now();
  webrtcRetries = 0;
  if (webrtcLive) return;
  showWebrtcLive();
  tellReceiverSeeing(true);
}

function dropWebrtcPicture() {
  const was = webrtcLive;
  webrtcLive = false;
  webrtcFramesAt = 0;
  if (remoteVideo) {
    remoteVideo.classList.remove('on');
    remoteVideo.style.display = 'none';
  }
  if (was) tellReceiverSeeing(false);
  relayShown = false;
  if (remoteRelay && remoteRelay.getAttribute('src')) showRelayLive();
  ensureLiveFallback();
  if (liveHint && !webrtcLive) liveHint.textContent = 'Vue live';
}

function armWebrtcFrameWatch() {
  if (!remoteVideo || typeof remoteVideo.requestVideoFrameCallback !== 'function') return;
  const loop = () => {
    if (!remoteVideo || !remoteVideo.srcObject) return;
    markWebrtcPicture();
    try { remoteVideo.requestVideoFrameCallback(loop); } catch (e) {}
  };
  try { remoteVideo.requestVideoFrameCallback(loop); } catch (e) {}
}

function stopWebrtcReceiver() {
  const was = webrtcLive;
  webrtcLive = false;
  webrtcFramesAt = 0;
  if (pcCam) {
    try { pcCam.onicecandidate = null; } catch (e) {}
    try { pcCam.ontrack = null; } catch (e) {}
    try { pcCam.oniceconnectionstatechange = null; } catch (e) {}
    try { pcCam.onconnectionstatechange = null; } catch (e) {}
    try { pcCam.close(); } catch (e) {}
    pcCam = null;
  }
  if (remoteVideo) {
    remoteVideo.srcObject = null;
    remoteVideo.classList.remove('on');
    remoteVideo.style.display = 'none';
  }
  if (was) tellReceiverSeeing(false);
}

function onWebrtcRecvState() {
  if (!pcCam) return;
  const ice = pcCam.iceConnectionState || '';
  const conn = pcCam.connectionState || '';
  if (ice === 'connected' || ice === 'completed' || conn === 'connected') {
    markWebrtcPicture();
    return;
  }
  if (ice === 'failed' || ice === 'disconnected' || conn === 'failed' || conn === 'disconnected') {
    dropWebrtcPicture();
    if (ice === 'failed' || conn === 'failed') {
      stopWebrtcReceiver();
      if (webrtcRetries < 2 && preferWebrtcRecv()) {
        webrtcRetries += 1;
        setTimeout(() => {
          if (preferWebrtcRecv() && !pcCam) ensureCamPeer();
        }, 800);
      }
    }
  }
}

function ensureCamPeer() {
  if (!preferWebrtcRecv()) {
    stopWebrtcReceiver();
    return null;
  }
  if (pcCam) return pcCam;
  const iceServers = (typeof ICE_SERVERS !== 'undefined' && Array.isArray(ICE_SERVERS)) ? ICE_SERVERS : [];
  try {
    pcCam = new RTCPeerConnection({ iceServers });
  } catch (e) {
    pcCam = null;
    return null;
  }
  pcCam.onicecandidate = (e) => {
    if (e.candidate) {
      try {
        socket.emit('signal', { channel: 'cam', type: 'candidate', candidate: e.candidate });
      } catch (err) {}
    }
  };
  pcCam.ontrack = (e) => {
    const stream = (e.streams && e.streams[0]) || null;
    if (remoteVideo && stream) {
      remoteVideo.srcObject = stream;
      remoteVideo.playsInline = true;
      remoteVideo.muted = true;
      remoteVideo.onloadeddata = markWebrtcPicture;
      remoteVideo.onplaying = markWebrtcPicture;
      remoteVideo.onresize = markWebrtcPicture;
      armWebrtcFrameWatch();
      remoteVideo.play().then(markWebrtcPicture).catch(() => {});
    }
  };
  pcCam.oniceconnectionstatechange = onWebrtcRecvState;
  pcCam.onconnectionstatechange = onWebrtcRecvState;
  try {
    socket.emit('signal', { channel: 'cam', type: 'ready' });
  } catch (e) {}
  return pcCam;
}

function syncControllerLiveTransport() {
  if (!camWanted) {
    stopLivePoll();
    stopWebrtcReceiver();
    return;
  }
  if (preferWebrtcRecv()) {
    // JPEG tout de suite. Le direct ne remplace l’image que lorsqu’elle est vraiment là.
    ensureCamPeer();
  } else {
    stopWebrtcReceiver();
    if (liveHint && !webrtcLive) liveHint.textContent = 'Vue live';
  }
  ensureLiveFallback();
}

socket.on('signal', async (payload) => {
  if (!payload || payload.channel !== 'cam') return;
  if (payload.type === 'offer' && payload.sdp) {
    if (!preferWebrtcRecv()) {
      // Multi-contrôleurs / pas de cam → ignore l’offre, reste en JPEG.
      return;
    }
    const pc = ensureCamPeer();
    if (!pc) return;
    try {
      await pc.setRemoteDescription(payload.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { channel: 'cam', type: 'answer', sdp: pc.localDescription });
    } catch (e) {
      dropWebrtcPicture();
    }
    return;
  }
  if (!pcCam) return;
  try {
    if (payload.type === 'answer' && payload.sdp) {
      await pcCam.setRemoteDescription(payload.sdp);
    }
    if (payload.type === 'candidate' && payload.candidate) {
      try { await pcCam.addIceCandidate(payload.candidate); } catch (e) {}
    }
  } catch (e) {}
});

// --- Capture photo / vidéo ---
document.getElementById('photoBtn').onclick = () => socket.emit('take-photo', { target: mediaTarget() });
document.getElementById('videoBtn').onclick = () => {
  const target = mediaTarget();
  socket.emit('start-video', { target: target });
  setTimeout(() => socket.emit('stop-video', { target: target }), 5000);
};

// --- Parler à distance (clic on/off, pas besoin de maintenir) ---
let talkCapture = null;
const talkPlayState = { nextTime: 0 };

async function startTalk() {
  try {
    if (!window.isSecureContext) {
      alert('Le micro a besoin d’une page sécurisée. Ouvre le lien de ton domaine, ou http://127.0.0.1:3000 sur la tablette.');
      return;
    }
    if (typeof setMicCaptureSession === 'function') setMicCaptureSession(true);
    unlockSoundEngine();
    try {
      talkStream = await navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO, video: false });
    } catch (e) {
      talkStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    talking = true;
    startMicAckWatch();
    talkCapture = await startTalkCapture(talkStream, ({ rate, samples }) => {
      if (!talking) return;
      socket.emit('talk-audio', { rate, samples, target: controlTarget() });
    });
    renderMicStatus('granted');
  } catch (err) {
    talking = false;
    clearMicAckWatch();
    stopTalkCapture(talkCapture);
    talkCapture = null;
    if (talkStream) talkStream.getTracks().forEach((t) => t.stop());
    talkStream = null;
    if (typeof setMicCaptureSession === 'function') setMicCaptureSession(false);
    refreshMicStatus();
    alert('Micro indisponible: ' + err.message);
  }
}
function stopTalk() {
  talking = false;
  if (typeof setMicCaptureSession === 'function') setMicCaptureSession(false);
  clearMicAckWatch();
  stopTalkCapture(talkCapture);
  talkCapture = null;
  if (talkStream) talkStream.getTracks().forEach((t) => t.stop());
  talkStream = null;
  renderMicStatus('granted');
}

socket.on('talk-audio', ({ rate, samples }) => {
  if (!talkSoundOn) return;
  playTalkPcm(talkPlayState, rate, samples);
});

// --- Galerie ---
function renderGallery(media) {
  gallery.innerHTML = '';
  if (!media || !media.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Aucune photo ni vidéo pour l’instant. Utilise Photo / Vidéo sous la vue live.';
    gallery.appendChild(empty);
    return;
  }
  media.forEach((m) => {
    const div = document.createElement('div');
    div.className = 'item';
    const mediaUrl = withAccess(m.url);
    const el = m.type === 'video'
      ? `<video src="${mediaUrl}" controls></video>`
      : `<img src="${mediaUrl}" alt="">`;
    div.innerHTML = `${el}
      <div class="gallery-actions">
        <button type="button" class="save" data-url="${mediaUrl}" data-name="${m.name}" data-type="${m.type || ''}" title="Enregistrer">↓</button>
        <button type="button" class="del" data-name="${m.name}" title="Retirer de ma galerie">✕</button>
      </div>`;
    gallery.appendChild(div);
  });
  gallery.querySelectorAll('.del').forEach((btn) => {
    btn.onclick = () => socket.emit('delete-media', btn.dataset.name);
  });
  gallery.querySelectorAll('.save').forEach((btn) => {
    btn.onclick = () => saveMediaToDevice(btn.dataset.url, btn.dataset.name, btn.dataset.type);
  });
}

async function saveMediaToDevice(url, name, type) {
  if (!url) return;
  const fileName = name || ('gamelle_' + Date.now() + (type === 'video' ? '.webm' : '.jpg'));
  try {
    const res = await authFetch(withAccess(url));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1500);
  } catch (e) {
    alert('Téléchargement impossible : ' + (e && e.message ? e.message : e));
  }
}

(function setupDeviceBar() {
  const bar = document.getElementById('deviceBar');
  if (!bar) return;
  const buttons = bar.querySelectorAll('[data-target]');
  function paintBtn(el, on) {
    if (!el) return;
    const tile = el.getAttribute('data-kind') === 'tile';
    el.className = tile
      ? ('tile-btn' + (on ? ' toggle-on' : ''))
      : ('chip-btn ' + (on ? 'sync-on' : 'sync-off'));
  }
  function paint() {
    buttons.forEach((b) => {
      const on = b.getAttribute('data-target') === window.__gamelleTarget;
      paintBtn(b, on);
      const lbl = b.querySelector('.lbl');
      if (lbl && b.getAttribute('data-target') === 'main') lbl.textContent = (window.__deviceNames && window.__deviceNames.main) || 'Tablette';
      if (lbl && b.getAttribute('data-target') === 'cam2') lbl.textContent = (window.__deviceNames && window.__deviceNames.cam2) || 'Caméra 2';
    });
    document.body.classList.toggle('simult', !!window.__gamelleSimult);
    paintBtn(document.getElementById('simultCtrl'), !!window.__gamelleSimult);
    paintBtn(document.getElementById('syncCtrl'), !!window.__gamelleSync);
    const extra = document.getElementById('cam2Relay');
    if (extra) extra.classList.toggle('on', !!window.__gamelleSimult && !!extra.getAttribute('src'));
  }
  buttons.forEach((b) => {
    b.onclick = () => {
      window.__gamelleTarget = b.getAttribute('data-target') || 'main';
      paint();
    };
  });
  const sim = document.getElementById('simultCtrl');
  if (sim) {
    sim.onclick = () => {
      window.__gamelleSimult = !window.__gamelleSimult;
      paint();
    };
  }
  const sync = document.getElementById('syncCtrl');
  if (sync) {
    sync.onclick = () => {
      window.__gamelleSync = !window.__gamelleSync;
      paint();
    };
  }
  socket.on('devices', (snap) => {
    window.__deviceNames = (snap && snap.names) || window.__deviceNames;
    window.__deviceSnap = snap || window.__deviceSnap;
    const cam = bar.querySelector('[data-target="cam2"]');
    if (cam) cam.hidden = !(snap && snap.satellite);
    paint();
    if (typeof window.__paintCtrlDevices === 'function') window.__paintCtrlDevices();
  });
  paint();
})();

(function setupCtrlDevices() {
  const listEl = document.getElementById('ctrlDeviceList');
  const openBtn = document.getElementById('openDevicesBtn');
  if (openBtn) openBtn.onclick = () => openModal('devicesModal');
  const nearbyEl = document.getElementById('ctrlNearbyList');
  const qrImg = document.getElementById('ctrlLinkQrImg');
  let pairUrl = '';
  function esc(text) {
    return String(text || '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function paintNearby(list) {
    if (!nearbyEl) return;
    const rows = Array.isArray(list) ? list : [];
    nearbyEl._rows = rows;
    if (!rows.length) {
      nearbyEl.innerHTML = '<p class="hint">Aucun appareil en jumelage sur le Wi-Fi.</p>';
      return;
    }
    nearbyEl.innerHTML = rows.map((r, i) => {
      const title = r.kind === 'camera'
        ? (r.name || 'Caméra Wi-Fi')
        : ('Jumelage cam · ' + (r.name || 'Caméra'));
      const sub = r.kind === 'camera' ? 'Caméra Wi-Fi reconnue' : 'Prête à jumeler';
      const btn = r.kind === 'camera' ? '' : '<button type="button" data-near="' + i + '">Jumeler</button>';
      return '<div class="device-row"><div class="device-name"><b>' + esc(title) + '</b><span class="hint">' + esc(sub) + '</span></div>' + btn + '</div>';
    }).join('');
  }
  if (nearbyEl && !nearbyEl.dataset.bound) {
    nearbyEl.dataset.bound = '1';
    nearbyEl.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-near]');
      if (!b) return;
      const row = (nearbyEl._rows || [])[Number(b.getAttribute('data-near'))];
      if (!row || !row.host || row.kind === 'camera') return;
      socket.emit('pair-nearby', { host: row.host, port: row.port || 3000 });
      b.textContent = 'Envoyé';
    });
  }
  socket.on('nearby', paintNearby);
  socket.on('link-share', (msg) => {
    pairUrl = (msg && msg.url) || '';
    if (qrImg && !qrImg.hidden && pairUrl && typeof makeQrDataUrl === 'function') {
      try { qrImg.src = makeQrDataUrl(pairUrl, 8, 4); } catch (e) {}
    }
  });
  const showQr = document.getElementById('ctrlShowLinkQr');
  if (showQr) {
    showQr.onclick = () => {
      if (!qrImg || !pairUrl || typeof makeQrDataUrl !== 'function') return;
      try {
        qrImg.src = makeQrDataUrl(pairUrl, 8, 4);
        qrImg.hidden = false;
      } catch (e) {
        qrImg.hidden = true;
      }
    };
  }
  const guestOk = document.getElementById('ctrlGuestOk');
  if (guestOk) {
    guestOk.onclick = () => {
      const guest = (document.getElementById('ctrlGuestInput').value || '').trim();
      if (guest) socket.emit('accept-guest', { guest: guest });
    };
  }
  window.__paintCtrlDevices = function () {
    if (!listEl) return;
    const snap = window.__deviceSnap || { main: true, satellite: false, names: window.__deviceNames || {} };
    const names = snap.names || {};
    const pencil = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4 11.5-11.5z"/></svg>';
    const rows = [{ id: 'main', name: names.main || 'Tablette', on: snap.main !== false }];
    if (snap.satellite || snap.satelliteKnown) {
      rows.push({ id: 'cam2', name: names.cam2 || 'Caméra 2', on: !!snap.satellite });
    }
    listEl.innerHTML = rows.map((r) => (
      '<div class="device-row"><div class="device-name"><b>' + r.name + '</b>' +
      '<button type="button" class="rename-btn" data-act="rename" data-id="' + r.id + '" title="Renommer">' + pencil + '</button>' +
      '<span class="status-dot' + (r.on ? ' on' : '') + '" title="' + (r.on ? 'En ligne' : 'Hors ligne') + '"></span></div>' +
      '<div class="link-row">' +
      '<button type="button" class="' + (flashOn ? 'sync-on' : 'sync-off') + '" data-act="torch" data-id="' + r.id + '">Lampe</button>' +
      '<button type="button" class="' + (recvScreenOn ? 'sync-on' : 'sync-off') + '" data-act="screen" data-id="' + r.id + '">Écran</button>' +
      '<button type="button" class="' + (talking ? 'sync-on' : 'sync-off') + '" data-act="mic" data-id="' + r.id + '">Micro</button>' +
      '</div></div>'
    )).join('');
    const camBtn = document.getElementById('ctrlCamBtn');
    const syncBtn = document.getElementById('ctrlSyncBtn');
    if (camBtn) camBtn.className = 'chip-btn ' + (window.__gamelleSimult ? 'sync-on' : 'sync-off');
    if (syncBtn) syncBtn.className = 'chip-btn ' + (window.__gamelleSync ? 'sync-on' : 'sync-off');
    const mediaBtn = document.getElementById('ctrlMediaBtn');
    if (mediaBtn) mediaBtn.className = 'chip-btn ' + (window.__gamelleMediaSync ? 'sync-on' : 'sync-off');
  };
  const camBtn = document.getElementById('ctrlCamBtn');
  if (camBtn) camBtn.onclick = () => {
    const sim = document.getElementById('simultCtrl');
    if (sim) sim.click();
    else window.__gamelleSimult = !window.__gamelleSimult;
    window.__paintCtrlDevices();
  };
  const syncBtn = document.getElementById('ctrlSyncBtn');
  if (syncBtn) syncBtn.onclick = () => {
    const sync = document.getElementById('syncCtrl');
    if (sync) sync.click();
    else window.__gamelleSync = !window.__gamelleSync;
    window.__paintCtrlDevices();
  };
  const mediaBtn = document.getElementById('ctrlMediaBtn');
  if (mediaBtn) mediaBtn.onclick = () => {
    window.__gamelleMediaSync = !window.__gamelleMediaSync;
    socket.emit('set-media-sync', { on: !!window.__gamelleMediaSync });
    window.__paintCtrlDevices();
  };
  socket.on('media-sync', (msg) => {
    window.__gamelleMediaSync = !!(msg && msg.on);
    window.__paintCtrlDevices();
  });
  socket.on('devices', (snap) => {
    if (snap && typeof snap.mediaSync === 'boolean') window.__gamelleMediaSync = snap.mediaSync;
    window.__paintCtrlDevices();
  });
  if (listEl && !listEl.dataset.bound) {
    listEl.dataset.bound = '1';
    listEl.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      const act = b.getAttribute('data-act');
      const id = b.getAttribute('data-id');
      if (act === 'rename') {
        const names = (window.__deviceSnap && window.__deviceSnap.names) || {};
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'rename-input';
        input.value = names[id] || '';
        input.maxLength = 24;
        const nameEl = b.parentElement.querySelector('b');
        if (!nameEl) return;
        nameEl.replaceWith(input);
        input.focus();
        let saved = false;
        const save = () => {
          if (saved) return;
          saved = true;
          const next = input.value.trim();
          if (next) socket.emit('rename-device', { id: id, name: next });
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
        input.addEventListener('blur', save);
        return;
      }
      const target = window.__gamelleSync ? 'all' : id;
      if (act === 'torch') {
        flashOn = !flashOn;
        socket.emit('torch', { on: flashOn, target: target });
        if (typeof renderFlashBtn === 'function') renderFlashBtn();
        window.__paintCtrlDevices();
      }
      if (act === 'screen') {
        recvScreenOn = !recvScreenOn;
        socket.emit(recvScreenOn ? 'screen-on' : 'screen-off', { target: target });
        if (typeof renderScreenOffBtn === 'function') renderScreenOffBtn();
        window.__paintCtrlDevices();
      }
      if (act === 'mic') {
        window.__gamelleTarget = target;
        const mic = document.getElementById('unlockMicBtn');
        if (mic) mic.click();
        setTimeout(function () { window.__paintCtrlDevices(); }, 80);
      }
    });
  }
  window.__paintCtrlDevices();
})();
