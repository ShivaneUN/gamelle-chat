(function () {
  var wrap = document.getElementById('fluxWrap');
  var card = wrap && wrap.closest('.live-card');
  if (!wrap || !card) return;
  var startY = 0;
  var tracking = false;
  var touchId = null;

  function yOfTouch(list, id) {
    if (!list) return null;
    for (var i = 0; i < list.length; i++) {
      if (id == null || list[i].identifier === id) return list[i].clientY;
    }
    return null;
  }

  function inHandle(clientY) {
    var rect = wrap.getBoundingClientRect();
    return clientY >= rect.bottom - 80 && clientY <= rect.bottom + 36;
  }

  function blockedTarget(ev) {
    var t = ev.target;
    return !!(t && t.closest && t.closest('button, a, input, select, textarea, .self-pip'));
  }

  function beginTouch(ev) {
    if (!ev.touches || !ev.touches.length || blockedTarget(ev)) return;
    var y = ev.touches[0].clientY;
    if (!inHandle(y)) return;
    tracking = true;
    startY = y;
    touchId = ev.touches[0].identifier;
    if (ev.cancelable) ev.preventDefault();
  }

  function moveTouch(ev) {
    if (!tracking) return;
    var y = yOfTouch(ev.touches, touchId);
    if (y == null) return;
    var dy = y - startY;
    if (dy > 22) {
      card.classList.add('flux-collapsed');
      tracking = false;
    } else if (dy < -22) {
      card.classList.remove('flux-collapsed');
      tracking = false;
    }
    if (ev.cancelable) ev.preventDefault();
  }

  function endTouch() {
    tracking = false;
    touchId = null;
  }

  wrap.addEventListener('touchstart', beginTouch, { passive: false });
  document.addEventListener('touchmove', moveTouch, { passive: false });
  document.addEventListener('touchend', endTouch);
  document.addEventListener('touchcancel', endTouch);

  wrap.addEventListener('pointerdown', function (ev) {
    if (ev.pointerType === 'touch') return;
    if (blockedTarget(ev) || !inHandle(ev.clientY)) return;
    tracking = true;
    startY = ev.clientY;
    if (ev.cancelable) ev.preventDefault();
  });
  document.addEventListener('pointermove', function (ev) {
    if (ev.pointerType === 'touch' || !tracking || touchId != null) return;
    var dy = ev.clientY - startY;
    if (dy > 22) {
      card.classList.add('flux-collapsed');
      tracking = false;
    } else if (dy < -22) {
      card.classList.remove('flux-collapsed');
      tracking = false;
    }
  });
  document.addEventListener('pointerup', function (ev) {
    if (ev.pointerType === 'touch') return;
    tracking = false;
  });
})();
