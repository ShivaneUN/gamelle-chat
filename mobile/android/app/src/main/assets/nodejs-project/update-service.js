const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname);
const PKG_PATH = path.join(ROOT, 'package.json');
const LOCK_PATH = path.join(ROOT, 'package-lock.json');

function pkgVersion() {
  try { return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')).version || '0.0.0'; }
  catch (e) { return '0.0.0'; }
}

function isGitRepo() {
  return fs.existsSync(path.join(ROOT, '.git'));
}

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  }).trim();
}

function remoteBranch() {
  try {
    const ref = git(['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const name = ref.replace(/^refs\/remotes\/origin\//, '');
    if (name) return name;
  } catch (e) {}
  try { git(['rev-parse', '--verify', 'origin/main']); return 'main'; } catch (e) {}
  try { git(['rev-parse', '--verify', 'origin/master']); return 'master'; } catch (e) {}
  return 'main';
}

function short(sha) {
  return String(sha || '').slice(0, 7);
}

function npmInstall() {
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(cmd, ['install'], {
    cwd: ROOT,
    timeout: 300000,
    windowsHide: true,
    stdio: 'pipe',
  });
}

function getStatus() {
  const version = pkgVersion();
  if (!isGitRepo()) {
    return {
      ok: true,
      git: false,
      version,
      available: false,
      message: 'Pas un clone git. Sur la tablette : git clone puis npm install.',
    };
  }
  try {
    git(['rev-parse', '--is-inside-work-tree']);
  } catch (e) {
    return { ok: false, git: false, version, available: false, message: 'Git introuvable. pkg install git' };
  }
  try {
    git(['fetch', 'origin']);
  } catch (e) {
    const err = (e.stderr || e.message || '').toString();
    return {
      ok: false,
      git: true,
      version,
      available: false,
      message: 'Impossible de joindre GitHub. Vérifie internet et la connexion git (dépôt privé).',
      error: err.slice(0, 300),
    };
  }
  const branch = remoteBranch();
  let local = '';
  let remote = '';
  try { local = git(['rev-parse', 'HEAD']); } catch (e) {}
  try { remote = git(['rev-parse', `origin/${branch}`]); } catch (e) {}
  const available = !!(local && remote && local !== remote);
  return {
    ok: true,
    git: true,
    version,
    branch,
    local: short(local),
    remote: short(remote),
    available,
    message: available
      ? 'Une mise à jour est disponible.'
      : 'Déjà à jour.',
  };
}

function applyUpdate() {
  const before = getStatus();
  if (!before.git) return { ok: false, message: before.message, restart: false };
  if (!before.available) return { ok: true, message: 'Déjà à jour.', restart: false, version: before.version };

  const lockBefore = fs.existsSync(LOCK_PATH) ? fs.readFileSync(LOCK_PATH, 'utf8') : '';
  const pkgBefore = fs.existsSync(PKG_PATH) ? fs.readFileSync(PKG_PATH, 'utf8') : '';
  const branch = before.branch || remoteBranch();
  try {
    git(['pull', '--ff-only', 'origin', branch]);
  } catch (e) {
    const err = (e.stderr || e.message || '').toString();
    return {
      ok: false,
      restart: false,
      message: 'git pull a échoué (modifs locales ou conflit).',
      error: err.slice(0, 400),
    };
  }
  const lockAfter = fs.existsSync(LOCK_PATH) ? fs.readFileSync(LOCK_PATH, 'utf8') : '';
  const pkgAfter = fs.existsSync(PKG_PATH) ? fs.readFileSync(PKG_PATH, 'utf8') : '';
  if (lockBefore !== lockAfter || pkgBefore !== pkgAfter) {
    try { npmInstall(); }
    catch (e) {
      return {
        ok: false,
        restart: false,
        message: 'Code tiré, mais npm install a échoué.',
        error: (e.message || '').toString().slice(0, 400),
      };
    }
  }
  return {
    ok: true,
    restart: true,
    version: pkgVersion(),
    message: 'Mise à jour installée. Le serveur redémarre…',
  };
}

function restartServer() {
  const node = process.execPath;
  const script = path.join(ROOT, 'server.js');
  const child = spawn(node, [script], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: process.env,
    windowsHide: true,
  });
  child.unref();
  setTimeout(() => process.exit(0), 400);
}

module.exports = { getStatus, applyUpdate, restartServer, pkgVersion };
