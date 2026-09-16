'use strict';

process.env.TUNNEL = '0';

const fs = require('fs');
const path = require('path');
const bootFile = path.join(__dirname, 'boot.log');

function boot(msg) {
  try {
    fs.appendFileSync(bootFile, new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) {}
  console.error('[boot]', msg);
}

try {
  fs.writeFileSync(bootFile, '');
} catch (e) {}
boot('main.js start');

process.on('uncaughtException', (err) => {
  boot('uncaughtException ' + (err && err.stack ? err.stack : err));
});
process.on('unhandledRejection', (err) => {
  boot('unhandledRejection ' + (err && err.stack ? err.stack : err));
});
process.exit = function blockedExit(code) {
  boot('process.exit ignoré code=' + code);
};

setInterval(() => {}, 60 * 60 * 1000);

try {
  require('child_process');
  boot('child_process ok');
} catch (e) {
  boot('child_process absent: ' + (e && e.message ? e.message : e));
  const Module = require('module');
  const { EventEmitter } = require('events');
  const stub = {
    execFileSync() {
      throw new Error('child_process unavailable');
    },
    execSync() {
      throw new Error('child_process unavailable');
    },
    spawn() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.unref = function () {};
      child.kill = function () {};
      return child;
    },
    execFile() {},
    fork() {
      throw new Error('child_process unavailable');
    },
  };
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'child_process') return stub;
    return orig.apply(this, arguments);
  };
}

let send = (tag, message) => {
  boot('send ' + tag + ' ' + String(message).slice(0, 200));
};
try {
  const bridge = require('flutter-bridge');
  send = (tag, message) => {
    try {
      bridge.send(tag, message);
    } catch (e) {}
    boot('send ' + tag + ' ' + String(message).slice(0, 200));
  };
  boot('flutter-bridge ok');
} catch (e) {
  boot('flutter-bridge: ' + (e && e.message ? e.message : e));
}

send('node', 'STARTED');

const origLog = console.log;
console.log = (...args) => {
  const line = args.map((a) => {
    if (typeof a === 'string') return a;
    try {
      return JSON.stringify(a);
    } catch (err) {
      return String(a);
    }
  }).join(' ');
  const cf = line.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i);
  if (cf && cf[0].indexOf('api.trycloudflare.com') === -1) {
    send('publicUrl', cf[0]);
  }
  if (line.indexOf('Même WiFi') !== -1 || line.indexOf('Meme WiFi') !== -1) {
    const lan = line.match(/https:\/\/[^\s]+/);
    if (lan) {
      send('localUrl', lan[0]);
    }
  }
  if (line.indexOf('=== Gamelle Chat ===') !== -1) {
    send('node', 'LISTENING');
  }
  origLog.apply(console, args);
};

function tryRequire(name) {
  boot('require ' + name);
  require(name);
  boot('ok ' + name);
}

try {
  tryRequire('express');
  tryRequire('selfsigned');
  tryRequire('socket.io');
  tryRequire('./update-service');
  tryRequire('./server.js');
  boot('server.js loaded');
} catch (err) {
  const msg = String(err && err.stack ? err.stack : err);
  boot('FAIL ' + msg);
  send('node', 'ERROR ' + msg);
}
