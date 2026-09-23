// Sons intégrés (bip, carillon) — Web Audio + repli HTML Audio (iOS Safari).
(function (global) {
  const LABELS = {
    beep: '🔔 Bip',
    chime: '✨ Carillon',
  };
  var alarmVolume = 1;
  var preferHtml = false;

  function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 1;
    return Math.max(0, Math.min(1, n));
  }

  function setAlarmPlaybackVolume(v) {
    alarmVolume = clamp01(v);
  }

  function getAlarmPlaybackVolume() {
    return alarmVolume;
  }

  function builtinSoundOptions() {
    return Object.keys(LABELS).map((id) => ({ id, label: LABELS[id] }));
  }

  function isBuiltinSound(id) {
    return !!(id && LABELS[id]);
  }

  function audioCtx() {
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    if (!global.__gamelleAudioCtx) global.__gamelleAudioCtx = new AC();
    const ctx = global.__gamelleAudioCtx;
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') ctx.resume().catch(() => {});
    return ctx;
  }

  function encodeWav(rate, samples) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buf);
    function str(o, s) { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); }
    str(0, 'RIFF');
    view.setUint32(4, 36 + n * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, 'data');
    view.setUint32(40, n * 2, true);
    const out = new Int16Array(buf, 44);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return buf;
  }

  function toneSamples(rate, freq, durSec, vol, fade) {
    const n = Math.max(1, Math.floor(rate * durSec));
    const out = new Float32Array(n);
    const fadeN = Math.max(1, Math.floor(rate * (fade || 0.02)));
    for (let i = 0; i < n; i++) {
      let amp = vol;
      if (i < fadeN) amp *= i / fadeN;
      if (i > n - fadeN) amp *= (n - i) / fadeN;
      out[i] = Math.sin(2 * Math.PI * freq * i / rate) * amp;
    }
    return out;
  }

  function concatFloat(parts) {
    let len = 0;
    parts.forEach((p) => { len += p.length; });
    const out = new Float32Array(len);
    let o = 0;
    parts.forEach((p) => { out.set(p, o); o += p.length; });
    return out;
  }

  function builtinWav(id) {
    const rate = 22050;
    const vol = Math.max(0.05, 0.45 * alarmVolume);
    if (id === 'chime') {
      const gap = new Float32Array(Math.floor(rate * 0.05));
      return encodeWav(rate, concatFloat([
        toneSamples(rate, 523.25, 0.22, vol, 0.02), gap,
        toneSamples(rate, 659.25, 0.22, vol, 0.02), gap,
        toneSamples(rate, 783.99, 0.45, vol, 0.03),
      ]));
    }
    return encodeWav(rate, toneSamples(rate, 880, 0.32, vol, 0.02));
  }

  function playViaHtml(id) {
    return new Promise((resolve) => {
      try {
        const wav = builtinWav(id === 'chime' ? 'chime' : 'beep');
        const blob = new Blob([wav], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.setAttribute('playsinline', 'true');
        audio.volume = Math.max(0, Math.min(1, alarmVolume));
        const done = () => {
          try { URL.revokeObjectURL(url); } catch (e) {}
          resolve();
        };
        audio.addEventListener('ended', done);
        audio.addEventListener('error', done);
        const p = audio.play();
        if (p && p.then) p.then(() => {}).catch(done);
        // Sécurité durée
        setTimeout(done, id === 'chime' ? 1400 : 500);
      } catch (e) {
        resolve();
      }
    });
  }

  function playBeep(ctx) {
    return new Promise((resolve, reject) => {
      try {
        const t = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const peak = Math.max(0.0001, 0.28 * alarmVolume);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, t);
        osc.frequency.exponentialRampToValueAtTime(660, t + 0.18);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(peak, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.36);
        setTimeout(resolve, 380);
      } catch (e) {
        reject(e);
      }
    });
  }

  function playChime(ctx) {
    return new Promise((resolve, reject) => {
      try {
        const notes = [523.25, 659.25, 783.99];
        const peak = Math.max(0.0001, 0.22 * alarmVolume);
        notes.forEach((freq, i) => {
          const t = ctx.currentTime + i * 0.22;
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(peak, t + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
          osc.connect(g);
          g.connect(ctx.destination);
          osc.start(t);
          osc.stop(t + 0.72);
        });
        setTimeout(resolve, 1100);
      } catch (e) {
        reject(e);
      }
    });
  }

  function playBuiltinSound(id) {
    if (alarmVolume <= 0.001) return Promise.resolve();
    const kind = id === 'chime' ? 'chime' : 'beep';
    // iOS : après le 1er son, WebAudio passe souvent en "interrupted" → plus de son audible
    // alors que la boucle continue. Repli HTML Audio pour les cycles suivants.
    if (preferHtml) return playViaHtml(kind);

    const ctx = audioCtx();
    if (!ctx) return playViaHtml(kind);

    const fn = { beep: playBeep, chime: playChime }[kind] || playBeep;
    return Promise.resolve(ctx.resume())
      .then(() => {
        if (ctx.state !== 'running') throw new Error('ctx-' + ctx.state);
        return fn(ctx);
      })
      .catch(() => {
        preferHtml = true;
        return playViaHtml(kind);
      });
  }

  global.BUILTIN_SOUND_LABELS = LABELS;
  global.builtinSoundOptions = builtinSoundOptions;
  global.isBuiltinSound = isBuiltinSound;
  global.playBuiltinSound = playBuiltinSound;
  global.setAlarmPlaybackVolume = setAlarmPlaybackVolume;
  global.getAlarmPlaybackVolume = getAlarmPlaybackVolume;
})(window);
