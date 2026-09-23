// Déclenchement / arrêt manuel de l'alarme, synchronisé Contrôleur + Récepteur.
function createAlarmControls({ socket, getMessages, playSound, isAudioUnlocked, ensureUnlocked }) {
  const sound1El = document.getElementById('manualAlarmSound1');
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
  let currentBufferSource = null;
  let selectedSound1 = 'beep';
  let selectedMessageId = '';
  let seqToken = 0;
  let playbackRunning = false;

  function fillMessages() {
    const messages = getMessages ? getMessages() : [];
    if (sound1El) {
      renderSoundPicker(sound1El, messages, selectedSound1, (id) => {
        selectedSound1 = id || '';
        fillMessages();
        emitManual();
      }, { includeNone: true });
    }
    if (msgPickerContainer) {
      renderSoundPicker(msgPickerContainer, messages, selectedMessageId, (id) => {
        selectedMessageId = id || '';
        fillMessages();
        emitManual();
      }, { includeNone: true });
    }
  }

  function emitManual() {
    socket.emit('update-manual-alarm', {
      sound1: selectedSound1 || '',
      sound2: selectedMessageId || '',
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
    if (state.sound1 !== undefined) selectedSound1 = state.sound1 || '';
    if (state.sound2 !== undefined) selectedMessageId = state.sound2 || '';
    else if (state.messageId !== undefined) selectedMessageId = state.messageId || '';
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

  function speakOnce(text) {
    const t = (text || '').trim();
    if (!t) {
      return typeof playBuiltinSound === 'function' ? playBuiltinSound('beep') : Promise.resolve();
    }
    if (!('speechSynthesis' in window)) {
      return typeof playBuiltinSound === 'function' ? playBuiltinSound('beep') : Promise.resolve();
    }
    return new Promise((resolve) => {
      try {
        speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(t);
        utter.lang = 'fr-FR';
        utter.volume = (typeof getAlarmPlaybackVolume === 'function') ? getAlarmPlaybackVolume() : 1;
        utter.rate = 1;
        const done = () => resolve();
        utter.onend = done;
        utter.onerror = (ev) => {
          // canceled/interrupted = enchaînement normal de la séquence, pas un vrai échec.
          if (ev.error === 'canceled' || ev.error === 'interrupted') return resolve();
          done();
        };
        const voices = speechSynthesis.getVoices ? speechSynthesis.getVoices() : [];
        const fr = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('fr'));
        if (fr) utter.voice = fr;
        speechSynthesis.speak(utter);
        setTimeout(done, Math.min(8000, 1200 + t.length * 80));
      } catch (e) {
        resolve();
      }
    });
  }

  function resolveAudioUrl(audioUrl) {
    if (!audioUrl) return null;
    if (/^https?:\/\//i.test(audioUrl)) return audioUrl;
    try { return new URL(audioUrl, location.origin).href; } catch (e) { return audioUrl; }
  }

  function stopSound(opts) {
    seqToken++;
    playbackRunning = false;
    clearInterval(alarmSpeakInterval);
    alarmSpeakInterval = null;
    // Garder le keep-alive si on redémarre tout de suite (geste Déclencher encore frais).
    if (!(opts && opts.keepAudioAlive) && typeof stopAlarmAudioKeepAlive === 'function') {
      try { stopAlarmAudioKeepAlive(); } catch (e) {}
    }
    if ('speechSynthesis' in window) { try { speechSynthesis.cancel(); } catch (e) {} }
    if (currentAudioEl) { currentAudioEl.pause(); currentAudioEl.src = ''; currentAudioEl = null; }
    if (currentBufferSource) { try { currentBufferSource.stop(); } catch (e) {} currentBufferSource = null; }
  }

  function playFileOnce(url) {
    return new Promise((resolve) => {
      const el = new Audio(url);
      currentAudioEl = el;
      el.loop = false;
      el.volume = (typeof getAlarmPlaybackVolume === 'function') ? getAlarmPlaybackVolume() : 1;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(safety);
        if (currentAudioEl === el) currentAudioEl = null;
        resolve();
      };
      // Évite de bloquer toute la boucle si ended/error ne vient jamais (WebView).
      const safety = setTimeout(done, 20000);
      el.addEventListener('ended', done);
      el.addEventListener('error', done);
      el.play().catch(() => done());
    });
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function playPart(part, token) {
    if (!alarmOn || token !== seqToken) return;
    if (!part) return;
    if (part.type === 'builtin') {
      if (typeof playBuiltinSound === 'function') await playBuiltinSound(part.id || 'beep');
      return;
    }
    const fullAudio = resolveAudioUrl(part.audioUrl);
    if (fullAudio) {
      await playFileOnce(fullAudio);
      return;
    }
    await speakOnce(part.text || part.name || '');
  }

  function describeSequence(seq) {
    return (seq || []).map((p) => {
      if (!p) return '';
      if (p.type === 'builtin') {
        const labels = window.BUILTIN_SOUND_LABELS || {};
        return labels[p.id] || p.id;
      }
      if (p.audioUrl) return '🔊 ' + (p.name || p.text || 'Audio');
      return '📣 ' + (p.text || p.name || 'Message');
    }).filter(Boolean).join(' → ');
  }

  let lastAlarm = { message: '', audioUrl: null, sequence: [] };

  function defaultSequenceFromLast() {
    if (lastAlarm.sequence && lastAlarm.sequence.length) return lastAlarm.sequence.slice();
    if (lastAlarm.audioUrl || lastAlarm.message) {
      return [{ type: 'message', text: lastAlarm.message, audioUrl: lastAlarm.audioUrl }];
    }
    return [{ type: 'builtin', id: 'beep' }];
  }

  async function playAlarmAudio() {
    if (!playSound || !alarmOn) return;
    if (isAudioUnlocked && !isAudioUnlocked()) return;
    // Ne pas relancer une boucle déjà active (unlock Android / setSoundEnabled répétés).
    if (playbackRunning) return;
    const token = ++seqToken;
    playbackRunning = true;
    const sequence = defaultSequenceFromLast();
    if (typeof startAlarmAudioKeepAlive === 'function') {
      try { await startAlarmAudioKeepAlive(); } catch (e) {}
    }
    try {
      while (alarmOn && token === seqToken) {
        getSharedAudioCtx();
        if (typeof unlockTalkAudio === 'function') unlockTalkAudio();
        for (let i = 0; i < sequence.length; i++) {
          if (!alarmOn || token !== seqToken) return;
          await playPart(sequence[i], token);
          await wait(180);
        }
        await wait(280);
      }
    } finally {
      if (token === seqToken) playbackRunning = false;
    }
  }

  function startLocal(payload) {
    // Ne pas tuer le keep-alive démarré au clic Déclencher (critique iOS).
    stopSound({ keepAudioAlive: true });
    alarmOn = true;
    lastAlarm = {
      message: (payload && payload.message) || '',
      audioUrl: (payload && payload.audioUrl) || null,
      sequence: (payload && payload.sequence) || [],
    };
    const unlocked = !isAudioUnlocked || isAudioUnlocked();
    getSharedAudioCtx();
    const desc = describeSequence(defaultSequenceFromLast());
    if (playSound && !unlocked) {
      if (alarmMsg) alarmMsg.textContent = '🔇 Son alarme coupé — réactive-le pour entendre.';
    } else if (alarmMsg) {
      alarmMsg.textContent = desc || '(bip)';
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
    if (typeof startAlarmAudioKeepAlive === 'function') {
      try { startAlarmAudioKeepAlive(); } catch (e) {}
    }
    if (alarmOn) {
      if (alarmMsg) alarmMsg.textContent = describeSequence(defaultSequenceFromLast()) || '(bip)';
      playAlarmAudio();
    }
  }

  function requestStart() {
    getSharedAudioCtx();
    // Geste utilisateur : activer son local + keep-alive iOS AVANT le round-trip socket.
    if (typeof ensureUnlocked === 'function') {
      try { ensureUnlocked(); } catch (e) {}
    }
    if (typeof startAlarmAudioKeepAlive === 'function') {
      try { startAlarmAudioKeepAlive(); } catch (e) {}
    }
    socket.emit('trigger-alarm', {
      sound1: selectedSound1 || '',
      sound2: selectedMessageId || '',
      messageId: selectedMessageId || null,
      duration: Number(durationInput && durationInput.value) || 30,
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
