(function () {
  if (window.__gamelleSlide) return;

  var wrap = document.getElementById('fluxWrap');
  var card = wrap && wrap.closest('.live-card');
  var under = document.getElementById('underFlux');
  var touch = document.getElementById('fluxTouch');
  var handle = document.getElementById('fluxHandle');
  if (!wrap || !card || !under) return;
  window.__gamelleSlide = 1;

  var canvas = document.getElementById('fluxCanvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'fluxCanvas';
    canvas.className = 'flux-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    wrap.insertBefore(canvas, touch || null);
  }
  var ctx = canvas.getContext('2d');

  function liveVideos() {
    if (document.body.classList.contains('simult')) return [];
    var all = wrap.getElementsByTagName('video');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var v = all[i];
      if (v.closest && v.closest('.self-pip')) continue;
      if (v.style.display === 'none') continue;
      if (v.classList.contains('on') || v.style.display === 'block') out.push(v);
    }
    return out;
  }

  function drawCover(v, dx, dy, dw, dh) {
    var sw = v.videoWidth;
    var sh = v.videoHeight;
    if (!sw || !sh || dw < 1 || dh < 1) return;
    var scale = Math.max(dw / sw, dh / sh);
    var w = sw * scale;
    var h = sh * scale;
    ctx.drawImage(v, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
  }

  function paint() {
    var list = liveVideos();
    var ready = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].videoWidth > 0) ready.push(list[i]);
    }
    if (!ready.length) {
      canvas.classList.remove('on');
      canvas.style.display = 'none';
      setTimeout(queue, 250);
      return;
    }
    var w = wrap.clientWidth;
    var h = wrap.clientHeight;
    if (w < 2 || h < 2) {
      queue();
      return;
    }
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var pw = Math.max(2, Math.round(w * dpr));
    var ph = Math.max(2, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    canvas.classList.add('on');
    canvas.style.display = 'block';
    var main = ready[0];
    for (var j = 0; j < ready.length; j++) {
      if (ready[j].id === 'visioRemote' || ready[j].id === 'remoteVideo') main = ready[j];
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, pw, ph);
    try { drawCover(main, 0, 0, pw, ph); } catch (e) {}
    for (var k = 0; k < ready.length; k++) {
      if (ready[k] === main) continue;
      var bw = Math.round(pw * 0.32);
      var bh = Math.round(ph * 0.38);
      try { drawCover(ready[k], pw - bw - Math.round(8 * dpr), ph - bh - Math.round(8 * dpr), bw, bh); } catch (e2) {}
    }
    queue();
  }

  function queue() {
    var list = liveVideos();
    for (var i = 0; i < list.length; i++) {
      if (list[i].videoWidth > 0) {
        requestAnimationFrame(paint);
        return;
      }
    }
    setTimeout(paint, 200);
  }
  queue();

  function apply(on) {
    if (on) {
      card.classList.add('flux-collapsed');
      under.style.setProperty('display', 'none', 'important');
    } else {
      card.classList.remove('flux-collapsed');
      under.style.removeProperty('display');
    }
    wrap.style.flex = '1 1 auto';
  }

  function nodeOf(n) {
    if (!n) return null;
    return n.nodeType === 1 ? n : n.parentElement;
  }

  function zone(n) {
    n = nodeOf(n);
    if (!n || !n.closest) return '';
    if (n.closest('button, a, input, select, textarea, label, .self-pip, .dock, .page-head')) return '';
    if (handle && (n === handle || handle.contains(n))) return 'handle';
    if (touch && (n === touch || touch.contains(n))) return 'flux';
    if (n === wrap || wrap.contains(n)) return 'flux';
    if (n === canvas) return 'flux';
    return '';
  }

  var y0 = 0;
  var tracking = false;

  function yOf(ev) {
    var t = (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]) || ev;
    return t && t.clientY != null ? t.clientY : null;
  }

  function onStart(ev) {
    if (!zone(ev.target)) return;
    var y = yOf(ev);
    if (y == null) return;
    tracking = true;
    y0 = y;
  }

  function onMove(ev) {
    if (!tracking) return;
    var y = yOf(ev);
    if (y == null) return;
    var dy = y - y0;
    if (dy > 16) apply(true);
    else if (dy < -16) apply(false);
    if (Math.abs(dy) > 16 && ev.cancelable) ev.preventDefault();
  }

  function onEnd(ev) {
    if (!tracking) return;
    var y = yOf(ev);
    if (y != null) {
      var dy = y - y0;
      if (dy > 16) apply(true);
      else if (dy < -16) apply(false);
    }
    tracking = false;
  }

  function bind(el) {
    if (!el) return;
    var opt = { capture: true, passive: false };
    el.addEventListener('touchstart', onStart, opt);
    el.addEventListener('touchmove', onMove, opt);
    el.addEventListener('touchend', onEnd, opt);
    el.addEventListener('touchcancel', function () { tracking = false; }, opt);
    el.addEventListener('pointerdown', function (ev) {
      if (ev.button != null && ev.button !== 0) return;
      onStart(ev);
      if (!zone(ev.target) || ev.pointerId == null) return;
      var cap = zone(ev.target) === 'handle' ? handle : (touch || wrap);
      try { cap.setPointerCapture(ev.pointerId); } catch (e) {}
    }, opt);
    el.addEventListener('pointermove', onMove, opt);
    el.addEventListener('pointerup', onEnd, opt);
    el.addEventListener('pointercancel', function () { tracking = false; }, opt);
    el.ontouchstart = onStart;
    el.ontouchmove = onMove;
    el.ontouchend = onEnd;
    el.ontouchcancel = function () { tracking = false; };
  }

  bind(touch);
  bind(handle);
  bind(wrap);
})();
