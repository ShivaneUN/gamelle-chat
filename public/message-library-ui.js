// Bibliothèque de messages (texte + audio) à assigner aux alarmes.
function createMessageLibrary({ containerId, socket, onChange, onUseForAlarm }) {
  const container = document.getElementById(containerId);
  let messages = [];
  let recording = null; // { messageId, rec, stream, stopTracks, btn }

  function msgSnap(list) {
    return JSON.stringify((list || []).map((m) => ({
      id: m.id, name: m.name || '', text: m.text || '', audioUrl: m.audioUrl || '',
    })));
  }

  function setMessages(newMessages) {
    const next = newMessages || [];
    const unchanged = msgSnap(next) === msgSnap(messages);
    messages = next;
    // Ne pas détruire le bouton Stop pendant un enregistrement (room-state arrive souvent)
    if (!recording && !unchanged) render();
    if (onChange && !unchanged) onChange(messages);
  }

  function notify() {
    if (onChange) onChange(messages);
  }

  function render() {
    container.innerHTML = '';
    if (!messages.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'Ajoute un message, enregistre un audio, puis choisis-le dans Alarme ou Horaires.';
      container.appendChild(empty);
    }
    messages.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'sched-item sched-alarm';

      const name = document.createElement('input');
      name.type = 'text';
      name.placeholder = 'Nom (ex: A table)';
      name.value = m.name || '';
      name.dataset.id = m.id;
      name.dataset.f = 'name';

      const text = document.createElement('input');
      text.type = 'text';
      text.placeholder = 'Texte lu si pas d\'audio';
      text.value = m.text || '';
      text.dataset.id = m.id;
      text.dataset.f = 'text';

      const recBtn = document.createElement('button');
      recBtn.type = 'button';
      recBtn.className = 'ghost audio-rec-btn';
      recBtn.textContent = m.audioUrl ? '🔁 Réenregistrer' : '🎙️ Enregistrer audio';
      recBtn.onclick = () => startRecording(m.id, recBtn);

      row.appendChild(name);
      row.appendChild(text);
      row.appendChild(recBtn);

      if (m.audioUrl) {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'metadata';
        audio.src = m.audioUrl;
        audio.style.width = '100%';
        row.appendChild(audio);

        const useBtn = document.createElement('button');
        useBtn.type = 'button';
        useBtn.textContent = '🔔 Alarme';
        useBtn.onclick = () => {
          socket.emit('assign-alarm-sound', { messageId: m.id });
          if (onUseForAlarm) onUseForAlarm(m.id);
        };
        const actions = document.createElement('div');
        actions.className = 'msg-actions';
        actions.appendChild(useBtn);

        const delAudio = document.createElement('button');
        delAudio.type = 'button';
        delAudio.className = 'danger';
        delAudio.textContent = '✕ audio';
        delAudio.onclick = () => socket.emit('delete-message-audio', { messageId: m.id });
        actions.appendChild(delAudio);
        row.appendChild(actions);
      }

      const delMsg = document.createElement('button');
      delMsg.type = 'button';
      delMsg.className = 'danger';
      delMsg.textContent = '✕';
      delMsg.onclick = () => socket.emit('delete-message', { id: m.id });
      row.appendChild(delMsg);

      container.appendChild(row);
    });

    container.querySelectorAll('input[data-f]').forEach((inp) => {
      inp.onchange = () => {
        const msg = messages.find((x) => x.id === inp.dataset.id);
        if (!msg) return;
        msg[inp.dataset.f] = inp.value;
        socket.emit('save-message', { id: msg.id, name: msg.name, text: msg.text });
        notify();
      };
    });
  }

  function pickMime() {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/aac'];
    if (!window.MediaRecorder) return { mime: '', ext: 'webm' };
    const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    let ext = 'webm';
    if (mime.indexOf('mp4') !== -1 || mime.indexOf('aac') !== -1) ext = 'mp4';
    else if (mime.indexOf('ogg') !== -1) ext = 'ogg';
    return { mime, ext };
  }

  function existingAudioStream() {
    const nodes = document.querySelectorAll('video, audio');
    for (let i = 0; i < nodes.length; i++) {
      const stream = nodes[i].srcObject;
      if (!stream || !stream.getAudioTracks) continue;
      const track = stream.getAudioTracks().find((t) => t.readyState === 'live');
      if (track) return stream;
    }
    return null;
  }

  function pauseOtherMicTracks() {
    const paused = [];
    document.querySelectorAll('video, audio').forEach((el) => {
      const stream = el.srcObject;
      if (!stream || !stream.getAudioTracks) return;
      stream.getAudioTracks().forEach((t) => {
        if (t.enabled) {
          t.enabled = false;
          paused.push(t);
        }
      });
    });
    return () => paused.forEach((t) => { t.enabled = true; });
  }

  function finishRecordingUi(messageId) {
    const existing = messages.find((m) => m.id === messageId);
    if (recording && recording.btn) {
      recording.btn.textContent = existing && existing.audioUrl ? '🔁 Réenregistrer' : '🎙️ Enregistrer audio';
      recording.btn.classList.remove('danger');
      recording.btn.onclick = () => startRecording(messageId, recording.btn);
    }
    recording = null;
  }

  function startRecording(messageId, btn) {
    if (recording) {
      try {
        if (recording.rec && recording.rec.state === 'recording') recording.rec.stop();
      } catch (e) {}
      return;
    }

    if (!window.MediaRecorder) {
      alert('Ce navigateur ne peut pas enregistrer l\'audio. Utilise Chrome.');
      return;
    }
    if (!window.isSecureContext) {
      alert('L\'enregistrement audio exige https:// (URL trycloudflare ou https local).');
      return;
    }

    const live = existingAudioStream();
    const startWith = (stream, stopTracks, restoreMic) => {
      const chunks = [];
      const { mime, ext } = pickMime();
      let rec;
      try {
        rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      } catch (e) {
        rec = new MediaRecorder(stream);
      }

      recording = { messageId, rec, stream, stopTracks, restoreMic, btn };
      const startedAt = Date.now();

      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      rec.onerror = () => {
        if (restoreMic) restoreMic();
        if (stopTracks) stream.getTracks().forEach((t) => t.stop());
        finishRecordingUi(messageId);
        alert('Erreur d\'enregistrement audio');
      };
      rec.onstop = () => {
        if (restoreMic) restoreMic();
        if (stopTracks) stream.getTracks().forEach((t) => t.stop());
        finishRecordingUi(messageId);
        if (!chunks.length) {
          alert('Aucun son capturé. Appuie sur Enregistrer, parle 2 secondes, puis Stop.');
          return;
        }
        const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
        if (blob.size < 200) {
          alert('Enregistrement trop court. Recouche plus longtemps.');
          return;
        }
        btn.textContent = '⏳ Envoi…';
        const reader = new FileReader();
        reader.onloadend = () => {
          const parts = String(reader.result || '').split(',');
          const data = parts[1];
          if (!data) {
            btn.textContent = '🎙️ Enregistrer audio';
            alert('Impossible de lire l\'audio enregistré.');
            return;
          }
          socket.emit('save-message-audio', { messageId, data, ext });
        };
        reader.readAsDataURL(blob);
      };

      try {
        rec.start(250);
      } catch (e) {
        rec.start();
      }
      btn.textContent = '⏺️ Stop';
      btn.classList.add('danger');
      btn.onclick = () => {
        if (!recording || recording.rec !== rec) return;
        if (Date.now() - startedAt < 600) return;
        if (rec.state === 'recording') {
          try { rec.requestData(); } catch (e) {}
          rec.stop();
        }
      };
      setTimeout(() => {
        if (recording && recording.rec === rec && rec.state === 'recording') rec.stop();
      }, 15000);
    };

    const openMic = () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('Micro indisponible: cette page doit être en https://');
        return;
      }
      const restoreMic = pauseOtherMicTracks();
      navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then((stream) => {
        startWith(stream, true, restoreMic);
      }).catch((e) => {
        restoreMic();
        let tip = e.name + ' — ' + e.message;
        if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
          tip += '\n\nClique le 🔒 à gauche de l\'adresse → Micro → Autoriser, puis recharge.';
        } else if (e.name === 'NotFoundError') {
          tip += '\n\nAucun micro détecté.';
        } else if (e.name === 'NotReadableError' || e.name === 'AbortError') {
          tip += '\n\nLe micro est déjà pris (caméra ou autre appli). Coupe la caméra, puis réessaie.';
        }
        alert('Micro indisponible: ' + tip);
      });
    };

    if (live) {
      try {
        const track = live.getAudioTracks().find((t) => t.readyState === 'live');
        const recStream = new MediaStream([track.clone ? track.clone() : track]);
        startWith(recStream, recStream.getTracks()[0] !== track, null);
        return;
      } catch (e) {
        openMic();
        return;
      }
    }
    openMic();
  }

  socket.on('audio-saved', (payload) => {
    const id = payload && payload.id;
    if (id && onUseForAlarm) {
      try { onUseForAlarm(id); } catch (e) {}
    }
    if (!recording) render();
  });
  socket.on('audio-save-error', ({ error }) => {
    alert('Audio non enregistré: ' + (error || 'erreur inconnue'));
    if (!recording) render();
  });

  function addMessage() {
    const id = 'm' + Date.now();
    const msg = { id, name: 'Nouveau message', text: '', audioUrl: null };
    messages.push(msg);
    render();
    socket.emit('save-message', { id, name: msg.name, text: msg.text });
    notify();
  }

  function getMessages() { return messages; }

  return { setMessages, addMessage, getMessages };
}
