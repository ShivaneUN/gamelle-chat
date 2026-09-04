const params = new URLSearchParams(location.search);
const code = params.get('code');
const statusEl = document.getElementById('status');
const remoteVideo = document.getElementById('remoteVideo');
const remoteRelay = document.getElementById('remoteRelay');
const liveHint = document.getElementById('liveHint');
const gallery = document.getElementById('gallery');
const cameraSelect = document.getElementById('cameraSelect');

if (!code) { alert('Code manquant, retour à l\'accueil'); location.href = '/'; }

const socket = io();
let pcCam = null;   // reçoit la caméra du récepteur
let talkStream = null;
const MIC_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

socket.on('connect', () => socket.emit('join', { code, role: 'controller' }));
socket.on('peers', ({ receiver, controllers }) => {
  if (receiver) {
    const extra = controllers > 1 ? ` · ${controllers} contrôleurs` : '';
    setStatus(true, 'Récepteur connecté' + extra);
  } else {
    setStatus(false, 'En attente du récepteur...');
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
  liveHint.textContent = 'Vue live';
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
  } else {
    liveHint.textContent = 'Caméra allumée, réception de l\'image…';
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
  liveHint.textContent = 'En attente de la caméra du récepteur…';
}

function setStatus(on, text) {
  statusEl.className = 'status ' + (on ? 'on' : 'off');
  statusEl.textContent = text;
}
setStatus(false, 'En attente du récepteur...');

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
    return;
  }
  if (payload.unsupported || payload.level == null) {
    el.hidden = false;
    el.className = 'battery-badge off';
    el.textContent = '🔋 ?';
    el.title = 'Batterie du Récepteur indisponible';
    return;
  }
  const pct = payload.level;
  el.hidden = false;
  el.className = 'battery-badge' + (pct <= 20 ? ' low' : pct <= 50 ? ' mid' : '');
  el.textContent = '🔋 ' + pct + '%' + (payload.charging ? ' ⚡' : '');
  el.title = payload.charging ? 'Récepteur en charge' : 'Batterie du Récepteur';
}

socket.on('battery-status', (payload) => renderReceiverBattery(payload));

const unlockMicBtn = document.getElementById('unlockMicBtn');
let talking = false;
let talkSoundOn = true;
let alarmSoundOn = false;

function renderMicStatus(state) {
  if (talking) {
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

// --- Choix de la caméra du récepteur ---
socket.on('camera-list', (cams) => {
  cameraSelect.innerHTML = cams.map((c) => `<option value="${c.deviceId}">${c.label}</option>`).join('');
  cameraSelect.style.display = cams.length > 1 ? 'block' : 'none';
});
cameraSelect.onchange = () => socket.emit('switch-camera', { deviceId: cameraSelect.value });

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
let talkAudioCtx = null;
let talkProcessor = null;
let talkSource = null;
let talkPlayCtx = null;
let talkNextTime = 0;

async function startTalk() {
  try {
    if (!window.isSecureContext) {
      alert('Cette page n\'est pas en HTTPS. Ouvre l\'URL trycloudflare.com (Contrôleur) ou https://localhost:3000 (tablette).');
      return;
    }
    talkStream = await navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO, video: false });

    talkAudioCtx = window.__gamelleAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (!window.__gamelleAudioCtx) window.__gamelleAudioCtx = talkAudioCtx;
    if (talkAudioCtx.state === 'suspended') talkAudioCtx.resume().catch(() => {});
    talkSource = talkAudioCtx.createMediaStreamSource(talkStream);
    talkProcessor = talkAudioCtx.createScriptProcessor(2048, 1, 1);
    talkProcessor.onaudioprocess = (ev) => {
      if (!talking) return;
      const samples = ev.inputBuffer.getChannelData(0);
      const buf = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      socket.emit('talk-audio', { rate: talkAudioCtx.sampleRate, samples: Array.from(buf) });
    };
    const mute = talkAudioCtx.createGain();
    mute.gain.value = 0;
    talkSource.connect(talkProcessor);
    talkProcessor.connect(mute);
    mute.connect(talkAudioCtx.destination);

    talking = true;
    renderMicStatus('granted');
  } catch (err) {
    talking = false;
    refreshMicStatus();
    alert('Micro indisponible: ' + err.message);
  }
}
function stopTalk() {
  talking = false;
  if (talkProcessor) { try { talkProcessor.disconnect(); } catch (e) {} talkProcessor = null; }
  if (talkSource) { try { talkSource.disconnect(); } catch (e) {} talkSource = null; }
  if (talkStream) talkStream.getTracks().forEach((t) => t.stop());
  talkStream = null;
  renderMicStatus('granted');
}

socket.on('talk-audio', ({ rate, samples }) => {
  if (!talkSoundOn || !samples || !samples.length) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!talkPlayCtx) {
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
