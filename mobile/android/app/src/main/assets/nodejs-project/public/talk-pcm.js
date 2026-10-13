// Capture / lecture PCM pour la voix live (iPhone + Android WebView).
(function (global) {
  var TARGET_RATE = 16000;
  var SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
  var playbackVolume = 1;
  var talkGainBoost = 1.25;
  var micCaptureCount = 0;
  // Référence de ce qui vient de sortir du haut-parleur (16 kHz).
  // Sert à retirer l'écho : le micro (ici ou en face) reprend ce son et le renvoie.
  var echoRef = null;

  function echoState() {
    if (echoRef) return echoRef;
    var n = TARGET_RATE * 12 / 10;
    echoRef = {
      n: n,
      buf: new Float32Array(n),
      w: 0,
      filled: 0,
      lastLagIn: 0,
      lastLagMic: 0,
    };
    return echoRef;
  }

  function resetEchoState() {
    echoRef = null;
  }

  function pushEchoRef(int16) {
    if (!int16 || !int16.length) return;
    var st = echoState();
    var buf = st.buf;
    var w = st.w;
    var n = st.n;
    for (var i = 0; i < int16.length; i++) {
      buf[w] = int16[i] / 32768;
      w++;
      if (w >= n) w = 0;
    }
    st.w = w;
    st.filled = Math.min(n, st.filled + int16.length);
  }

  function sampleAgo(st, ago) {
    var i = st.w - ago;
    var n = st.n;
    i %= n;
    if (i < 0) i += n;
    return st.buf[i];
  }

  function toFloatBlock(int16) {
    var x = new Float32Array(int16.length);
    var energy = 0;
    for (var i = 0; i < int16.length; i++) {
      var v = int16[i] / 32768;
      x[i] = v;
      energy += v * v;
    }
    return { x: x, energy: energy };
  }

  function scoreLag(st, x, lag, stride) {
    var n = x.length;
    var dot = 0;
    var yE = 0;
    var xE = 0;
    var base = lag + n - 1;
    for (var i = 0; i < n; i += stride) {
      var y = sampleAgo(st, base - i);
      var xv = x[i];
      dot += xv * y;
      yE += y * y;
      xE += xv * xv;
    }
    var ncc = yE > 1e-8 && xE > 1e-8 ? dot / Math.sqrt(yE * xE) : 0;
    return { ncc: ncc, dot: dot, yE: yE };
  }

  function extractNewest(count) {
    var st = echoState();
    var n = Math.min(count, st.filled);
    var out = new Float32Array(n);
    var w = st.w;
    var buf = st.buf;
    var N = st.n;
    for (var k = 0; k < n; k++) {
      var i = w - n + k;
      i %= N;
      if (i < 0) i += N;
      out[k] = buf[i];
    }
    return out;
  }

  function movingAvg(src, win) {
    var out = new Float32Array(src.length);
    var acc = 0;
    for (var i = 0; i < src.length; i++) {
      acc += src[i];
      if (i >= win) acc -= src[i - win];
      out[i] = acc;
    }
    return out;
  }

  function refineLag(st, x, center, radius, minLag, maxLag) {
    var best = { ncc: -1, lag: center };
    var from = Math.max(minLag, center - radius);
    var to = Math.min(maxLag, center + radius);
    for (var lag = from; lag <= to; lag++) {
      var s = scoreLag(st, x, lag, 1);
      if (s.ncc > best.ncc) best = { ncc: s.ncc, lag: lag };
    }
    return best;
  }

  function findEchoLag(x, minLag, maxLag, hint) {
    var st = echoState();
    if (hint >= minLag && hint <= maxLag) {
      var near = refineLag(st, x, hint, 8, minLag, maxLag);
      if (near.ncc >= 0.5) return near;
    }
    var need = Math.min(st.filled, maxLag + x.length);
    var hist = extractNewest(need);
    var H = hist.length;
    var hf = movingAvg(hist, 8);
    var xf = movingAvg(x, 8);
    var best = { ncc: 0, lag: minLag };
    var step = 8;
    for (var lag = minLag; lag <= maxLag; lag += step) {
      var dot = 0;
      var yE = 0;
      var xE = 0;
      var valid = true;
      for (var i = 0; i < xf.length; i += 8) {
        var idx = H - (lag + x.length - 1 - i);
        if (idx < 0 || idx >= H) { valid = false; break; }
        var y = hf[idx];
        var xv = xf[i];
        dot += xv * y;
        yE += y * y;
        xE += xv * xv;
      }
      if (!valid || yE < 1e-8 || xE < 1e-8) continue;
      var ncc = dot / Math.sqrt(yE * xE);
      if (ncc > best.ncc) best = { ncc: ncc, lag: lag };
    }
    if (best.ncc < 0.2) return best;
    return refineLag(st, x, best.lag, step, minLag, maxLag);
  }

  function echoPeakIsSharp(x, lag, peak, minLag, maxLag) {
    var st = echoState();
    var offsets = [480, 800, -480];
    var checks = 0;
    var worse = 0;
    for (var k = 0; k < offsets.length; k++) {
      var l = lag + offsets[k];
      if (l < minLag || l > maxLag || Math.abs(l - lag) < 80) continue;
      checks++;
      var s = scoreLag(st, x, l, 8);
      if (peak > s.ncc + 0.1) worse++;
    }
    return checks > 0 && worse >= checks;
  }

  function cleanIncomingEcho(int16) {
    var st = echoState();
    if (!int16 || int16.length < 80) return int16;
    if (st.filled < TARGET_RATE * 0.12) return int16;
    var block = toFloatBlock(int16);
    if (block.energy < 1e-5) return int16;
    // Le retard mesuré est plus court que le trajet réel : le bloc dure déjà ~80 ms.
    var minLag = 0;
    var maxLag = Math.min(st.filled - int16.length, Math.round(1.05 * TARGET_RATE));
    if (maxLag <= minLag + 32) return int16;
    var found = findEchoLag(block.x, minLag, maxLag, st.lastLagIn);
    if (!found || found.ncc < 0.42) return int16;
    if (!echoPeakIsSharp(block.x, found.lag, found.ncc, minLag, maxLag)) {
      st.lastLagIn = 0;
      return int16;
    }
    var full = scoreLag(st, block.x, found.lag, 1);
    if (full.yE < 1e-8 || full.ncc < 0.4) return int16;
    var g = full.dot / full.yE;
    if (g < 0.08) return int16;
    if (g > 1.6) g = 1.6;
    var out = new Int16Array(int16.length);
    var base = found.lag + int16.length - 1;
    var residual = 0;
    var howl = found.ncc > 0.8 ? 0.35 : 1;
    for (var i = 0; i < int16.length; i++) {
      var y = sampleAgo(st, base - i);
      var v = (block.x[i] - g * y) * howl;
      residual += v * v;
      var s = Math.round(v * 32767);
      if (s > 32767) s = 32767;
      else if (s < -32768) s = -32768;
      out[i] = s;
    }
    if (residual > block.energy * 0.98) return int16;
    st.lastLagIn = found.lag;
    return out;
  }

  function cleanMicEcho(int16) {
    var st = echoState();
    if (!int16 || int16.length < 80) return int16;
    if (st.filled < TARGET_RATE * 0.05) return int16;
    var block = toFloatBlock(int16);
    if (block.energy < 1e-5) return int16;
    var minLag = 0;
    var maxLag = Math.min(st.filled - 1, Math.round(0.3 * TARGET_RATE));
    if (maxLag <= 16) return int16;
    var found = findEchoLag(block.x, minLag, maxLag, st.lastLagMic);
    if (!found || found.ncc < 0.5) return int16;
    if (!echoPeakIsSharp(block.x, found.lag, found.ncc, minLag, maxLag)) {
      st.lastLagMic = 0;
      return int16;
    }
    st.lastLagMic = found.lag;
    var t = (found.ncc - 0.5) / 0.4;
    if (t > 1) t = 1;
    if (t < 0) t = 0;
    var gain = 1 - t * 0.92;
    if (found.ncc > 0.78) gain = Math.min(gain, 0.08);
    var out = new Int16Array(int16.length);
    for (var i = 0; i < int16.length; i++) out[i] = (int16[i] * gain) | 0;
    return out;
  }

  function applyAudioSession() {
    try {
      if (!navigator.audioSession) return;
      // playback = haut-parleur, sans micro. play-and-record = micro iPhone autorisé.
      navigator.audioSession.type = micCaptureCount > 0 ? 'play-and-record' : 'playback';
    } catch (e) {}
  }

  function setMicCaptureSession(on) {
    micCaptureCount += on ? 1 : -1;
    if (micCaptureCount < 0) micCaptureCount = 0;
    applyAudioSession();
  }

  function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 1;
    return Math.max(0, Math.min(1, n));
  }

  function applyTalkGain() {
    try {
      if (global.__gamelleTalkGain) {
        global.__gamelleTalkGain.gain.value = Math.max(0.0001, playbackVolume * talkGainBoost);
      }
    } catch (e) {}
  }

  function setTalkPlaybackVolume(v) {
    playbackVolume = clamp01(v);
    applyTalkGain();
  }

  function setTalkGainBoost(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    talkGainBoost = Math.max(0.2, Math.min(4, n));
    applyTalkGain();
  }

  function getTalkPlaybackVolume() {
    return playbackVolume;
  }

  function pcmFromFloat(samples) {
    const buf = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return buf;
  }

  function toInt16(samples) {
    if (!samples) return null;
    if (samples instanceof Int16Array) return samples;
    if (samples instanceof ArrayBuffer) return new Int16Array(samples);
    if (ArrayBuffer.isView(samples)) {
      return new Int16Array(samples.buffer, samples.byteOffset, Math.floor(samples.byteLength / 2));
    }
    if (samples.type === 'Buffer' && samples.data) return Int16Array.from(samples.data);
    if (Array.isArray(samples) || typeof samples.length === 'number') return Int16Array.from(samples);
    return null;
  }

  function resampleInt16(src, fromRate, toRate) {
    if (!src || !src.length) return src;
    if (!fromRate || !toRate || fromRate === toRate) return src;
    const ratio = fromRate / toRate;
    const n = Math.max(1, Math.round(src.length / ratio));
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const x = i * ratio;
      const i0 = Math.min(src.length - 1, Math.floor(x));
      const i1 = Math.min(src.length - 1, i0 + 1);
      const t = x - i0;
      out[i] = (src[i0] * (1 - t) + src[i1] * t) | 0;
    }
    return out;
  }

  function downsampleFloat(samples, fromRate, toRate) {
    if (!fromRate || fromRate === toRate) return samples;
    const ratio = fromRate / toRate;
    const n = Math.max(1, Math.floor(samples.length / ratio));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = samples[Math.min(samples.length - 1, Math.floor(i * ratio))];
    return out;
  }

  function sharedAudioCtx() {
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    if (!global.__gamelleAudioCtx) {
      // Pas de sampleRate forcé : sur WebView Android ça rend le micro muet.
      global.__gamelleAudioCtx = new AC();
    }
    const ctx = global.__gamelleAudioCtx;
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') ctx.resume().catch(() => {});
    return ctx;
  }

  function unlockTalkAudio() {
    applyAudioSession();
    const ctx = sharedAudioCtx();
    if (!global.__gamelleAudioUnlocked) {
      try {
        const a = new Audio(SILENT_WAV);
        a.setAttribute('playsinline', 'true');
        a.volume = 0.01;
        const p = a.play();
        if (p && p.then) {
          p.then(() => {
            global.__gamelleAudioUnlocked = true;
            if (ctx) ctx.resume().catch(() => {});
          }).catch(() => {});
        } else {
          global.__gamelleAudioUnlocked = true;
        }
      } catch (e) {}
    }
    if (ctx) ctx.resume().catch(() => {});
    return ctx;
  }

  function connectKeepAlive(ctx, node) {
    const mute = ctx.createGain();
    mute.gain.value = 0.0008;
    node.connect(mute);
    mute.connect(ctx.destination);
    return mute;
  }

  function isAndroidWebView() {
    const ua = (global.navigator && global.navigator.userAgent) || '';
    return /Android/i.test(ua) && /; wv\)/i.test(ua);
  }

  function startScriptCapture(ctx, source, emit) {
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (ev) => {
      emit(ev.inputBuffer.getChannelData(0));
    };
    source.connect(node);
    const mute = connectKeepAlive(ctx, node);
    return { node, mute, mode: 'script' };
  }

  async function startTalkCapture(stream, onPcm) {
    const ctx = unlockTalkAudio();
    if (!ctx || !stream) return null;
    try { await ctx.resume(); } catch (e) {}

    const source = ctx.createMediaStreamSource(stream);
    const emit = (floatSamples) => {
      if (!floatSamples || !floatSamples.length) return;
      const down = downsampleFloat(floatSamples, ctx.sampleRate, TARGET_RATE);
      const pcm = cleanMicEcho(pcmFromFloat(down));
      onPcm({ rate: TARGET_RATE, samples: pcm });
    };

    // WebView Android : AudioWorklet reste souvent silencieux. ScriptProcessor marche.
    if (isAndroidWebView() || !ctx.audioWorklet) {
      const cap = startScriptCapture(ctx, source, emit);
      return { ctx, source, node: cap.node, mute: cap.mute, mode: cap.mode };
    }

    let node = null;
    let mute = null;
    let mode = 'worklet';
    let frames = 0;
    try {
      await ctx.audioWorklet.addModule('/talk-capture-worklet.js?v=3');
      node = new AudioWorkletNode(ctx, 'talk-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      node.port.onmessage = (e) => {
        const samples = e.data;
        if (!samples || !samples.length) return;
        frames++;
        emit(samples);
      };
      source.connect(node);
      mute = connectKeepAlive(ctx, node);
    } catch (e) {
      const cap = startScriptCapture(ctx, source, emit);
      return { ctx, source, node: cap.node, mute: cap.mute, mode: cap.mode };
    }

    // Si le worklet n'émet rien, bascule vers ScriptProcessor.
    const watchdog = setTimeout(() => {
      if (frames > 0) return;
      try { if (node) node.disconnect(); } catch (err) {}
      try { if (mute) mute.disconnect(); } catch (err) {}
      try { source.disconnect(); } catch (err) {}
      const cap = startScriptCapture(ctx, source, emit);
      node = cap.node;
      mute = cap.mute;
      mode = cap.mode;
    }, 900);

    return {
      ctx,
      source,
      get node() { return node; },
      get mute() { return mute; },
      get mode() { return mode; },
      watchdog,
    };
  }

  function stopTalkCapture(cap) {
    if (!cap) return;
    try { if (cap.watchdog) clearTimeout(cap.watchdog); } catch (e) {}
    try { if (cap.node) cap.node.disconnect(); } catch (e) {}
    try { if (cap.source) cap.source.disconnect(); } catch (e) {}
    try { if (cap.mute) cap.mute.disconnect(); } catch (e) {}
  }

  function playViaHtmlAudio(rate, int16) {
    try {
      const wav = encodeWav(rate || TARGET_RATE, int16);
      const blob = new Blob([wav], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.setAttribute('playsinline', 'true');
      audio.volume = playbackVolume;
      const done = () => { try { URL.revokeObjectURL(url); } catch (e) {} };
      audio.addEventListener('ended', done);
      audio.addEventListener('error', done);
      const p = audio.play();
      if (p && p.catch) p.catch(done);
      return true;
    } catch (e) {
      return false;
    }
  }

  function encodeWav(rate, int16) {
    const bytes = int16.length * 2;
    const buf = new ArrayBuffer(44 + bytes);
    const view = new DataView(buf);
    function str(offset, s) {
      for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    }
    str(0, 'RIFF');
    view.setUint32(4, 36 + bytes, true);
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
    view.setUint32(40, bytes, true);
    new Int16Array(buf, 44).set(int16);
    return buf;
  }

  function playTalkPcm(state, rate, samples) {
    const int16in = toInt16(samples);
    if (!int16in || !int16in.length) return false;
    if (playbackVolume <= 0.001) return false;
    const srcRateIn = rate || TARGET_RATE;
    const at16 = srcRateIn === TARGET_RATE ? int16in : resampleInt16(int16in, srcRateIn, TARGET_RATE);
    const int16 = cleanIncomingEcho(at16);
    pushEchoRef(int16);
    const ctx = unlockTalkAudio();
    state.ctx = ctx;
    const srcRate = TARGET_RATE;
    let started = false;

    const playCtx = () => {
      if (!ctx || ctx.state === 'suspended' || ctx.state === 'interrupted') {
        started = playViaHtmlAudio(srcRate, int16);
        return;
      }
      const ready = resampleInt16(int16, srcRate, ctx.sampleRate);
      const float32 = new Float32Array(ready.length);
      for (let i = 0; i < ready.length; i++) float32[i] = ready[i] / 0x8000;
      let buf;
      try {
        buf = ctx.createBuffer(1, float32.length, ctx.sampleRate);
      } catch (e) {
        started = playViaHtmlAudio(srcRate, int16);
        return;
      }
      buf.getChannelData(0).set(float32);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (!state.gain) {
        state.gain = ctx.createGain();
        state.gain.connect(ctx.destination);
      }
      global.__gamelleTalkGain = state.gain;
      state.gain.gain.value = Math.max(0.0001, playbackVolume * talkGainBoost);
      src.connect(state.gain);
      const now = ctx.currentTime;
      if (!state.nextTime || state.nextTime < now + 0.02) state.nextTime = now + 0.02;
      if (state.nextTime > now + 0.6) state.nextTime = now + 0.02;
      try {
        src.start(state.nextTime);
        state.nextTime += buf.duration;
        started = true;
      } catch (e) {
        started = playViaHtmlAudio(srcRate, int16);
      }
    };

    if (!ctx || ctx.state === 'suspended' || ctx.state === 'interrupted') {
      if (ctx) {
        ctx.resume().then(playCtx).catch(() => { playViaHtmlAudio(srcRate, int16); });
        return true;
      }
      return playViaHtmlAudio(srcRate, int16);
    }
    playCtx();
    return started;
  }

  global.sharedAudioCtx = sharedAudioCtx;
  global.unlockTalkAudio = unlockTalkAudio;
  global.setMicCaptureSession = setMicCaptureSession;
  global.startTalkCapture = startTalkCapture;
  global.stopTalkCapture = stopTalkCapture;
  global.playTalkPcm = playTalkPcm;
  global.setTalkGainBoost = setTalkGainBoost;
  global.setTalkPlaybackVolume = setTalkPlaybackVolume;
  global.getTalkPlaybackVolume = getTalkPlaybackVolume;
  global.__gamelleEcho = {
    reset: resetEchoState,
    push: pushEchoRef,
    cleanIncoming: cleanIncomingEcho,
    cleanMic: cleanMicEcho,
  };
})(window);
