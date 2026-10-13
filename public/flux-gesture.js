(function () {
  var wrap = document.getElementById('fluxWrap');
  var card = document.querySelector('.live-card');
  if (!wrap || !card) return;
  var startY = 0;
  var tracking = false;

  function inGrabZone(ev) {
    var rect = wrap.getBoundingClientRect();
    var y = ev.clientY;
    return y >= rect.bottom - 56 && y <= rect.bottom + 8;
  }

  wrap.addEventListener('pointerdown', function (ev) {
    if (!inGrabZone(ev)) return;
    tracking = true;
    startY = ev.clientY;
  });
  wrap.addEventListener('pointermove', function (ev) {
    if (!tracking) return;
    var dy = ev.clientY - startY;
    if (dy > 36) {
      card.classList.add('flux-collapsed');
      tracking = false;
    } else if (dy < -36) {
      card.classList.remove('flux-collapsed');
      tracking = false;
    }
  });
  function stop() { tracking = false; }
  wrap.addEventListener('pointerup', stop);
  wrap.addEventListener('pointercancel', stop);
})();
