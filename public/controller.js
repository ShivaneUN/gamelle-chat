function setBtnLabel(btn, label, className) {
  if (!btn) return;
  if (className) btn.className = className;
  const lbl = btn.querySelector('.lbl');
  if (lbl) lbl.textContent = label;
  else btn.textContent = label;
}

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
      location.replace('/controller.html');
      throw new Error('code-redirect');
    }
  }
  try {
    const saved = sessionStorage.getItem('gamellePairCode') || localStorage.getItem('gamellePairCode');
    if (saved && String(saved).trim().length >= 4) return String(saved).trim();
  } catch (e) {}
  return '';
}
const code = readControllerCode();
const statusEl = document.getElementById('status');
const remoteVideo = document.getElementById('remoteVideo');
const remoteRelay = document.getElementById('remoteRelay');
const liveHint = document.getElementById('liveHint');
const gallery = document.getElementById('gallery');
const cameraSelect = document.getElementById('cameraSelect');

if (!code) {
  fetch('/api/active-code').then((r) => r.json()).then((j) => {
    const c = String((j && j.code) || '').trim();
    if (c.length >= 4) {
      try { sessionStorage.setItem('gamellePairCode', c); } catch (e) {}
      try { localStorage.setItem('gamellePairCode', c); } catch (e) {}
      location.replace('/controller.html');
      return;
    }
    setTimeout(() => location.reload(), 800);
  }).catch(() => {
    setTimeout(() => location.reload(), 800);
  });
  throw new Error('code-redirect');
}

const socket = io({ withCredentials: true });
let pcCam = null;   // reçoit la caméra du récepteur (WebRTC si 1 seul ctrl)
let talkStream = null;
let peerControllerCount = 0;
let webrtcLive = false;
let camWanted = false;
const MIC_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

socket.on('connect', () => socket.emit('join', { code, role: 'controller' }));
socket.on('auth-required', () => {
  location.replace('/');
});
socket.on('disconnect', (reason) => {
  if (reason === 'io server disconnect') {
    // possible kick auth
  }
});

const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
  logoutBtn.onclick = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (e) {}
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
  // Garde uniquement la dernière frame (drop le reste = moins de freeze).
  pendingRelayFrame = data;
  flushRelayFrame();
}

socket.on('live-frame', (data) => {
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
    socket.emit('torch', { on: flashOn });
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

function renderMicStatus(state) {
  if (talking) {
    setBtnLabel(unlockMicBtn, 'Micro', 'tile-btn toggle-on');
    return;
  }
  setBtnLabel(unlockMicBtn, 'Micro', 'tile-btn toggle-off');
}

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
unlockSoundEngine();
renderTalkSoundBtn();
renderAlarmSoundBtn();

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
    socket.emit(recvScreenOn ? 'screen-on' : 'screen-off');
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
      socket.emit('switch-camera', { deviceId: cam.deviceId, facingMode });
    } else {
      socket.emit('switch-camera', { facingMode });
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
    facingMode: facingModeFor(preferredFacing)
  });
  renderFacingBtn();
};

// --- WebRTC : réception de la caméra du récepteur (v1 : seulement si 1 contrôleur) ---
function preferWebrtcRecv() {
  return camWanted && peerControllerCount === 1;
}

function stopWebrtcReceiver() {
  webrtcLive = false;
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
}

function onWebrtcRecvState() {
  if (!pcCam) return;
  const ice = pcCam.iceConnectionState || '';
  const conn = pcCam.connectionState || '';
  if (ice === 'connected' || ice === 'completed' || conn === 'connected') {
    if (remoteVideo && remoteVideo.srcObject) showWebrtcLive();
    return;
  }
  if (ice === 'failed' || ice === 'disconnected' || conn === 'failed' || conn === 'disconnected') {
    webrtcLive = false;
    if (camWanted && !livePollTimer) startLivePoll();
    if (liveHint && !webrtcLive) liveHint.textContent = 'Vue live';
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
      remoteVideo.play().catch(() => {});
    }
    showWebrtcLive();
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
    // JPEG en secours tant que le direct WebRTC n’est pas UP.
    if (!webrtcLive && !livePollTimer) startLivePoll();
    ensureCamPeer();
  } else {
    stopWebrtcReceiver();
    if (!livePollTimer) startLivePoll();
    if (liveHint) liveHint.textContent = webrtcLive ? 'Vue live · direct' : 'Vue live';
  }
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
      webrtcLive = false;
      if (camWanted && !livePollTimer) startLivePoll();
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
document.getElementById('photoBtn').onclick = () => socket.emit('take-photo');
document.getElementById('videoBtn').onclick = () => {
  socket.emit('start-video');
  setTimeout(() => socket.emit('stop-video'), 5000);
};

// --- Parler à distance (clic on/off, pas besoin de maintenir) ---
let talkCapture = null;
const talkPlayState = { nextTime: 0 };

async function startTalk() {
  try {
    if (!window.isSecureContext) {
      alert('Cette page n\'est pas en HTTPS. Ouvre l\'URL Cloudflare du Contrôleur (ton tunnel) ou https://localhost:3000 (tablette).');
      return;
    }
    unlockSoundEngine();
    try {
      talkStream = await navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO, video: false });
    } catch (e) {
      talkStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    talking = true;
    talkCapture = await startTalkCapture(talkStream, ({ rate, samples }) => {
      if (!talking) return;
      socket.emit('talk-audio', { rate, samples });
    });
    renderMicStatus('granted');
  } catch (err) {
    talking = false;
    stopTalkCapture(talkCapture);
    talkCapture = null;
    if (talkStream) talkStream.getTracks().forEach((t) => t.stop());
    talkStream = null;
    refreshMicStatus();
    alert('Micro indisponible: ' + err.message);
  }
}
function stopTalk() {
  talking = false;
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
    const el = m.type === 'video'
      ? `<video src="${m.url}" controls></video>`
      : `<img src="${m.url}">`;
    div.innerHTML = `${el}<button class="del" data-name="${m.name}">✕</button>`;
    gallery.appendChild(div);
  });
  gallery.querySelectorAll('.del').forEach((btn) => {
    btn.onclick = () => socket.emit('delete-media', btn.dataset.name);
  });
}
