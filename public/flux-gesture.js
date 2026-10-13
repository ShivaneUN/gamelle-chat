(function () {
  var wrap = document.getElementById('fluxWrap');
  var card = wrap && wrap.closest('.live-card');
  if (!wrap || !card) return;

  var layer = wrap.querySelector('.flux-touch');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'flux-touch';
    layer.setAttribute('aria-hidden', 'true');
    wrap.appendChild(layer);
  }

  var startX = 0;
  var startY = 0;
  var tracking = false;

  function finish(dy) {
    if (dy > 28) {
      card.classList.add('flux-collapsed');
      return true;
    }
    if (dy < -28) {
      card.classList.remove('flux-collapsed');
      return true;
    }
    return false;
  }

  layer.addEventListener('touchstart', function (ev) {
    var t = ev.touches && ev.touches[0];
    if (!t) return;
    tracking = true;
    startX = t.clientX;
    startY = t.clientY;
    if (ev.cancelable) ev.preventDefault();
  }, { passive: false });

  layer.addEventListener('touchmove', function (ev) {
    if (!tracking) return;
    var t = ev.touches && ev.touches[0];
    if (!t) return;
    var dx = t.clientX - startX;
    var dy = t.clientY - startY;
    if (Math.abs(dx) > Math.abs(dy)) {
      if (ev.cancelable) ev.preventDefault();
      return;
    }
    if (finish(dy)) tracking = false;
    if (ev.cancelable) ev.preventDefault();
  }, { passive: false });

  function stopTouch() { tracking = false; }
  layer.addEventListener('touchend', stopTouch);
  layer.addEventListener('touchcancel', stopTouch);

  layer.addEventListener('pointerdown', function (ev) {
    if (ev.pointerType === 'touch') return;
    if (ev.button != null && ev.button !== 0) return;
    tracking = true;
    startX = ev.clientX;
    startY = ev.clientY;
    try { layer.setPointerCapture(ev.pointerId); } catch (e) {}
  });
  layer.addEventListener('pointermove', function (ev) {
    if (!tracking || ev.pointerType === 'touch') return;
    var dx = ev.clientX - startX;
    var dy = ev.clientY - startY;
    if (Math.abs(dx) > Math.abs(dy)) return;
    if (finish(dy)) tracking = false;
  });
  layer.addEventListener('pointerup', stopTouch);
  layer.addEventListener('pointercancel', stopTouch);
})();
