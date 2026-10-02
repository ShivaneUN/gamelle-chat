(function () {
  const SESSION_KEY = 'gamelleSession';
  const form = document.getElementById('loginForm');
  const userEl = document.getElementById('username');
  const passEl = document.getElementById('password');
  const errEl = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');
  const toggle = document.getElementById('togglePass');

  function saveToken(token) {
    if (!token) return;
    try { localStorage.setItem(SESSION_KEY, String(token)); } catch (e) {}
    try { sessionStorage.setItem(SESSION_KEY, String(token)); } catch (e) {}
  }

  function readToken() {
    try {
      return localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function authHeaders() {
    const t = readToken();
    const h = { 'Content-Type': 'application/json' };
    if (t) h.Authorization = 'Bearer ' + t;
    return h;
  }

  function goController(token) {
    if (token) saveToken(token);
    const t = token || readToken();
    if (t) location.replace('/controller.html?access=' + encodeURIComponent(t));
    else location.replace('/controller.html');
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

  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (errEl) errEl.textContent = '';
    // iPhone : le mot de passe auto-rempli n’est pas encore dans le champ au clic.
    await new Promise((r) => setTimeout(r, 60));
    const fd = new FormData(form);
    const username = String((userEl && userEl.value) || fd.get('username') || '').trim();
    const password = String((passEl && passEl.value) || fd.get('password') || '');
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
