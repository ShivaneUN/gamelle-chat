// Déclenchement / arrêt manuel de l'alarme, synchronisé Contrôleur + Récepteur.
function createAlarmControls({ socket, getMessages, playSound, isAudioUnlocked }) {
  const msgPickerContainer = document.getElementById('manualAlarmMsg');
  const durationInput = document.getElementById('manualAlarmDuration');
  const startBtn = document.getElementById('startAlarmBtn');
  const stopBtn = document.getElementById('stopAlarmManualBtn');
  const banner = document.getElementById('alarmBanner');
  const alarmMsg = document.getElementById('alarmMsg');
  const bannerStopBtn = document.getElementById('stopAlarmBtn');

  let alarmOn = false;
  let alarmSpeakInterval = null;
  let currentAudioEl = null;
  let selectedMessageId = '';

  function fillMessages() {
    if (!msgPickerContainer) return;
    const messages = getMessages ? getMessages() : [];
    renderSoundPicker(msgPickerContainer, messages, selectedMessageId, (id) => {
      selectedMessageId = id || '';
      fillMessages();
      emitManual();
    });
  }

  function emitManual() {
    socket.emit('update-manual-alarm', {
      messageId: selectedMessageId || '',
      duration: Number(durationInput && durationInput.value) || 30,
    });
  }

  function selectMessage(id) {
    selectedMessageId = id || '';
    fillMessages();
  }

  function applySync(state) {
    if (!state) return;
    if (state.messageId !== undefined) selectedMessageId = state.messageId || '';
    if (durationInput && state.duration) durationInput.value = state.duration;
    fillMessages();
  }

  function updateButtons() {
    if (startBtn) startBtn.disabled = alarmOn;
    if (stopBtn) stopBtn.disabled = !alarmOn;
  }

  function getSharedAudioCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!window.__gamelleAudioCtx) window.__gamelleAudioCtx = new AC();
    const ctx = window.__gamelleAudioCtx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function playBeep() {
    try {
      const ctx = getSharedAudioCtx();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.2;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      setTimeout(() => { try { osc.stop(); } catch (e) {} }, 500);
    } catch (e) {}
  }

  function speakMessage(text) {
    const t = (text || '').trim();
    if (!t) { playBeep(); return; }
    if (!('speechSynthesis' in window)) { playBeep(); return; }
    try {
      // Annule tout discours en cours pour ne pas cumuler
      speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(t);
      utter.lang = 'fr-FR';
      utter.volume = 1;
      utter.rate = 1;
      utter.onerror = (ev) => {
        if (ev.error === 'canceled' || ev.error === 'interrupted') return;
        playBeep();
      };
      // Attendre que les voix soient chargées (Android peut les charger en async)
      function doSpeak() {
        const voices = speechSynthesis.getVoices ? speechSynthesis.getVoices() : [];
        const fr = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('fr'));
        if (fr) utter.voice = fr;
        speechSynthesis.speak(utter);
      }
      if (speechSynthesis.getVoices && speechSynthesis.getVoices().length === 0) {
        speechSynthesis.onvoiceschanged = () => { speechSynthesis.onvoiceschanged = null; doSpeak(); };
        // Si onvoiceschanged ne se déclenche jamais, parler quand même après 400ms
        setTimeout(() => { if (utter.text && !speechSynthesis.speaking) doSpeak(); }, 400);
      } else {
        doSpeak();
      }
    } catch (e) { playBeep(); }
  }

  function resolveAudioUrl(audioUrl) {
    if (!audioUrl) return null;
    if (/^https?:\/\//i.test(audioUrl)) return audioUrl;
    try { return new URL(audioUrl, location.origin).href; } catch (e) { return audioUrl; }
  }

  let currentBufferSource = null;

  function stopSound() {
    clearInterval(alarmSpeakInterval);
    alarmSpeakInterval = null;
    if ('speechSynthesis' in window) { try { speechSynthesis.cancel(); } catch (e) {} }
    if (currentAudioEl) { currentAudioEl.pause(); currentAudioEl.src = ''; currentAudioEl = null; }
    if (currentBufferSource) { try { currentBufferSource.stop(); } catch (e) {} currentBufferSource = null; }
  }

  async function playDecodedLoop(url) {
    const ctx = getSharedAudioCtx();
    if (!ctx) throw new Error('no ctx');
    if (ctx.state === 'suspended') await ctx.resume();
    const res = await fetch(url);
    if (!res.ok) throw new Error('http ' + res.status);
    const raw = await res.arrayBuffer();
    const decoded = await ctx.decodeAudioData(raw.slice(0));
    if (!alarmOn) return;
    if (isAudioUnlocked && !isAudioUnlocked()) return;
    const src = ctx.createBufferSource();
    src.buffer = decoded;
    src.loop = true;
    src.connect(ctx.destination);
    src.start();
    currentBufferSource = src;
  }

  let lastAlarm = { message: '', audioUrl: null };

  function playAlarmAudio() {
    if (!playSound || !alarmOn) return;
    if (isAudioUnlocked && !isAudioUnlocked()) return;
    stopSound();
    const message = lastAlarm.message;
    const fullAudio = resolveAudioUrl(lastAlarm.audioUrl);
    if (fullAudio) {
      currentAudioEl = new Audio(fullAudio);
      currentAudioEl.loop = true;
      currentAudioEl.play().catch(() => {
        playDecodedLoop(fullAudio).catch(() => {
          speakMessage(message);
          alarmSpeakInterval = setInterval(() => speakMessage(message), 4000);
        });
      });
    } else {
      speakMessage(message);
      alarmSpeakInterval = setInterval(() => speakMessage(message), 4000);
    }
  }

  function startLocal({ message, audioUrl }) {
    stopSound();
    alarmOn = true;
    lastAlarm = { message: message || '', audioUrl: audioUrl || null };
    const unlocked = !isAudioUnlocked || isAudioUnlocked();
    getSharedAudioCtx();

    if (playSound && !unlocked) {
      if (alarmMsg) alarmMsg.textContent = '🔇 Son alarme coupé — réactive-le pour entendre.';
    } else {
      if (alarmMsg) alarmMsg.textContent = lastAlarm.audioUrl
        ? '🔊 Message vocal personnalisé'
        : (lastAlarm.message ? '📣 ' + lastAlarm.message : '(bip par défaut)');
    }
    if (banner) banner.style.display = 'flex';
    updateButtons();
    playAlarmAudio();
  }

  function setSoundEnabled(on) {
    if (!on) {
      stopSound();
      if (alarmOn && alarmMsg) alarmMsg.textContent = '🔇 Son alarme coupé — réactive-le pour entendre.';
      return;
    }
    getSharedAudioCtx();
    if (alarmOn) {
      if (alarmMsg) alarmMsg.textContent = lastAlarm.audioUrl
        ? '🔊 Message vocal personnalisé'
        : (lastAlarm.message ? '📣 ' + lastAlarm.message : '(bip par défaut)');
      playAlarmAudio();
    }
  }

  function requestStart() {
    getSharedAudioCtx();
    const messageId = selectedMessageId || null;
    const messages = getMessages ? getMessages() : [];
    const msg = messageId ? messages.find((m) => m.id === messageId) : null;
    socket.emit('trigger-alarm', {
      messageId,
      duration: Number(durationInput && durationInput.value) || 30,
      text: msg ? (msg.text || '') : '',
      audioUrl: msg ? (msg.audioUrl || null) : null,
      name: msg ? (msg.name || '') : '',
    });
  }

  function stopLocal() {
    stopSound();
    alarmOn = false;
    if (banner) banner.style.display = 'none';
    updateButtons();
  }

  function requestStop() {
    stopLocal();
    socket.emit('stop-alarm');
  }

  if (startBtn) startBtn.onclick = requestStart;
  if (stopBtn) stopBtn.onclick = requestStop;
  if (bannerStopBtn) bannerStopBtn.onclick = requestStop;
  if (durationInput) durationInput.onchange = emitManual;

  socket.on('alarm', (payload) => startLocal(payload || {}));
  socket.on('alarm-stop', () => stopLocal());

  fillMessages();
  updateButtons();
  return { fillMessages, selectMessage, applySync, setSoundEnabled };
}
