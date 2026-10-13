(function () {
  var wrap = document.getElementById('fluxWrap');
  var card = wrap && wrap.closest('.live-card');
  var under = document.getElementById('underFlux');
  var handle = document.getElementById('fluxHandle');
  if (!wrap || !card || !under) return;

  var startX = 0;
  var startY = 0;
  var tracking = false;
  var fromHandle = false;

  function collapsed() {
    return card.classList.contains('flux-collapsed');
  }

  function setCollapsed(on) {
    card.classList.toggle('flux-collapsed', !!on);
    under.style.display = on ? 'none' : '';
    wrap.style.flex = '1 1 auto';
  }

  function claimed(target) {
    if (!target || !target.closest) return false;
    if (target.closest('button, a, input, select, textarea, .self-pip, .dock, .page-head')) return false;
    if (handle && target.closest('#fluxHandle')) return 'handle';
    if (target.closest('#fluxWrap')) return 'flux';
    return false;
  }

  function begin(ev) {
    var where = claimed(ev.target);
    if (!where) return;
    var t = (ev.touches && ev.touches[0]) || ev;
    if (t.clientY == null) return;
    tracking = true;
    fromHandle = where === 'handle';
    startX = t.clientX;
    startY = t.clientY;
    if (ev.cancelable) ev.preventDefault();
  }

  function move(ev) {
    if (!tracking) return;
    var t = (ev.touches && ev.touches[0]) || ev;
    if (t.clientY == null) return;
    var dx = t.clientX - startX;
    var dy = t.clientY - startY;
    if (!fromHandle && Math.abs(dx) > Math.abs(dy) + 8) return;
    if (dy > 24) {
      setCollapsed(true);
      tracking = false;
    } else if (dy < -24) {
      setCollapsed(false);
      tracking = false;
    }
    if (ev.cancelable) ev.preventDefault();
  }

  function end() {
    tracking = false;
    fromHandle = false;
  }

  window.addEventListener('touchstart', begin, { capture: true, passive: false });
  window.addEventListener('touchmove', move, { capture: true, passive: false });
  window.addEventListener('touchend', end, true);
  window.addEventListener('touchcancel', end, true);
  window.addEventListener('pointerdown', function (ev) {
    if (ev.pointerType === 'touch') return;
    begin(ev);
  }, true);
  window.addEventListener('pointermove', function (ev) {
    if (ev.pointerType === 'touch') return;
    move(ev);
  }, true);
  window.addEventListener('pointerup', function (ev) {
    if (ev.pointerType === 'touch') return;
    end();
  }, true);
})();
