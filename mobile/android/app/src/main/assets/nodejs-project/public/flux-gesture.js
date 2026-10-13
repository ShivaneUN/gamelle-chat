(function () {
  var wrap = document.getElementById('fluxWrap');
  var card = document.querySelector('.live-card');
  var grab = wrap && wrap.querySelector('.flux-grab');
  if (!wrap || !card || !grab) return;
  var startY = 0;
  var tracking = false;

  function clientY(ev) {
    if (ev.touches && ev.touches.length) return ev.touches[0].clientY;
    if (ev.changedTouches && ev.changedTouches.length) return ev.changedTouches[0].clientY;
    return ev.clientY;
  }

  function onGrab(ev) {
    var t = ev.target;
    return !!(t && t.closest && t.closest('.flux-grab'));
  }

  function begin(ev) {
    if (!onGrab(ev)) return;
    if (ev.pointerType === 'mouse' && ev.button != null && ev.button !== 0) return;
    tracking = true;
    startY = clientY(ev);
    if (ev.pointerId != null && grab.setPointerCapture) {
      try { grab.setPointerCapture(ev.pointerId); } catch (e) {}
    }
    if (ev.cancelable) ev.preventDefault();
  }

  function move(ev) {
    if (!tracking) return;
    var dy = clientY(ev) - startY;
    if (dy > 28) {
      card.classList.add('flux-collapsed');
      tracking = false;
    } else if (dy < -28) {
      card.classList.remove('flux-collapsed');
      tracking = false;
    }
    if (tracking && ev.cancelable) ev.preventDefault();
  }

  function end() {
    tracking = false;
  }

  grab.addEventListener('pointerdown', begin);
  grab.addEventListener('pointermove', move);
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
})();
