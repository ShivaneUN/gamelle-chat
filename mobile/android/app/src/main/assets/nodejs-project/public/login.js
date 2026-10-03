(function () {
  const SESSION_KEY = 'gamelleSession';
  const form = document.getElementById('loginForm');
  const userEl = document.getElementById('gamelleUser') || document.getElementById('username');
  const passEl = document.getElementById('gamellePass') || document.getElementById('password');
  const errEl = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');
  const toggle = document.getElementById('togglePass');

  function saveToken() {}

  function readToken() {
    return '';
  }

  function authHeaders() {
    const t = readToken();
    const h = { 'Content-Type': 'application/json' };
    if (t) h.Authorization = 'Bearer ' + t;
    return h;
  }

  function goController() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    location.replace('/controller.html');
  }

  if (toggle && passEl) {
    toggle.addEventListener('click', () => {
      const show = passEl.type === 'password';
      passEl.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'ABC' : '•••';
    });
  }

  try {
    const q = new URLSearchParams(location.search);
    if (errEl && q.get('reason') === 'session') {
      errEl.textContent = 'Session reprise ailleurs — reconnecte-toi ici.';
    }
  } catch (e) {}

  async function alreadyIn() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin', headers: authHeaders() });
      const j = await r.json();
      if (j && j.authenticated) {
        if (j.token) saveToken(j.token);
        goController(j.token || readToken());
        return true;
      }
    } catch (e) {}
    return false;
  }

  alreadyIn();

  fetch('/api/info').then((r) => r.json()).then((j) => {
    const el = document.getElementById('serverVer');
    if (el && j && j.version) el.textContent = 'Serveur ' + j.version;
  }).catch(() => {});

  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (errEl) errEl.textContent = '';
    // Lire tout de suite : un délai laisse le trousseau iPhone écraser le mot de passe tapé.
    const username = String(userEl && userEl.value || '').trim();
    const password = String(passEl && passEl.value || '');
    if (!username || !password) {
      if (errEl) errEl.textContent = 'Identifiant et mot de passe requis.';
      return;
    }
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
      if (j.token) saveToken(j.token);
      // Toujours entrer au contrôleur : cookie OU token local (secours OTA).
      if (passEl) passEl.value = '';
      goController(j.token || readToken());
    } catch (err) {
      if (errEl) errEl.textContent = 'Impossible de joindre le serveur';
    } finally {
      if (btn) btn.disabled = false;
    }
  });
})();
