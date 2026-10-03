// Sons intégrés (bip, carillon).
// iOS Safari : garder un AudioContext "vivant" + BufferSource (les .play() HTML
// après le geste utilisateur sont souvent bloqués → 1 seul son audible).
(function (global) {
  const LABELS = {
    beep: '🔔 Bip',
    chime: '✨ Carillon',
  };
  var alarmVolume = 1;
  var keepAlive = null;
  var buffers = null;
  var htmlEl = null;
  var htmlUrl = null;
  var primed = false;

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
    if (!global.__gamelleAudioCtx) {
      try {
        global.__gamelleAudioCtx = new AC({ sampleRate: 48000 });
      } catch (e) {
        global.__gamelleAudioCtx = new AC();
      }
    }
    const ctx = global.__gamelleAudioCtx;
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  function toneSamples(rate, freq, durSec, vol, fade) {
    const n = Math.max(1, Math.floor(rate * durSec));
    const out = new Float32Array(n);
    const fadeN = Math.max(1, Math.floor(rate * (fade || 0.02)));
    for (let i = 0; i < n; i++) {
      let amp = vol;
      if (i < fadeN) amp *= i / fadeN;
      if (i > n - fadeN) amp *= (n - i) / fadeN;
      out[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amp;
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

  function buildFloat(id, rate) {
    const vol = 0.55;
    if (id === 'chime') {
      const gap = new Float32Array(Math.floor(rate * 0.05));
      return concatFloat([
        toneSamples(rate, 523.25, 0.22, vol, 0.02), gap,
        toneSamples(rate, 659.25, 0.22, vol, 0.02), gap,
        toneSamples(rate, 783.99, 0.45, vol, 0.03),
      ]);
    }
    return toneSamples(rate, 880, 0.32, vol, 0.02);
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

  function ensureBuffers(ctx) {
    if (buffers && buffers.ctx === ctx) return buffers;
    const rate = ctx.sampleRate || 48000;
    function toBuf(floatSamples) {
      const b = ctx.createBuffer(1, floatSamples.length, rate);
      b.getChannelData(0).set(floatSamples);
      return b;
    }
    buffers = {
      ctx,
      beep: toBuf(buildFloat('beep', rate)),
      chime: toBuf(buildFloat('chime', rate)),
    };
    return buffers;
  }

  /** À appeler pendant un geste utilisateur (Déclencher) — indispensable iOS. */
  function startAlarmAudioKeepAlive() {
    const ctx = audioCtx();
    if (!ctx) {
      unlockHtmlSilent();
      return Promise.resolve();
    }
    return ctx.resume().then(() => {
      ensureBuffers(ctx);
      if (!keepAlive) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        g.gain.value = 0.00008;
        osc.frequency.value = 40;
        osc.connect(g);
        g.connect(ctx.destination);
        try { osc.start(); } catch (e) {}
        keepAlive = { osc, g, ctx };
      }
      unlockHtmlSilent();
      primed = true;
    }).catch(() => {
      unlockHtmlSilent();
      primed = true;
    });
  }

  function stopAlarmAudioKeepAlive() {
    if (!keepAlive) return;
    try { keepAlive.osc.stop(); } catch (e) {}
    try { keepAlive.osc.disconnect(); } catch (e) {}
    try { keepAlive.g.disconnect(); } catch (e) {}
    keepAlive = null;
  }

  function unlockHtmlSilent() {
    try {
      if (!htmlEl) {
        htmlEl = new Audio();
        htmlEl.setAttribute('playsinline', 'true');
        htmlEl.preload = 'auto';
      }
      // WAV silencieux très court pour "débloquer" l'élément pendant le geste.
      const silent = encodeWav(22050, new Float32Array(220));
      if (htmlUrl) { try { URL.revokeObjectURL(htmlUrl); } catch (e) {} }
      htmlUrl = URL.createObjectURL(new Blob([silent], { type: 'audio/wav' }));
      htmlEl.volume = 0.01;
      htmlEl.src = htmlUrl;
      const p = htmlEl.play();
      if (p && p.then) p.then(() => { try { htmlEl.pause(); } catch (e) {} }).catch(() => {});
    } catch (e) {}
  }

  function playBuffer(ctx, id) {
    const kind = id === 'chime' ? 'chime' : 'beep';
    const pack = ensureBuffers(ctx);
    const buf = pack[kind] || pack.beep;
    return new Promise((resolve, reject) => {
      try {
        if (ctx.state !== 'running') {
          reject(new Error('ctx-' + ctx.state));
          return;
        }
        const src = ctx.createBufferSource();
        const g = ctx.createGain();
        g.gain.value = Math.max(0.0001, alarmVolume);
        src.buffer = buf;
        src.connect(g);
        g.connect(ctx.destination);
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        src.onended = finish;
        src.start();
        setTimeout(finish, Math.ceil(buf.duration * 1000) + 80);
      } catch (e) {
        reject(e);
      }
    });
  }

  function playViaHtml(id) {
    return new Promise((resolve) => {
      try {
        const kind = id === 'chime' ? 'chime' : 'beep';
        const wav = encodeWav(22050, buildFloat(kind, 22050));
        if (htmlUrl) { try { URL.revokeObjectURL(htmlUrl); } catch (e) {} }
        htmlUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
        if (!htmlEl) {
          htmlEl = new Audio();
          htmlEl.setAttribute('playsinline', 'true');
        }
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        htmlEl.onended = done;
        htmlEl.onerror = done;
        htmlEl.volume = Math.max(0, Math.min(1, alarmVolume));
        htmlEl.src = htmlUrl;
        const p = htmlEl.play();
        if (p && p.then) p.then(() => {}).catch(done);
        setTimeout(done, kind === 'chime' ? 1400 : 500);
      } catch (e) {
        resolve();
      }
    });
  }

  function playBuiltinSound(id) {
    if (alarmVolume <= 0.001) return Promise.resolve();
    const kind = id === 'chime' ? 'chime' : 'beep';
    const ctx = audioCtx();
    if (ctx) {
      // Ne pas abandonner WebAudio : keep-alive + buffers = seule voie fiable en boucle iOS.
      const run = () => playBuffer(ctx, kind).catch(() => playViaHtml(kind));
      if (ctx.state === 'running') return run();
      return ctx.resume().then(run).catch(() => playViaHtml(kind));
    }
    return playViaHtml(kind);
  }

  global.BUILTIN_SOUND_LABELS = LABELS;
  global.builtinSoundOptions = builtinSoundOptions;
  global.isBuiltinSound = isBuiltinSound;
  global.playBuiltinSound = playBuiltinSound;
  global.setAlarmPlaybackVolume = setAlarmPlaybackVolume;
  global.getAlarmPlaybackVolume = getAlarmPlaybackVolume;
  global.startAlarmAudioKeepAlive = startAlarmAudioKeepAlive;
  global.stopAlarmAudioKeepAlive = stopAlarmAudioKeepAlive;
})(window);
