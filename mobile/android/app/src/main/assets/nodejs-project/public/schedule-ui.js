// Composant partagé entre controller.js et receiver.js pour la gestion des horaires.
// Chaque horaire référence un message de la bibliothèque (texte et/ou audio) via messageId.
function soundLabel(m) {
  if (!m) return '🔔 Bip';
  if (m.audioUrl && (m.name || m.text)) return '🔊 ' + (m.name || m.text);
  if (m.audioUrl) return '🔊 Audio enregistré';
  if (m.name && m.text) return '📝 ' + m.name + ' — ' + m.text;
  return '📝 ' + (m.name || m.text || 'Texte');
}

function allSoundOptions(messages, includeNone) {
  const options = [];
  if (includeNone) options.push({ id: '', label: '— Aucun —' });
  if (typeof builtinSoundOptions === 'function') {
    builtinSoundOptions().forEach((o) => options.push(o));
  } else {
    options.push({ id: 'beep', label: '🔔 Bip' });
  }
  (messages || []).forEach((m) => options.push({ id: m.id, label: soundLabel(m) }));
  return options;
}

function closeSoundSheet() {
  const el = document.getElementById('soundSheet');
  if (el) el.remove();
}

function closeTimeSheet() {
  const el = document.getElementById('timeSheet');
  if (el) el.remove();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseTimeValue(value) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
  let h = m ? Number(m[1]) : 8;
  let min = m ? Number(m[2]) : 0;
  if (h < 0 || h > 23 || Number.isNaN(h)) h = 8;
  if (min < 0 || min > 59 || Number.isNaN(min)) min = 0;
  return { h, min };
}

function openTimeSheet(value, onPick) {
  closeSoundSheet();
  closeTimeSheet();
  let { h, min } = parseTimeValue(value);

  const wrap = document.createElement('div');
  wrap.id = 'timeSheet';
  wrap.className = 'time-sheet';

  const backdrop = document.createElement('div');
  backdrop.className = 'time-sheet-backdrop';

  const panel = document.createElement('div');
  panel.className = 'time-sheet-panel';

  const title = document.createElement('div');
  title.className = 'time-sheet-title';
  title.textContent = 'Heure';

  const labs = document.createElement('div');
  labs.className = 'time-sheet-labs';
  labs.innerHTML = '<span>Heure</span><span>Minute</span>';

  const cols = document.createElement('div');
  cols.className = 'time-sheet-cols';
  const hourCol = document.createElement('div');
  hourCol.className = 'time-sheet-col';
  const minCol = document.createElement('div');
  minCol.className = 'time-sheet-col';

  function paintCols() {
    hourCol.innerHTML = '';
    minCol.innerHTML = '';
    for (let i = 0; i < 24; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'time-opt' + (i === h ? ' selected' : '');
      b.textContent = pad2(i);
      b.onclick = () => { h = i; paintCols(); scrollSelected(); };
      hourCol.appendChild(b);
    }
    for (let i = 0; i < 60; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'time-opt' + (i === min ? ' selected' : '');
      b.textContent = pad2(i);
      b.onclick = () => { min = i; paintCols(); scrollSelected(); };
      minCol.appendChild(b);
    }
  }

  function scrollSelected() {
    requestAnimationFrame(() => {
      [hourCol, minCol].forEach((col) => {
        const sel = col.querySelector('.selected');
        if (!sel) return;
        col.scrollTop = sel.offsetTop - (col.clientHeight / 2) + (sel.clientHeight / 2);
      });
    });
  }

  const footer = document.createElement('div');
  footer.className = 'time-sheet-footer';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost';
  cancel.textContent = 'Annuler';
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.textContent = 'Définir';
  function close() { wrap.remove(); }
  backdrop.onclick = close;
  cancel.onclick = close;
  ok.onclick = () => {
    onPick(pad2(h) + ':' + pad2(min));
    close();
  };
  footer.appendChild(cancel);
  footer.appendChild(ok);

  paintCols();
  cols.appendChild(hourCol);
  cols.appendChild(minCol);
  panel.appendChild(title);
  panel.appendChild(labs);
  panel.appendChild(cols);
  panel.appendChild(footer);
  wrap.appendChild(backdrop);
  wrap.appendChild(panel);
  document.body.appendChild(wrap);
  scrollSelected();
}

function openSoundSheet(options, selectedId, onPick) {
  closeTimeSheet();
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
      if (typeof playBuiltinSound === 'function' && typeof isBuiltinSound === 'function' && isBuiltinSound(o.id)) {
        playBuiltinSound(o.id);
      }
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
  const includeNone = !!(opts && opts.includeNone);
  const options = allSoundOptions(messages, includeNone);
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

const WEEK_DAYS = [
  { d: 1, l: 'L' },
  { d: 2, l: 'M' },
  { d: 3, l: 'M' },
  { d: 4, l: 'J' },
  { d: 5, l: 'V' },
  { d: 6, l: 'S' },
  { d: 0, l: 'D' },
];

function allWeekDays() {
  return [0, 1, 2, 3, 4, 5, 6];
}

function normalizeDays(days) {
  if (!Array.isArray(days) || !days.length) return allWeekDays();
  const set = new Set(days.map(Number).filter((n) => n >= 0 && n <= 6));
  if (!set.size) return allWeekDays();
  return allWeekDays().filter((n) => set.has(n));
}

function isEveryDay(days) {
  return normalizeDays(days).length === 7;
}

function createScheduleManager({ containerId, socket, getMessages }) {
  const container = document.getElementById(containerId);
  let schedules = [];

  function snapshot(list) {
    return JSON.stringify((list || []).map((s) => ({
      id: s.id,
      time: s.time || '',
      sound1: s.sound1 || '',
      sound2: s.sound2 || s.messageId || '',
      messageId: s.messageId || s.sound2 || '',
      duration: String(s.duration || 30),
      days: normalizeDays(s.days).join(','),
    })));
  }

  function setSchedules(newSchedules) {
    const next = newSchedules || [];
    if (snapshot(next) === snapshot(schedules)) {
      refreshPickers();
      return;
    }
    // Si un champ durée a le focus, commit avant de remplacer la liste.
    const focused = container.querySelector('input:focus');
    if (focused && focused.dataset && focused.dataset.i != null) {
      const i = +focused.dataset.i;
      if (schedules[i] && focused.dataset.f) {
        schedules[i][focused.dataset.f] = focused.value;
        save();
      }
    }
    schedules = next;
    render();
  }

  function refreshPickers() {
    const messages = getMessages ? getMessages() : [];
    container.querySelectorAll('.sound-picker').forEach((picker) => {
      const i = Number(picker.dataset.i);
      const field = picker.dataset.f || 'sound2';
      const selected = schedules[i] ? (schedules[i][field] || '') : '';
      renderSoundPicker(picker, messages, selected, (id) => pickSound(i, field, id), {
        includeNone: field === 'sound2' || field === 'sound1',
      });
    });
  }

  function pickSound(index, field, id) {
    if (!schedules[index]) return;
    schedules[index][field] = id;
    if (field === 'sound2') schedules[index].messageId = id;
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

      const lab1 = document.createElement('label');
      lab1.className = 'sched-sound-lab';
      lab1.textContent = 'Son 1';
      const picker1 = document.createElement('div');
      picker1.dataset.i = String(i);
      picker1.dataset.f = 'sound1';
      renderSoundPicker(picker1, messages, s.sound1 || '', (id) => pickSound(i, 'sound1', id), { includeNone: true });

      const lab2 = document.createElement('label');
      lab2.className = 'sched-sound-lab';
      lab2.textContent = 'Son 2 (ensuite)';
      const picker2 = document.createElement('div');
      picker2.dataset.i = String(i);
      picker2.dataset.f = 'sound2';
      renderSoundPicker(picker2, messages, s.sound2 || s.messageId || '', (id) => pickSound(i, 'sound2', id), { includeNone: true });

      const meta = document.createElement('div');
      meta.className = 'sched-row';
      const timeBtn = document.createElement('button');
      timeBtn.type = 'button';
      timeBtn.className = 'sched-time-btn';
      timeBtn.textContent = s.time || '08:00';
      timeBtn.onclick = () => {
        openTimeSheet(schedules[i].time, (t) => {
          schedules[i].time = t;
          timeBtn.textContent = t;
          save();
        });
      };
      const dur = document.createElement('input');
      dur.type = 'number';
      dur.value = String(s.duration || 30);
      dur.min = '5';
      dur.max = '120';
      dur.dataset.i = String(i);
      dur.dataset.f = 'duration';
      dur.title = 'Durée en secondes';
      const sec = document.createElement('span');
      sec.className = 'hint';
      sec.style.margin = '0';
      sec.textContent = 'sec';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'danger sched-del-btn';
      del.dataset.i = String(i);
      del.textContent = '✕';
      meta.appendChild(timeBtn);
      meta.appendChild(dur);
      meta.appendChild(sec);
      meta.appendChild(del);

      const daysWrap = document.createElement('div');
      daysWrap.className = 'sched-days';
      const days = normalizeDays(s.days);
      const allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.className = 'ghost sched-all' + (isEveryDay(days) ? ' on' : '');
      allBtn.textContent = 'Tous les jours';
      allBtn.onclick = () => setDays(i, allWeekDays());
      daysWrap.appendChild(allBtn);
      const chips = document.createElement('div');
      chips.className = 'sched-day-row';
      WEEK_DAYS.forEach((wd) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sched-day' + (days.includes(wd.d) ? ' on' : '');
        b.textContent = wd.l;
        b.title = wd.l;
        b.onclick = () => toggleDay(i, wd.d);
        chips.appendChild(b);
      });
      daysWrap.appendChild(chips);

      row.appendChild(lab1);
      row.appendChild(picker1);
      row.appendChild(lab2);
      row.appendChild(picker2);
      row.appendChild(meta);
      row.appendChild(daysWrap);
      container.appendChild(row);
    });

    container.querySelectorAll('input[data-f]').forEach((inp) => {
      const commit = () => {
        const i = +inp.dataset.i;
        if (!schedules[i]) return;
        schedules[i][inp.dataset.f] = inp.value;
        save();
      };
      inp.onchange = commit;
      inp.onblur = commit;
    });
    container.querySelectorAll('.sched-del-btn').forEach((btn) => {
      btn.onclick = () => { schedules.splice(+btn.dataset.i, 1); save(); render(); };
    });
  }

  function setDays(index, days) {
    if (!schedules[index]) return;
    schedules[index].days = normalizeDays(days);
    save();
    render();
  }

  function toggleDay(index, day) {
    if (!schedules[index]) return;
    const current = normalizeDays(schedules[index].days);
    if (isEveryDay(current)) {
      // Depuis « tous les jours », un tap désactive CE jour (pas « seulement ce jour »).
      setDays(index, current.filter((d) => d !== day));
      return;
    }
    const set = new Set(current);
    if (set.has(day)) {
      if (set.size <= 1) return;
      set.delete(day);
    } else {
      set.add(day);
    }
    setDays(index, [...set]);
  }

  function addSchedule() {
    schedules.push({ id: 's' + Date.now(), time: '08:00', sound1: 'beep', sound2: '', messageId: '', duration: 30, days: allWeekDays() });
    save();
    render();
  }

  function save() {
    socket.emit('update-schedules', schedules);
  }

  function assignAll(messageId) {
    if (!messageId) return;
    if (!schedules.length) {
      schedules.push({ id: 's' + Date.now(), time: '08:00', messageId, sound1: 'beep', sound2: messageId, duration: 30, days: allWeekDays() });
    } else {
      schedules.forEach((s) => {
        s.messageId = messageId;
        s.sound2 = messageId;
        if (!s.sound1) s.sound1 = 'beep';
      });
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
