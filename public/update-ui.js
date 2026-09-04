function bindAppUpdate(root) {
  const statusEl = root.querySelector('[data-update-status]');
  const checkBtn = root.querySelector('[data-update-check]');
  const applyBtn = root.querySelector('[data-update-apply]');
  if (!statusEl || !checkBtn || !applyBtn) return;

  async function paint() {
    statusEl.textContent = 'Vérification…';
    applyBtn.hidden = true;
    checkBtn.disabled = true;
    try {
      const s = await fetch('/api/update/status').then((r) => r.json());
      statusEl.textContent = (s.version ? 'v' + s.version + ' — ' : '') + (s.message || '');
      applyBtn.hidden = !s.available;
    } catch (e) {
      statusEl.textContent = 'Impossible de vérifier (serveur hors ligne ?).';
    }
    checkBtn.disabled = false;
  }

  checkBtn.onclick = () => paint();
  applyBtn.onclick = async () => {
    applyBtn.disabled = true;
    checkBtn.disabled = true;
    statusEl.textContent = 'Téléchargement…';
    try {
      const s = await fetch('/api/update/apply', { method: 'POST' }).then((r) => r.json());
      statusEl.textContent = s.message || '';
      if (s.ok && s.restart) {
        statusEl.textContent = 'Redémarrage… recharge la page dans 5 secondes.';
        setTimeout(() => location.reload(), 5000);
        return;
      }
      applyBtn.hidden = !s.available;
    } catch (e) {
      statusEl.textContent = 'Échec. Réessaie, ou git pull dans le terminal.';
    }
    applyBtn.disabled = false;
    checkBtn.disabled = false;
  };

  paint();
}
