function setBtnLabel(btn, label, className) {
  if (!btn) return;
  if (className) btn.className = className;
  const lbl = btn.querySelector('.lbl');
  if (lbl) lbl.textContent = label;
  else btn.textContent = label;
}

const PAIR_KEY = 'gamellePairCode';

function genPairCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function readStoredPairCode() {
  const params = new URLSearchParams(location.search);
  let next = (params.get('code') || '').trim();
  if (next.length >= 4) return next;
  try {
    const saved = localStorage.getItem(PAIR_KEY);
    if (saved && String(saved).trim().length >= 4) return String(saved).trim();
  } catch (e) {}
  return '';
}

function commitPairCode(next) {
  const codeVal = String(next || '').trim();
  if (codeVal.length < 4) return codeVal;
  try { localStorage.setItem(PAIR_KEY, codeVal); } catch (e) {}
  try {
    const url = new URL(location.href);
    if (url.searchParams.has('code')) {
      url.searchParams.delete('code');
      history.replaceState(null, '', url.pathname);
    }
  } catch (e) {}
  return codeVal;
}

let code = '';

async function resolvePairCode() {
  try {
    const j = await fetch('/api/active-code').then((r) => r.json());
    if (j && j.code && String(j.code).trim().length >= 4) {
      code = commitPairCode(String(j.code).trim());
      return code;
    }
  } catch (e) {}
  const stored = readStoredPairCode();
  if (stored && stored.length >= 4) {
    code = commitPairCode(stored);
    return code;
  }
  code = commitPairCode(genPairCode());
  return code;
}

const statusEl = document.getElementById('status');
const localVideo = document.getElementById('localVideo');
const camBtn = document.getElementById('camBtn');

function paintControllerLink(origin) {
  const base = String(origin || '').replace(/\/$/, '');
  const scannable = typeof isScannableQrUrl === 'function' ? isScannableQrUrl(base) : false;
  const share = scannable ? (base + '/controller.html') : '';
  window.__GAMELLE_CONTROLLER_URL__ = share;
  const urlEl = document.getElementById('ctrlLinkUrl');
  const hint = document.getElementById('ctrlLinkHint');
  const img = document.getElementById('ctrlQrImg');
  const box = document.getElementById('ctrlQrBox');
  if (urlEl) {
    urlEl.textContent = share;
    urlEl.hidden = !share;
  }
  if (!scannable || !share) {
    if (box) box.hidden = true;
    if (img) img.removeAttribute('src');
    if (hint) hint.textContent = 'En attente du tunnel Cloudflare…';
    return true;
  }
  if (hint) hint.textContent = 'Connecter votre appareil';
  if (img && typeof makeQrDataUrl === 'function') {
    try {
      img.src = makeQrDataUrl(share, 12, 8);
      img.width = 280;
      img.height = 280;
      if (box) box.hidden = false;
    } catch (e) {
      if (box) box.hidden = true;
    }
  }
  return true;
}

function applyRemoteOrigin(origin) {
  if (!origin) return false;
  const url = String(origin).replace(/\/$/, '');
  if (typeof isScannableQrUrl === 'function' && !isScannableQrUrl(url)) return false;
  paintControllerLink(url);
  return true;
}

function refreshControllerLink() {
  applyRemoteOrigin(window.__GAMELLE_PUBLIC_URL__ || '');
}

paintControllerLink('');

(async function waitPublicControllerUrl() {
  for (;;) {
    if (applyRemoteOrigin(window.__GAMELLE_PUBLIC_URL__)) return;
    try {
      const info = await fetch('/api/info').then((r) => r.json());
      if (info && info.publicUrl) {
        window.__GAMELLE_PUBLIC_URL__ = info.publicUrl;
        if (applyRemoteOrigin(info.publicUrl)) return;
      }
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 1500));
  }
})();

const socket = io();
let localStream = null;
let pcCam = null;   // envoie la caméra vers le contrôleur
let mediaRecorder = null;
let recordedChunks = [];
let micOn = false;
let talkSoundOn = true;
let alarmSoundOn = true;
const MIC_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

socket.on('connect', () => {
  resolvePairCode().then((c) => {
    socket.emit('join', { code: c, role: 'receiver' });
    refreshControllerLink();
    startBatteryWatch();
  });
});
socket.on('peers', ({ controllers, names }) => {
  const n = Number(controllers) || 0;
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  window.__GAMELLE_PEER_NAMES__ = list;
  if (n <= 0) {
    setStatus(false, 'Pas de contrôleur en ligne');
  } else if (n === 1) {
    const who = list[0] ? ` · ${list[0]}` : '';
    setStatus(true, `1 contrôleur en ligne${who}`);
  } else {
    setStatus(true, `${n} contrôleurs en ligne`);
  }
  renderPeersPop();
});
socket.on('room-state', (state) => {
  msgLibrary.setMessages(state.messages);
  schedManager.setSchedules(state.schedules);
  renderGallery(state.media || []);
  if (alarmControls.applySync) alarmControls.applySync(state.manualAlarm);
});

function setStatus(on, text) {
  statusEl.className = 'status ' + (on ? 'on' : 'off');
  statusEl.textContent = text;
  statusEl.style.cursor = on ? 'pointer' : 'default';
  statusEl.title = on ? 'Voir qui est en ligne' : '';
}
setStatus(false, 'Pas de contrôleur en ligne');

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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

// --- Horaires (composant partagé avec le contrôleur, référence la bibliothèque de messages) ---
const schedManager = createScheduleManager({ containerId: 'schedList', socket, getMessages: msgLibrary.getMessages });
document.getElementById('addSched').onclick = () => schedManager.addSchedule();

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
function openControllerLinkModal() {
  (async () => {
    try {
      if (window.__GAMELLE_PUBLIC_URL__) {
        applyRemoteOrigin(window.__GAMELLE_PUBLIC_URL__);
      }
      const info = await fetch('/api/info').then((r) => r.json());
      if (info && info.publicUrl) {
        window.__GAMELLE_PUBLIC_URL__ = info.publicUrl;
        applyRemoteOrigin(info.publicUrl);
      }
    } catch (e) {
      refreshControllerLink();
    }
    openModal('ctrlLinkModal');
  })();
}
const qrBtn = document.getElementById('qrBtn');
if (qrBtn) {
  qrBtn.onclick = () => {
    const share =
      window.__GAMELLE_CONTROLLER_URL__ ||
      (window.__GAMELLE_PUBLIC_URL__
        ? String(window.__GAMELLE_PUBLIC_URL__).replace(/\/$/, '') + '/controller.html'
        : '');
    if (window.GamelleHost) {
      nativeHost(share ? ('qr|' + share) : 'qr');
    } else {
      openControllerLinkModal();
    }
  };
}
if (window.GamelleHost) {
  document.body.classList.add('in-app');
}
const homeBtn = document.getElementById('homeBtn');
if (homeBtn) {
  homeBtn.onclick = () => {
    if (window.GamelleHost) nativeHost('home');
    else location.href = '/';
  };
}

const unlockMicBtn = document.getElementById('unlockMicBtn');

function renderMicStatus(state) {
  setBtnLabel(unlockMicBtn, 'Micro', micOn ? 'tile-btn toggle-on' : 'tile-btn toggle-off');
}

async function refreshMicStatus() {
  if (!navigator.permissions || !navigator.permissions.query) return;
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    renderMicStatus(status.state);
    status.onchange = () => renderMicStatus(status.state);
  } catch (e) {}
}
refreshMicStatus();

unlockMicBtn.onclick = async () => {
  try {
    if (!window.isSecureContext) {
      alert('Cette page n\'est pas en HTTPS. Ouvre https:// sur la tablette.');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Le navigateur n\'expose pas le micro. Utilise Chrome, en https://');
      return;
    }
    unlockSoundEngine();
    if (micOn) {
      micOn = false;
      stopMicTalk();
      if (localStream) localStream.getAudioTracks().forEach((t) => { t.enabled = false; t.stop(); localStream.removeTrack(t); });
      renderMicStatus('granted');
      return;
    }
    let testStream;
    try {
      testStream = await navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO, video: false });
    } catch (e) {
      testStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    micOn = true;
    if (camOn && localStream) {
      testStream.getAudioTracks().forEach((t) => localStream.addTrack(t));
      await startMicTalk(localStream, false);
    } else {
      await startMicTalk(testStream, true);
    }
    renderMicStatus('granted');
    refreshMicStatus();
  } catch (e) {
    micOn = false;
    refreshMicStatus();
    let tip = e.name + ' — ' + e.message;
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      tip += '\n\nClique le 🔒 à gauche de l\'adresse → Micro → Autoriser, puis recharge.';
    } else if (e.name === 'NotFoundError') {
      tip += '\n\nAucun micro détecté.';
    } else if (e.name === 'NotReadableError' || e.name === 'AbortError') {
      tip += '\n\nLe micro est déjà pris par une autre appli.';
    }
    alert('Micro refusé ou indisponible: ' + tip);
  }
};

function unlockSoundEngine() {
  if ('speechSynthesis' in window) speechSynthesis.getVoices();
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

function renderCamBtn() {
  if (!camBtn) return;
  setBtnLabel(camBtn, 'Caméra', camOn ? 'chip-btn toggle-on' : 'chip-btn toggle-off');
}

const talkSoundBtn = document.getElementById('talkSoundBtn');
if (talkSoundBtn) {
  talkSoundBtn.onclick = () => {
    talkSoundOn = !talkSoundOn;
    if (talkSoundOn) unlockSoundEngine();
    renderTalkSoundBtn();
  };
}

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
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) unlockSoundEngine();
  if (camOn) keepCameraAlive();
});
setInterval(() => {
  if (camOn) keepCameraAlive();
}, 2000);

function nativeHost(cmd) {
  try {
    if (window.GamelleHost && typeof GamelleHost.postMessage === 'function') {
      GamelleHost.postMessage(cmd);
    }
  } catch (e) {}
}

let screenOn = true;

const bgBtn = document.getElementById('bgBtn');
if (bgBtn) {
  bgBtn.onclick = () => {
    nativeHost('background');
  };
}

function renderScreenOffBtn() {
  const btn = document.getElementById('screenOffBtn');
  if (!btn) return;
  setBtnLabel(
    btn,
    screenOn ? 'Écran off' : 'Écran on',
    screenOn ? 'tile-btn toggle-on' : 'tile-btn toggle-off'
  );
}

const screenOffBtn = document.getElementById('screenOffBtn');
if (screenOffBtn) {
  screenOffBtn.onclick = () => {
    screenOn = !screenOn;
    if (screenOn) {
      nativeHost('on');
      socket.emit('screen-on');
    } else {
      nativeHost('off');
      socket.emit('screen-off');
    }
    renderScreenOffBtn();
  };
}
renderScreenOffBtn();

socket.on('screen-on', () => {
  screenOn = true;
  nativeHost('on');
  renderScreenOffBtn();
});
socket.on('screen-off', () => {
  screenOn = false;
  nativeHost('off');
  renderScreenOffBtn();
});

let talkCapture = null;
let talkSendStream = null;
let talkSendOwnsStream = false;
const talkPlayState = { nextTime: 0 };

async function startMicTalk(stream, ownsStream) {
  stopMicTalk();
  if (!stream) return;
  talkSendStream = stream;
  talkSendOwnsStream = !!ownsStream;
  talkCapture = await startTalkCapture(stream, ({ rate, samples }) => {
    if (!micOn) return;
    socket.emit('talk-audio', { rate, samples });
  });
}

function stopMicTalk() {
  stopTalkCapture(talkCapture);
  talkCapture = null;
  if (talkSendOwnsStream && talkSendStream) {
    talkSendStream.getTracks().forEach((t) => t.stop());
  }
  talkSendStream = null;
  talkSendOwnsStream = false;
}

// --- Caméra locale : activer / désactiver ---
function setLivePlaceholder(show) {
  const el = document.getElementById('livePlaceholder');
  if (!el) return;
  el.classList.toggle('on', !!show);
  el.style.display = show ? 'block' : 'none';
}

let camOn = false;
function setCamDot(on) {
  const dot = document.getElementById('camDot');
  if (!dot) return;
  dot.classList.toggle('on', !!on);
  dot.title = on ? 'Caméra allumée' : 'Caméra éteinte';
}
camBtn.onclick = async () => {
  if (camOn) {
    disableCamera();
    return;
  }
  renderCamBtnPending(true);
  await enableCamera();
};

function renderCamBtnPending(on) {
  if (!camBtn) return;
  setBtnLabel(camBtn, 'Caméra', on ? 'chip-btn toggle-on' : 'chip-btn toggle-off');
}

async function enableCamera() {
  try {
    const videoConstraints = {
      facingMode: { ideal: 'environment' },
      width: { ideal: 640 },
      frameRate: { ideal: 24, max: 30 },
    };
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: micOn ? MIC_AUDIO : false,
      });
    } catch (e) {
      localStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
    }
    localVideo.srcObject = localStream;
    localVideo.muted = true;
    localVideo.playsInline = true;
    localVideo.classList.add('on');
    localVideo.style.display = 'block';
    setLivePlaceholder(false);
    const camHint = document.getElementById('camHint');
    if (camHint) camHint.textContent = 'Caméra allumée — le Contrôleur peut voir le direct.';
    await localVideo.play().catch(() => {});
    await new Promise((resolve) => {
      if (localVideo.videoWidth) return resolve();
      localVideo.onloadedmetadata = () => resolve();
      setTimeout(resolve, 2500);
    });
    camOn = true;
    renderCamBtn();
    setCamDot(true);
    if (localStream.getAudioTracks && localStream.getAudioTracks().length) {
      micOn = true;
      renderMicStatus('granted');
      await startMicTalk(localStream, false);
    }
    startLiveRelay();
    socket.emit('cam-status', { on: true });
    sendCameraList();
    if (torchWanted) await applyTorch(true);
  } catch (e) {
    renderCamBtn();
    alert('Impossible d\'accéder à la caméra: ' + e.name + ' — ' + e.message + '\n\nClique le 🔒 à gauche de l\'adresse → Caméra → Autoriser.');
  }
}

// --- Envoie au contrôleur la liste des caméras disponibles (avant/arrière, externe...) ---
async function sendCameraList() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Caméra ${i + 1}` }));
    socket.emit('camera-list', cams);
  } catch (e) {
    console.warn('Impossible de lister les caméras:', e.message);
  }
}

// --- Flash / torche demandé par le contrôleur ---
let torchWanted = false;

async function applyTorch(on) {
  torchWanted = !!on;
  if (!camOn || !localStream) {
    socket.emit('torch-status', { on: false, unsupported: false });
    return false;
  }
  const track = localStream.getVideoTracks()[0];
  if (!track) {
    socket.emit('torch-status', { on: false, unsupported: true });
    return false;
  }
  let caps = null;
  try {
    caps = track.getCapabilities ? track.getCapabilities() : null;
  } catch (e) {
    caps = null;
  }
  if (!caps || !('torch' in caps) || !caps.torch) {
    socket.emit('torch-status', { on: false, unsupported: true });
    return false;
  }
  try {
    await track.applyConstraints({ advanced: [{ torch: !!on }] });
    socket.emit('torch-status', { on: !!on, unsupported: false });
    return true;
  } catch (e) {
    console.warn('Flash impossible:', e.message);
    socket.emit('torch-status', { on: false, unsupported: true });
    return false;
  }
}

socket.on('torch', async (payload) => {
  await applyTorch(!!(payload && payload.on));
});

// --- Changement de caméra demandé par le contrôleur, sans couper le direct ---
socket.on('switch-camera', async (payload) => {
  if (!camOn) return;
  const deviceId = payload && payload.deviceId;
  const facingMode = (payload && payload.facingMode) || 'environment';
  const oldStream = localStream;

  // Libérer l'objectif actuel avant d'ouvrir l'autre (requis sur beaucoup d'Android).
  if (oldStream) {
    oldStream.getVideoTracks().forEach((t) => {
      try { t.stop(); } catch (e) {}
    });
  }

  const videoAttempts = [];
  if (deviceId) {
    videoAttempts.push({ deviceId: { exact: deviceId }, width: { ideal: 640 }, frameRate: { ideal: 24, max: 30 } });
    videoAttempts.push({ deviceId: { ideal: deviceId }, width: { ideal: 640 }, frameRate: { ideal: 24, max: 30 } });
  }
  videoAttempts.push({ facingMode: { exact: facingMode }, width: { ideal: 640 }, frameRate: { ideal: 24, max: 30 } });
  videoAttempts.push({ facingMode: { ideal: facingMode }, width: { ideal: 640 }, frameRate: { ideal: 24, max: 30 } });
  videoAttempts.push({ width: { ideal: 640 }, frameRate: { ideal: 24, max: 30 } });

  let newStream = null;
  let lastErr = null;
  for (const video of videoAttempts) {
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        video,
        audio: micOn ? MIC_AUDIO : false,
      });
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!newStream) {
    console.warn('Changement de caméra impossible:', lastErr && (lastErr.name + ' ' + lastErr.message));
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 } },
        audio: micOn ? MIC_AUDIO : false,
      });
      localVideo.srcObject = localStream;
      if (pcCam) {
        const vt = localStream.getVideoTracks()[0];
        const videoSender = pcCam.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (videoSender && vt) videoSender.replaceTrack(vt);
      }
      if (micOn) await startMicTalk(localStream, false);
    } catch (e2) {
      console.warn('Impossible de rétablir la caméra:', e2.message);
    }
    return;
  }

  try {
    const newVideoTrack = newStream.getVideoTracks()[0];
    const newAudioTrack = newStream.getAudioTracks()[0];
    if (pcCam) {
      const videoSender = pcCam.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (videoSender && newVideoTrack) await videoSender.replaceTrack(newVideoTrack);
      const audioSender = pcCam.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (audioSender && newAudioTrack) await audioSender.replaceTrack(newAudioTrack);
    }
    if (oldStream) {
      oldStream.getTracks().forEach((t) => {
        try { t.stop(); } catch (e) {}
      });
    }
    localStream = newStream;
    localVideo.srcObject = localStream;
    await localVideo.play().catch(() => {});
    if (micOn) await startMicTalk(localStream, false);
    sendCameraList();
    if (torchWanted) await applyTorch(true);
  } catch (e) {
    console.warn('Changement de caméra impossible:', e.message);
  }
});

function disableCamera() {
  stopLiveRelay();
  if (pcCam) { pcCam.close(); pcCam = null; }
  const keepTalking = micOn;
  stopMicTalk();
  torchWanted = false;
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  localVideo.srcObject = null;
  localVideo.classList.remove('on');
  localVideo.style.display = 'none';
  setLivePlaceholder(true);
  const camHint = document.getElementById('camHint');
  if (camHint) camHint.textContent = 'Caméra éteinte — le Contrôleur ne voit rien tant qu’elle n’est pas activée.';
  camOn = false;
  renderCamBtn();
  setCamDot(false);
  socket.emit('cam-status', { on: false });
  socket.emit('torch-status', { on: false, unsupported: false });
  if (keepTalking) {
    navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then((s) => {
      if (!micOn) { s.getTracks().forEach((t) => t.stop()); return; }
      startMicTalk(s, true).catch(() => {});
    }).catch(() => {});
  }
}

// Relais JPEG via le serveur : marche aussi hors WiFi (4G / autre réseau)
let liveRelayTimer = null;
let liveGrabber = null;
let liveGrabberTrack = null;
let jsAwakeOsc = null;

function keepJsAwake() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!window.__gamelleAudioCtx) window.__gamelleAudioCtx = new AC();
    const ctx = window.__gamelleAudioCtx;
    ctx.resume().catch(() => {});
    if (jsAwakeOsc) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0.00001;
    osc.frequency.value = 20;
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start();
    jsAwakeOsc = osc;
  } catch (e) {}
}

function keepCameraAlive() {
  if (!camOn) return;
  keepJsAwake();
  try {
    if (localStream) {
      localStream.getVideoTracks().forEach((t) => { t.enabled = true; });
    }
    if (localVideo) localVideo.play().catch(() => {});
  } catch (e) {}
  startLiveRelay();
}

function startLiveRelay() {
  stopLiveRelay();
  keepJsAwake();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  liveGrabber = null;
  liveGrabberTrack = null;
  let busy = false;
  let lastSent = 0;
  // JPEG via tunnel / 4G : viser ~12 fps fluides, payloads modestes.
  let intervalMs = 80;
  const WIDTH = 288;
  const QUALITY = 0.34;

  const tick = () => {
    if (!camOn || !localStream || !localVideo) return;
    if (busy) return;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (now - lastSent < intervalMs) return;
    const track = localStream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') return;
    const srcW = localVideo.videoWidth;
    const srcH = localVideo.videoHeight;
    if (!srcW || !srcH) return;

    const w = WIDTH;
    const h = Math.max(1, Math.round(srcH * (w / srcW)));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    try {
      ctx.drawImage(localVideo, 0, 0, w, h);
    } catch (e) {
      return;
    }

    busy = true;
    lastSent = now;
    const t0 = now;
    const afterSend = () => {
      const dt = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
      // Adapter : encode lent → ralentir ; rapide → remonter vers ~12–14 fps.
      if (dt > 85) intervalMs = Math.min(160, Math.max(intervalMs, Math.round(dt * 1.1)));
      else if (dt < 40) intervalMs = Math.max(70, intervalMs - 6);
      busy = false;
    };

    const emitFrame = (payload) => {
      try {
        // volatile = drop si buffer plein (mieux pour le live 4G que d’empiler).
        if (socket.volatile) socket.volatile.emit('live-frame', payload);
        else socket.emit('live-frame', payload);
      } catch (e) {}
    };

    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((blob) => {
        if (!blob || !camOn) {
          busy = false;
          return;
        }
        emitFrame(blob);
        afterSend();
      }, 'image/jpeg', QUALITY);
      return;
    }
    try {
      const data = canvas.toDataURL('image/jpeg', QUALITY).split(',')[1];
      if (data) emitFrame(data);
    } catch (e) {}
    afterSend();
  };

  liveRelayTimer = setInterval(tick, 25);
  tick();
}
function stopLiveRelay() {
  if (liveRelayTimer) { clearInterval(liveRelayTimer); liveRelayTimer = null; }
  liveGrabber = null;
  liveGrabberTrack = null;
}

// --- Voix du contrôleur (relais PCM, marche hors LAN) ---
socket.on('talk-audio', ({ rate, samples }) => {
  if (!talkSoundOn) return;
  playTalkPcm(talkPlayState, rate, samples);
});

socket.on('signal', async (payload) => {
  if (payload.channel === 'cam' && pcCam) {
    if (payload.type === 'answer') await pcCam.setRemoteDescription(payload.sdp);
    if (payload.type === 'candidate') { try { await pcCam.addIceCandidate(payload.candidate); } catch (e) {} }
  }
});

// --- Capture photo sur demande du contrôleur ---
socket.on('take-photo', () => {
  if (!camOn || !localStream) return;
  const canvas = document.createElement('canvas');
  canvas.width = localVideo.videoWidth;
  canvas.height = localVideo.videoHeight;
  canvas.getContext('2d').drawImage(localVideo, 0, 0);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  socket.emit('media-captured', { type: 'photo', data: dataUrl.split(',')[1], ext: 'jpg' });
});

// --- Capture vidéo courte sur demande du contrôleur ---
socket.on('start-video', () => {
  if (!camOn || !localStream) return;
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(localStream, { mimeType: 'video/webm' });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const reader = new FileReader();
    reader.onloadend = () => socket.emit('media-captured', { type: 'video', data: reader.result.split(',')[1], ext: 'webm' });
    reader.readAsDataURL(blob);
  };
  mediaRecorder.start();
});
socket.on('stop-video', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
});

function renderGallery(media) {
  const gallery = document.getElementById('gallery');
  if (!gallery) return;
  gallery.innerHTML = '';
  if (!media || !media.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Aucune photo ni vidéo pour l’instant.';
    gallery.appendChild(empty);
    return;
  }
  media.forEach((m) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = m.type === 'video'
      ? `<video src="${m.url}" controls></video>`
      : `<img src="${m.url}">`;
    gallery.appendChild(div);
  });
}

let lastBattery = null;
let batteryWatchStarted = false;

function emitBattery(payload) {
  lastBattery = payload;
  socket.emit('battery-status', payload);
}

function startBatteryWatch() {
  if (lastBattery) emitBattery(lastBattery);
  if (batteryWatchStarted) return;
  if (!navigator.getBattery) {
    batteryWatchStarted = true;
    emitBattery({ level: null, charging: false, unsupported: true });
    return;
  }
  batteryWatchStarted = true;
  navigator.getBattery().then((bat) => {
    const send = () => emitBattery({
      level: Math.round((bat.level || 0) * 100),
      charging: !!bat.charging,
    });
    send();
    bat.addEventListener('levelchange', send);
    bat.addEventListener('chargingchange', send);
    setInterval(send, 60000);
  }).catch(() => {
    emitBattery({ level: null, charging: false, unsupported: true });
  });
}

