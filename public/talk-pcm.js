// Capture / lecture PCM pour la voix live (iPhone + Android WebView).
(function (global) {
  var TARGET_RATE = 16000;
  var SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

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
      try {
        global.__gamelleAudioCtx = new AC({ sampleRate: 48000 });
      } catch (e) {
        global.__gamelleAudioCtx = new AC();
      }
    }
    const ctx = global.__gamelleAudioCtx;
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') ctx.resume().catch(() => {});
    return ctx;
  }

  function unlockTalkAudio() {
    const ctx = sharedAudioCtx();
    if (!global.__gamelleAudioUnlocked) {
      global.__gamelleAudioUnlocked = true;
      try {
        const a = new Audio(SILENT_WAV);
        a.setAttribute('playsinline', 'true');
        a.volume = 0.01;
        const p = a.play();
        if (p && p.then) p.then(() => { if (ctx) ctx.resume().catch(() => {}); }).catch(() => {});
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

  async function startTalkCapture(stream, onPcm) {
    const ctx = unlockTalkAudio();
    if (!ctx || !stream) return null;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    const source = ctx.createMediaStreamSource(stream);
    let node = null;
    let mute = null;
    let mode = 'worklet';

    const emit = (floatSamples) => {
      const down = downsampleFloat(floatSamples, ctx.sampleRate, TARGET_RATE);
      const pcm = pcmFromFloat(down);
      onPcm({ rate: TARGET_RATE, samples: pcm });
    };

    try {
      if (!ctx.audioWorklet) throw new Error('no worklet');
      try {
        await ctx.audioWorklet.addModule('/talk-capture-worklet.js?v=2');
      } catch (e) {}
      node = new AudioWorkletNode(ctx, 'talk-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
      });
      node.port.onmessage = (e) => {
        const samples = e.data;
        if (!samples || !samples.length) return;
        emit(samples);
      };
      source.connect(node);
      mute = connectKeepAlive(ctx, node);
    } catch (e) {
      mode = 'script';
      node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (ev) => {
        emit(ev.inputBuffer.getChannelData(0));
      };
      source.connect(node);
      mute = connectKeepAlive(ctx, node);
    }

    return { ctx, source, node, mute, mode };
  }

  function stopTalkCapture(cap) {
    if (!cap) return;
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
      audio.volume = 1;
      const done = () => { try { URL.revokeObjectURL(url); } catch (e) {} };
      audio.addEventListener('ended', done);
      audio.addEventListener('error', done);
      const p = audio.play();
      if (p && p.catch) p.catch(done);
    } catch (e) {}
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
    const int16 = toInt16(samples);
    if (!int16 || !int16.length) return;
    const ctx = unlockTalkAudio();
    state.ctx = ctx;
    const srcRate = rate || TARGET_RATE;

    const playCtx = () => {
      if (!ctx || ctx.state === 'suspended' || ctx.state === 'interrupted') {
        playViaHtmlAudio(srcRate, int16);
        return;
      }
      const ready = resampleInt16(int16, srcRate, ctx.sampleRate);
      const float32 = new Float32Array(ready.length);
      for (let i = 0; i < ready.length; i++) float32[i] = ready[i] / 0x8000;
      let buf;
      try {
        buf = ctx.createBuffer(1, float32.length, ctx.sampleRate);
      } catch (e) {
        playViaHtmlAudio(srcRate, int16);
        return;
      }
      buf.getChannelData(0).set(float32);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (!state.gain) {
        state.gain = ctx.createGain();
        state.gain.gain.value = 1.25;
        state.gain.connect(ctx.destination);
      }
      src.connect(state.gain);
      const now = ctx.currentTime;
      if (!state.nextTime || state.nextTime < now + 0.02) state.nextTime = now + 0.02;
      if (state.nextTime > now + 0.6) state.nextTime = now + 0.02;
      try {
        src.start(state.nextTime);
        state.nextTime += buf.duration;
      } catch (e) {
        playViaHtmlAudio(srcRate, int16);
      }
    };

    if (!ctx || ctx.state === 'suspended' || ctx.state === 'interrupted') {
      if (ctx) ctx.resume().then(playCtx).catch(() => playViaHtmlAudio(srcRate, int16));
      else playViaHtmlAudio(srcRate, int16);
      return;
    }
    playCtx();
  }

  global.sharedAudioCtx = sharedAudioCtx;
  global.unlockTalkAudio = unlockTalkAudio;
  global.startTalkCapture = startTalkCapture;
  global.stopTalkCapture = stopTalkCapture;
  global.playTalkPcm = playTalkPcm;
})(window);
