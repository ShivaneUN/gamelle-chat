function readControllerCode() {
  const params = new URLSearchParams(location.search);
  let next = (params.get('code') || '').trim();
  if (next.length >= 4) return next;
  const m = String(location.pathname || '').match(/\/c\/([^/]+)\/?$/);
  if (m && m[1]) return decodeURIComponent(m[1]).trim();
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
      location.replace('/controller.html?code=' + encodeURIComponent(c));
      return;
    }
    setTimeout(() => location.reload(), 800);
  }).catch(() => {
    setTimeout(() => location.reload(), 800);
  });
  throw new Error('code-redirect');
}

const socket = io();
let pcCam = null;   // reçoit la caméra du récepteur
let talkStream = null;
const MIC_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

socket.on('connect', () => socket.emit('join', { code, role: 'controller' }));
socket.on('peers', ({ receiver, controllers }) => {
  if (receiver) {
    const extra = controllers > 1 ? ` · ${controllers} contrôleurs` : '';
    setStatus(true, 'En ligne', 'Récepteur connecté' + extra);
  } else {
    setStatus(false, 'Connexion…', 'En attente du récepteur…');
    renderReceiverBattery({ offline: true });
  }
});
let livePollTimer = null;

function showRelayLive() {
  if (remoteVideo) {
    remoteVideo.classList.remove('on');
    remoteVideo.style.display = 'none';
  }
  remoteRelay.classList.add('on');
  remoteRelay.style.display = 'block';
  if (liveHint) liveHint.hidden = true;
}

function applyFrame(b64) {
  if (!b64 || typeof b64 !== 'string') return;
  remoteRelay.src = 'data:image/jpeg;base64,' + b64;
  showRelayLive();
}

socket.on('live-frame', (data) => {
  const b64 = typeof data === 'string' ? data : (data && data.jpeg);
  applyFrame(b64);
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
  livePollTimer = setInterval(tick, 400);
}
function stopLivePoll() {
  if (livePollTimer) { clearInterval(livePollTimer); livePollTimer = null; }
}

socket.on('cam-status', ({ on }) => {
  setCamDot(on);
  if (!on) {
    stopLivePoll();
    clearLiveView();
    if (pcCam) { pcCam.close(); pcCam = null; }
    cameraSelect.style.display = 'none';
    cameraList = [];
    renderFacingBtn();
  } else {
    if (liveHint) {
      liveHint.hidden = false;
      liveHint.textContent = 'Caméra allumée, réception de l\'image…';
    }
    startLivePoll();
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
  remoteVideo.srcObject = null;
  remoteVideo.classList.remove('on');
  remoteVideo.style.display = 'none';
  remoteRelay.removeAttribute('src');
  remoteRelay.classList.remove('on');
  remoteRelay.style.display = 'none';
  if (liveHint) {
    liveHint.hidden = false;
    liveHint.textContent = 'En attente de la caméra du récepteur…';
  }
}

function setStatus(on, text, detail) {
  statusEl.classList.toggle('on', !!on);
  statusEl.classList.toggle('off', !on);
  const label = statusEl.querySelector('.status-text');
  if (label) label.textContent = text;
  statusEl.title = detail || text || '';
}
setStatus(false, 'Connexion…', 'En attente du récepteur…');

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
    el.hidden = true;
    el.className = 'battery-badge off';
    el.textContent = '—%';
    el.title = 'Récepteur hors ligne';
    return;
  }
  if (payload.unsupported || payload.level == null) {
    el.hidden = true;
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

function setToggle(btn, on, baseClass) {
  if (!btn) return;
  const base = baseClass || 'tile';
  btn.classList.add(base);
  btn.classList.toggle('toggle-on', !!on);
  btn.classList.toggle('toggle-off', !on);
}

function renderMicStatus(state) {
  setToggle(unlockMicBtn, talking);
  renderTalkBtn();
}

function renderTalkBtn() {
  const btn = document.getElementById('talkBtn');
  if (!btn) return;
  btn.classList.toggle('on', !!talking);
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
  setToggle(document.getElementById('talkSoundBtn'), talkSoundOn);
}

function renderAlarmSoundBtn() {
  setToggle(document.getElementById('alarmSoundBtn'), alarmSoundOn);
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
document.addEventListener('pointerdown', unlockSoundEngine);
document.addEventListener('touchstart', unlockSoundEngine, { passive: true });
document.addEventListener('click', unlockSoundEngine);

unlockMicBtn.onclick = () => { talking ? stopTalk() : startTalk(); };
const talkBtn = document.getElementById('talkBtn');
if (talkBtn) talkBtn.onclick = () => { talking ? stopTalk() : startTalk(); };
renderTalkBtn();

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
const facingBtn = document.getElementById('facingBtn');

function classifyCamLabel(label) {
  const l = String(label || '').toLowerCase();
  if (/front|user|avant|face/.test(l)) return 'Avant';
  if (/back|rear|environment|arrière|arriere|world/.test(l)) return 'Arrière';
  return null;
}

function currentFacingLabel() {
  const cam = cameraList[currentCamIndex];
  if (!cam) return 'Arrière';
  return classifyCamLabel(cam.label) || (currentCamIndex === 0 ? 'Arrière' : 'Avant');
}

function renderFacingBtn() {
  if (!facingBtn) return;
  if (!cameraList.length) {
    facingBtn.hidden = true;
    return;
  }
  facingBtn.hidden = cameraList.length < 2;
  const label = document.getElementById('facingLabel');
  if (label) label.textContent = currentFacingLabel();
}

socket.on('camera-list', (cams) => {
  cameraList = Array.isArray(cams) ? cams : [];
  cameraSelect.innerHTML = cameraList
    .map((c) => `<option value="${c.deviceId}">${c.label}</option>`)
    .join('');
  if (!cameraList.length) {
    currentCamIndex = 0;
    renderFacingBtn();
    return;
  }
  const backIdx = cameraList.findIndex((c) => classifyCamLabel(c.label) === 'Arrière');
  currentCamIndex = backIdx >= 0 ? backIdx : 0;
  cameraSelect.value = cameraList[currentCamIndex].deviceId;
  renderFacingBtn();
});

if (facingBtn) {
  facingBtn.onclick = () => {
    if (cameraList.length < 2) return;
    currentCamIndex = (currentCamIndex + 1) % cameraList.length;
    const cam = cameraList[currentCamIndex];
    if (!cam) return;
    cameraSelect.value = cam.deviceId;
    socket.emit('switch-camera', { deviceId: cam.deviceId });
    renderFacingBtn();
  };
}
cameraSelect.onchange = () => {
  const id = cameraSelect.value;
  const idx = cameraList.findIndex((c) => c.deviceId === id);
  if (idx >= 0) currentCamIndex = idx;
  socket.emit('switch-camera', { deviceId: id });
  renderFacingBtn();
};

// --- WebRTC : réception de la caméra du récepteur ---
function ensureCamPeer() {
  if (pcCam) return pcCam;
  pcCam = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pcCam.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { channel: 'cam', type: 'candidate', candidate: e.candidate });
  };
  pcCam.ontrack = (e) => {
    remoteVideo.srcObject = e.streams[0];
    showWebrtcLive();
  };
  return pcCam;
}

socket.on('signal', async (payload) => {
  if (payload.channel === 'cam' && pcCam) {
    if (payload.type === 'offer') {
      await pcCam.setRemoteDescription(payload.sdp);
      const answer = await pcCam.createAnswer();
      await pcCam.setLocalDescription(answer);
      socket.emit('signal', { channel: 'cam', type: 'answer', sdp: answer });
    }
    if (payload.type === 'answer') await pcCam.setRemoteDescription(payload.sdp);
    if (payload.type === 'candidate') { try { await pcCam.addIceCandidate(payload.candidate); } catch (e) {} }
  }
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
      alert('Cette page n\'est pas en HTTPS. Ouvre l\'URL trycloudflare.com (Contrôleur) ou https://localhost:3000 (tablette).');
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
