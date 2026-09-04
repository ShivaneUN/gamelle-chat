const PAIR_KEY = 'gamellePairCode';

function genPairCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function ensurePairCode() {
  const params = new URLSearchParams(location.search);
  let next = (params.get('code') || '').trim();
  if (next.length >= 4) {
    try { localStorage.setItem(PAIR_KEY, next); } catch (e) {}
    return next;
  }
  try {
    const saved = localStorage.getItem(PAIR_KEY);
    if (saved && String(saved).trim().length >= 4) next = String(saved).trim();
  } catch (e) {}
  if (!next || next.length < 4) next = genPairCode();
  try { localStorage.setItem(PAIR_KEY, next); } catch (e) {}
  try {
    const url = new URL(location.href);
    url.searchParams.set('code', next);
    history.replaceState(null, '', url.pathname + url.search);
  } catch (e) {}
  return next;
}

const code = ensurePairCode();
const statusEl = document.getElementById('status');
const localVideo = document.getElementById('localVideo');
const camBtn = document.getElementById('camBtn');

const pairCodeEl = document.getElementById('pairCode');
if (pairCodeEl) pairCodeEl.textContent = code;

function controllerUrl(origin) {
  return String(origin || '').replace(/\/$/, '') + '/controller.html?code=' + encodeURIComponent(code);
}

function paintControllerLink(url) {
  const a = document.getElementById('controllerLink');
  const btn = document.getElementById('copyControllerLink');
  if (!a || !url) return;
  a.href = url;
  a.textContent = url;
  if (typeof renderQr === 'function') renderQr(document.getElementById('controllerQr'), url);
  if (btn) {
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(url);
        btn.textContent = 'Copié ✅';
        setTimeout(() => { btn.textContent = 'Copier le lien'; }, 1600);
      } catch (e) {
        prompt('Copie cette adresse :', url);
      }
    };
  }
}

paintControllerLink(controllerUrl(location.origin));
(async function waitPublicControllerUrl() {
  for (let i = 0; i < 20; i++) {
    try {
      const info = await fetch('/api/info').then((r) => r.json());
      if (info.publicUrl) {
        paintControllerLink(controllerUrl(info.publicUrl));
        return;
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
  socket.emit('join', { code, role: 'receiver' });
  startBatteryWatch();
});
socket.on('peers', ({ controllers }) => {
  if (controllers > 0) {
    setStatus(true, controllers === 1 ? '1 contrôleur connecté' : `${controllers} contrôleurs connectés`);
  } else {
    setStatus(false, 'En attente d\'un contrôleur');
  }
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
}
setStatus(false, 'En attente du contrôleur...');

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

const unlockMicBtn = document.getElementById('unlockMicBtn');

function renderMicStatus(state) {
  if (micOn) {
    unlockMicBtn.textContent = '✅ Micro';
    unlockMicBtn.className = 'toggle-on';
    return;
  }
  if (state === 'denied') {
    unlockMicBtn.textContent = '⛔ Micro';
    unlockMicBtn.className = 'toggle-off';
  } else {
    unlockMicBtn.textContent = '🎙️ Micro';
    unlockMicBtn.className = 'toggle-off';
  }
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
    if (micOn) {
      micOn = false;
      stopMicTalk();
      if (localStream) localStream.getAudioTracks().forEach((t) => { t.enabled = false; t.stop(); localStream.removeTrack(t); });
      renderMicStatus('granted');
      return;
    }
    const testStream = await navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO, video: false });
    if (camOn && localStream) {
      testStream.getAudioTracks().forEach((t) => localStream.addTrack(t));
      startMicTalk(localStream, false);
    } else {
      startMicTalk(testStream, true);
    }
    micOn = true;
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
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      if (!window.__gamelleAudioCtx) window.__gamelleAudioCtx = new AC();
      window.__gamelleAudioCtx.resume().catch(() => {});
    }
  } catch (e) {}
}

function renderTalkSoundBtn() {
  const btn = document.getElementById('talkSoundBtn');
  if (!btn) return;
  if (talkSoundOn) {
    btn.textContent = '✅ Voix';
    btn.className = 'toggle-on';
  } else {
    btn.textContent = '🔇 Voix';
    btn.className = 'toggle-off';
  }
}

function renderAlarmSoundBtn() {
  const btn = document.getElementById('alarmSoundBtn');
  if (!btn) return;
  if (alarmSoundOn) {
    btn.textContent = '✅ Alarme';
    btn.className = 'toggle-on';
  } else {
    btn.textContent = '🔇 Alarme';
    btn.className = 'toggle-off';
  }
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
document.addEventListener('pointerdown', unlockSoundEngine, { once: true });

let talkSendCtx = null;
let talkSendProc = null;
let talkSendSrc = null;
let talkSendStream = null;
let talkSendOwnsStream = false;

function startMicTalk(stream, ownsStream) {
  stopMicTalk();
  if (!stream) return;
  talkSendStream = stream;
  talkSendOwnsStream = !!ownsStream;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  talkSendCtx = window.__gamelleAudioCtx || new AC();
  if (!window.__gamelleAudioCtx) window.__gamelleAudioCtx = talkSendCtx;
  if (talkSendCtx.state === 'suspended') talkSendCtx.resume().catch(() => {});
  talkSendSrc = talkSendCtx.createMediaStreamSource(stream);
  talkSendProc = talkSendCtx.createScriptProcessor(2048, 1, 1);
  talkSendProc.onaudioprocess = (ev) => {
    if (!micOn) return;
    const samples = ev.inputBuffer.getChannelData(0);
    const buf = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    socket.emit('talk-audio', { rate: talkSendCtx.sampleRate, samples: Array.from(buf) });
  };
  const mute = talkSendCtx.createGain();
  mute.gain.value = 0;
  talkSendSrc.connect(talkSendProc);
  talkSendProc.connect(mute);
  mute.connect(talkSendCtx.destination);
}

function stopMicTalk() {
  if (talkSendProc) { try { talkSendProc.disconnect(); } catch (e) {} talkSendProc = null; }
  if (talkSendSrc) { try { talkSendSrc.disconnect(); } catch (e) {} talkSendSrc = null; }
  if (talkSendOwnsStream && talkSendStream) {
    talkSendStream.getTracks().forEach((t) => t.stop());
  }
  talkSendStream = null;
  talkSendOwnsStream = false;
}

// --- Caméra locale : activer / désactiver ---
let camOn = false;
function setCamDot(on) {
  const dot = document.getElementById('camDot');
  if (!dot) return;
  dot.classList.toggle('on', !!on);
  dot.title = on ? 'Caméra allumée' : 'Caméra éteinte';
}
camBtn.onclick = async () => { camOn ? disableCamera() : await enableCamera(); };

async function enableCamera() {
  try {
    const videoConstraints = { facingMode: { ideal: 'environment' }, width: { ideal: 640 } };
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
    const camHint = document.getElementById('camHint');
    if (camHint) camHint.textContent = 'Caméra allumée — le Contrôleur peut voir le direct.';
    await localVideo.play().catch(() => {});
    await new Promise((resolve) => {
      if (localVideo.videoWidth) return resolve();
      localVideo.onloadedmetadata = () => resolve();
      setTimeout(resolve, 2500);
    });
    camBtn.textContent = '🔴 Caméra';
    camBtn.className = 'toggle-on';
    camOn = true;
    setCamDot(true);
    if (localStream.getAudioTracks && localStream.getAudioTracks().length) {
      micOn = true;
      renderMicStatus('granted');
      startMicTalk(localStream, false);
    }
    startLiveRelay();
    socket.emit('cam-status', { on: true });
    sendCameraList();
  } catch (e) {
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

// --- Changement de caméra demandé par le contrôleur, sans couper le direct ---
socket.on('switch-camera', async ({ deviceId }) => {
  if (!camOn) return;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } }, audio: micOn ? MIC_AUDIO : false });
    const newVideoTrack = newStream.getVideoTracks()[0];
    const newAudioTrack = newStream.getAudioTracks()[0];
    if (pcCam) {
      const videoSender = pcCam.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (videoSender && newVideoTrack) videoSender.replaceTrack(newVideoTrack);
      const audioSender = pcCam.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (audioSender && newAudioTrack) audioSender.replaceTrack(newAudioTrack);
    }
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    localStream = newStream;
    localVideo.srcObject = localStream;
    if (micOn) startMicTalk(localStream, false);
  } catch (e) {
    console.warn('Changement de caméra impossible:', e.message);
  }
});

function disableCamera() {
  stopLiveRelay();
  if (pcCam) { pcCam.close(); pcCam = null; }
  const keepTalking = micOn;
  stopMicTalk();
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  localVideo.srcObject = null;
  localVideo.classList.remove('on');
  localVideo.style.display = 'none';
  const camHint = document.getElementById('camHint');
  if (camHint) camHint.textContent = 'Caméra éteinte — le Contrôleur ne voit rien tant qu’elle n’est pas activée.';
  camBtn.textContent = '📷 Caméra';
  camBtn.className = '';
  camOn = false;
  setCamDot(false);
  socket.emit('cam-status', { on: false });
  if (keepTalking) {
    navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then((s) => {
      if (!micOn) { s.getTracks().forEach((t) => t.stop()); return; }
      startMicTalk(s, true);
    }).catch(() => {});
  }
}

// Relais JPEG via le serveur : marche aussi hors WiFi (4G / autre réseau)
let liveRelayTimer = null;
function startLiveRelay() {
  stopLiveRelay();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  liveRelayTimer = setInterval(() => {
    if (!camOn) return;
    if (!localVideo.videoWidth) return;
    const wSrc = localVideo.videoWidth;
    const hSrc = localVideo.videoHeight;
    const w = 240;
    const h = Math.max(1, Math.round(hSrc * (w / wSrc)));
    canvas.width = w;
    canvas.height = h;
    try { ctx.drawImage(localVideo, 0, 0, w, h); } catch (e) { return; }
    const data = canvas.toDataURL('image/jpeg', 0.4).split(',')[1];
    if (data) socket.emit('live-frame', data);
  }, 250);
}
function stopLiveRelay() {
  if (liveRelayTimer) { clearInterval(liveRelayTimer); liveRelayTimer = null; }
}

// --- Voix du contrôleur (relais PCM, marche hors LAN) ---
let talkPlayCtx = null;
let talkNextTime = 0;

socket.on('talk-audio', ({ rate, samples }) => {
  if (!talkSoundOn || !samples || !samples.length) return;
  try {
    if (!talkPlayCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      talkPlayCtx = window.__gamelleAudioCtx || new AC();
      if (!window.__gamelleAudioCtx) window.__gamelleAudioCtx = talkPlayCtx;
    }
    const ctx = talkPlayCtx;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
      return;
    }
    const float32 = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) float32[i] = samples[i] / 0x8000;
    const buf = ctx.createBuffer(1, float32.length, rate || ctx.sampleRate);
    buf.getChannelData(0).set(float32);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    if (talkNextTime < now + 0.05) talkNextTime = now + 0.05;
    src.start(talkNextTime);
    talkNextTime += buf.duration;
  } catch (e) {}
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

if (typeof bindAppUpdate === 'function') {
  const updateCard = document.getElementById('updateCard');
  if (updateCard) bindAppUpdate(updateCard);
}
