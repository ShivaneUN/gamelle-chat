(function () {
  const form = document.getElementById('loginForm');
  const userEl = document.getElementById('username');
  const passEl = document.getElementById('password');
  const errEl = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');
  const toggle = document.getElementById('togglePass');

  if (toggle && passEl) {
    toggle.addEventListener('click', () => {
      const show = passEl.type === 'password';
      passEl.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'ABC' : '•••';
    });
  }

  async function alreadyIn() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
      const j = await r.json();
      if (j && j.authenticated) {
        location.replace('/controller.html');
        return true;
      }
    } catch (e) {}
    return false;
  }

  alreadyIn();

  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (errEl) errEl.textContent = '';
    const username = (userEl && userEl.value || '').trim();
    const password = (passEl && passEl.value) || '';
    if (btn) btn.disabled = true;
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        if (errEl) errEl.textContent = (j && j.error) || 'Identifiants incorrects';
        return;
      }
      if (passEl) passEl.value = '';
      location.replace('/controller.html');
    } catch (err) {
      if (errEl) errEl.textContent = 'Impossible de joindre le serveur';
    } finally {
      if (btn) btn.disabled = false;
    }
  });
})();
