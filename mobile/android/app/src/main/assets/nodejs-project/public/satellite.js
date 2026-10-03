const params = new URLSearchParams(location.search);
const linkKey = params.get('k') || '';
const socket = io();
const stateEl = document.getElementById('satState');
const codeEl = document.getElementById('guestCode');
const video = document.getElementById('localVideo');
const camBtn = document.getElementById('camBtn');
let camOn = false;
let stream = null;
let facing = 'environment';

function setState(text) {
  if (stateEl) stateEl.textContent = text;
}

socket.on('connect', () => {
  socket.emit('satellite-hello', { k: linkKey });
});
socket.on('satellite-wait', (payload) => {
  if (payload && payload.error) {
    setState(payload.error);
    return;
  }
  if (payload && payload.guest && codeEl) codeEl.textContent = payload.guest;
  setState('En attente de la tablette');
});
socket.on('satellite-ok', () => {
  setState('Jumelée — Caméra 2');
});
socket.on('disconnect', () => setState('Déconnectée'));

async function startCam() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing },
    audio: false,
  });
  video.srcObject = stream;
  camOn = true;
  pump();
}
camBtn.onclick = () => {
  if (camOn && stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    camOn = false;
    return;
  }
  startCam().catch((e) => alert(e.message || e));
};

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');
function pump() {
  if (!camOn || !stream) return;
  const w = 320;
  const srcW = video.videoWidth || 320;
  const srcH = video.videoHeight || 240;
  const h = Math.max(1, Math.round(srcH * (w / srcW)));
  canvas.width = w;
  canvas.height = h;
  try { ctx.drawImage(video, 0, 0, w, h); } catch (e) {}
  const jpeg = canvas.toDataURL('image/jpeg', 0.45).split(',')[1];
  if (jpeg) socket.emit('live-frame', jpeg);
  setTimeout(pump, 120);
}

socket.on('torch', async (payload) => {
  const track = stream && stream.getVideoTracks()[0];
  if (!track || !track.applyConstraints) return;
  try { await track.applyConstraints({ advanced: [{ torch: !!(payload && payload.on) }] }); } catch (e) {}
});
socket.on('switch-camera', () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  if (camOn) startCam().catch(() => {});
});
socket.on('screen-off', () => {
  try { if (window.GamelleHost) GamelleHost.postMessage('off'); } catch (e) {}
});
socket.on('screen-on', () => {
  try { if (window.GamelleHost) GamelleHost.postMessage('on'); } catch (e) {}
});
socket.on('take-photo', () => {
  if (!camOn || !stream || !video.videoWidth) return;
  const shot = document.createElement('canvas');
  shot.width = video.videoWidth;
  shot.height = video.videoHeight;
  shot.getContext('2d').drawImage(video, 0, 0);
  const data = shot.toDataURL('image/jpeg', 0.85).split(',')[1];
  socket.emit('media-captured', { type: 'photo', data: data, ext: 'jpg' });
});
let satRecorder = null;
let satChunks = [];
socket.on('start-video', () => {
  if (!camOn || !stream || satRecorder) return;
  satChunks = [];
  try {
    satRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
  } catch (e) {
    satRecorder = new MediaRecorder(stream);
  }
  satRecorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) satChunks.push(ev.data); };
  satRecorder.onstop = () => {
    const blob = new Blob(satChunks, { type: 'video/webm' });
    const reader = new FileReader();
    reader.onloadend = () => {
      const raw = String(reader.result || '');
      const data = raw.indexOf(',') >= 0 ? raw.split(',')[1] : '';
      if (data) socket.emit('media-captured', { type: 'video', data: data, ext: 'webm' });
    };
    reader.readAsDataURL(blob);
    satRecorder = null;
  };
  satRecorder.start();
});
socket.on('stop-video', () => {
  if (satRecorder && satRecorder.state !== 'inactive') satRecorder.stop();
});
const talkState = { nextTime: 0 };
socket.on('talk-audio', ({ rate, samples }) => {
  if (typeof playTalkPcm === 'function') playTalkPcm(talkState, rate, samples);
});
