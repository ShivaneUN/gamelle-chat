// Composant partagé entre controller.js et receiver.js pour la gestion des horaires.
// Chaque horaire référence un message de la bibliothèque (texte et/ou audio) via messageId.
function soundLabel(m) {
  if (!m) return '🔔 Bip par défaut';
  if (m.audioUrl && (m.name || m.text)) return '🔊 ' + (m.name || m.text);
  if (m.audioUrl) return '🔊 Audio enregistré';
  if (m.name && m.text) return '📝 ' + m.name + ' — ' + m.text;
  return '📝 ' + (m.name || m.text || 'Texte');
}

function closeSoundSheet() {
  const el = document.getElementById('soundSheet');
  if (el) el.remove();
}

function openSoundSheet(options, selectedId, onPick) {
  closeSoundSheet();
  const wrap = document.createElement('div');
  wrap.id = 'soundSheet';
  wrap.className = 'sound-sheet';

  const backdrop = document.createElement('div');
  backdrop.className = 'sound-sheet-backdrop';
  backdrop.onclick = closeSoundSheet;

  const panel = document.createElement('div');
  panel.className = 'sound-sheet-panel';

  const handle = document.createElement('div');
  handle.className = 'sound-sheet-handle';
  const list = document.createElement('div');
  list.className = 'sound-sheet-list';

  options.forEach((o) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sound-opt' + (String(o.id || '') === String(selectedId || '') ? ' selected' : '');
    b.textContent = o.label;
    b.onclick = () => {
      onPick(o.id || '');
      closeSoundSheet();
    };
    list.appendChild(b);
  });

  panel.appendChild(handle);
  panel.appendChild(list);
  wrap.appendChild(backdrop);
  wrap.appendChild(panel);
  document.body.appendChild(wrap);

  let startY = null;
  panel.addEventListener('touchstart', (e) => { startY = e.changedTouches[0].clientY; }, { passive: true });
  panel.addEventListener('touchend', (e) => {
    if (startY == null) return;
    const dy = e.changedTouches[0].clientY - startY;
    startY = null;
    if (dy > 70) closeSoundSheet();
  }, { passive: true });
}

function renderSoundPicker(container, messages, selectedId, onPick, opts) {
  const options = [{ id: '', label: '🔔 Bip' }];
  (messages || []).forEach((m) => options.push({ id: m.id, label: soundLabel(m) }));
  const current = options.find((o) => String(o.id || '') === String(selectedId || '')) || options[0];

  container.className = 'sound-picker';
  container.innerHTML = '';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sound-opt selected sound-open';
  btn.textContent = current.label;
  btn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openSoundSheet(options, current.id, onPick);
  };
  container.appendChild(btn);
}

function initLibraryTabs() {
  const tabs = document.querySelectorAll('.lib-tab');
  const panels = document.querySelectorAll('.lib-panel');
  if (!tabs.length) return;
  tabs.forEach((tab) => {
    tab.onclick = () => openLibraryTab(tab.dataset.tab);
  });
}

function openLibraryTab(tabId) {
  const tabs = document.querySelectorAll('.lib-tab');
  const panels = document.querySelectorAll('.lib-panel');
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === tabId));
  panels.forEach((p) => { p.hidden = p.dataset.panel !== tabId; });
}

function createScheduleManager({ containerId, socket, getMessages }) {
  const container = document.getElementById(containerId);
  let schedules = [];

  function snapshot(list) {
    return JSON.stringify((list || []).map((s) => ({
      id: s.id,
      time: s.time || '',
      messageId: s.messageId || '',
      duration: String(s.duration || 30),
    })));
  }

  function setSchedules(newSchedules) {
    const next = newSchedules || [];
    if (snapshot(next) === snapshot(schedules)) {
      refreshPickers();
      return;
    }
    schedules = next;
    if (container.querySelector('input:focus')) {
      refreshPickers();
      return;
    }
    render();
  }

  function refreshPickers() {
    const messages = getMessages ? getMessages() : [];
    container.querySelectorAll('.sound-picker').forEach((picker) => {
      const i = Number(picker.dataset.i);
      const selected = schedules[i] ? schedules[i].messageId : '';
      renderSoundPicker(picker, messages, selected, (id) => pickSound(i, id), { emptyHint: false });
    });
  }

  function pickSound(index, messageId) {
    if (!schedules[index]) return;
    schedules[index].messageId = messageId;
    save();
    refreshPickers();
  }

  function render() {
    const messages = getMessages ? getMessages() : [];
    container.innerHTML = '';
    if (!schedules.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'Aucun horaire. Ajoute-en un, il se synchronise tout de suite.';
      container.appendChild(empty);
      return;
    }
    schedules.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'sched-item sched-alarm';

      const lab = document.createElement('label');
      lab.textContent = 'Son';
      const picker = document.createElement('div');
      picker.dataset.i = String(i);
      renderSoundPicker(picker, messages, s.messageId, (id) => pickSound(i, id), { emptyHint: false });

      const meta = document.createElement('div');
      meta.className = 'sched-row';
      meta.innerHTML = `
        <input type="time" value="${s.time || ''}" data-i="${i}" data-f="time">
        <input type="number" style="width:72px" value="${s.duration || 30}" min="5" max="120" data-i="${i}" data-f="duration" title="Durée en secondes">
        <span class="hint" style="margin:0">sec</span>
        <button class="danger sched-del-btn" data-i="${i}" type="button">✕</button>
      `;

      row.appendChild(lab);
      row.appendChild(picker);
      row.appendChild(meta);
      container.appendChild(row);
    });

    container.querySelectorAll('input[data-f]').forEach((inp) => {
      inp.onchange = () => {
        schedules[+inp.dataset.i][inp.dataset.f] = inp.value;
        save();
      };
    });
    container.querySelectorAll('.sched-del-btn').forEach((btn) => {
      btn.onclick = () => { schedules.splice(+btn.dataset.i, 1); save(); render(); };
    });
  }

  function addSchedule() {
    schedules.push({ id: 's' + Date.now(), time: '08:00', messageId: '', duration: 30 });
    save();
    render();
  }

  function save() {
    socket.emit('update-schedules', schedules);
  }

  function assignAll(messageId) {
    if (!messageId) return;
    if (!schedules.length) {
      schedules.push({ id: 's' + Date.now(), time: '08:00', messageId, duration: 30 });
    } else {
      schedules.forEach((s) => { s.messageId = messageId; });
    }
    save();
    render();
  }

  return { setSchedules, addSchedule, save, render, assignAll };
}

function setModalExpanded(sheet, on) {
  if (!sheet) return;
  sheet.classList.toggle('expanded', on);
  const btn = sheet.querySelector('[data-expand]');
  if (btn) btn.textContent = on ? 'Réduire' : 'Agrandir';
}

function initModalExpand() {
  document.querySelectorAll('[data-expand]').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sheet = btn.closest('.modal-sheet');
      setModalExpanded(sheet, !sheet.classList.contains('expanded'));
    };
  });
}

initModalExpand();
