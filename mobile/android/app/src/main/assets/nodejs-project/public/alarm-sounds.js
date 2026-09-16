// Sons intégrés (bip, carillon) — Web Audio.
(function (global) {
  const LABELS = {
    beep: '🔔 Bip',
    chime: '✨ Carillon',
  };

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

  function playBeep(ctx) {
    return new Promise((resolve) => {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.exponentialRampToValueAtTime(660, t + 0.18);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.28, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.36);
      setTimeout(resolve, 380);
    });
  }

  function playChime(ctx) {
    return new Promise((resolve) => {
      const notes = [523.25, 659.25, 783.99];
      notes.forEach((freq, i) => {
        const t = ctx.currentTime + i * 0.22;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.72);
      });
      setTimeout(resolve, 1100);
    });
  }

  function playBuiltinSound(id) {
    const ctx = audioCtx();
    if (!ctx) return Promise.resolve();
    const fn = { beep: playBeep, chime: playChime }[id] || playBeep;
    return ctx.resume().then(() => fn(ctx)).catch(() => {});
  }

  global.BUILTIN_SOUND_LABELS = LABELS;
  global.builtinSoundOptions = builtinSoundOptions;
  global.isBuiltinSound = isBuiltinSound;
  global.playBuiltinSound = playBuiltinSound;
})(window);
