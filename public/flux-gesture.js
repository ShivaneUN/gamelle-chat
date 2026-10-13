(function () {
  if (window.__gamelleSlide) return;

  var wrap = document.getElementById('fluxWrap');
  var card = wrap && wrap.closest('.live-card');
  var under = document.getElementById('underFlux');
  var touch = document.getElementById('fluxTouch');
  var handle = document.getElementById('fluxHandle');
  if (!wrap || !card || !under) return;
  window.__gamelleSlide = 1;

  var y0 = 0;
  var active = false;
  var pointerId = null;

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

  function el(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement;
  }

  function zone(node) {
    node = el(node);
    if (!node || !node.closest) return '';
    if (node.closest('button, a, input, select, textarea, label, .self-pip, .dock, .page-head')) return '';
    if (handle && handle.contains(node)) return 'handle';
    if (touch && touch.contains(node)) return 'flux';
    if (node === wrap || wrap.contains(node)) return 'flux';
    return '';
  }

  function begin(y) {
    active = true;
    y0 = y;
  }

  function drag(y) {
    if (!active) return;
    var dy = y - y0;
    if (dy > 12) apply(true);
    else if (dy < -12) apply(false);
  }

  function end() {
    active = false;
    pointerId = null;
  }

  function onDown(ev) {
    if (!zone(ev.target)) return;
    var t = (ev.touches && ev.touches[0]) || ev;
    if (!t || t.clientY == null) return;
    if (ev.touches && ev.touches.length > 1) return;
    begin(t.clientY);
    if (ev.pointerId != null) {
      pointerId = ev.pointerId;
      var cap = zone(ev.target) === 'handle' ? handle : (touch || wrap);
      try { cap.setPointerCapture(ev.pointerId); } catch (e) {}
    }
    if (ev.cancelable) ev.preventDefault();
  }

  function onMove(ev) {
    if (!active) return;
    if (pointerId != null && ev.pointerId != null && ev.pointerId !== pointerId) return;
    var t = (ev.touches && ev.touches[0]) || ev;
    if (!t || t.clientY == null) return;
    drag(t.clientY);
    if (ev.cancelable) ev.preventDefault();
  }

  function listen(target) {
    if (!target) return;
    target.addEventListener('touchstart', onDown, { capture: true, passive: false });
    target.addEventListener('touchmove', onMove, { capture: true, passive: false });
    target.addEventListener('touchend', end, true);
    target.addEventListener('touchcancel', end, true);
    target.addEventListener('pointerdown', onDown, { capture: true, passive: false });
    target.addEventListener('pointermove', onMove, { capture: true, passive: false });
    target.addEventListener('pointerup', end, true);
    target.addEventListener('pointercancel', end, true);
  }

  listen(touch);
  listen(handle);
  listen(wrap);
  listen(document);

  wrap.ontouchstart = onDown;
  wrap.ontouchmove = onMove;
  wrap.ontouchend = end;
  wrap.ontouchcancel = end;
  if (touch) {
    touch.ontouchstart = onDown;
    touch.ontouchmove = onMove;
    touch.ontouchend = end;
    touch.ontouchcancel = end;
  }
  if (handle) {
    handle.ontouchstart = onDown;
    handle.ontouchmove = onMove;
    handle.ontouchend = end;
    handle.ontouchcancel = end;
  }
})();
