(function () {
  if (window.gamelleFluxSize) return;
  window.gamelleFluxSize = function (btn) {
    if (!btn || btn.getAttribute('data-lock') === '1') return;
    btn.setAttribute('data-lock', '1');
    setTimeout(function () { btn.removeAttribute('data-lock'); }, 400);
    var card = btn.closest && btn.closest('.live-card');
    var under = document.getElementById('underFlux');
    if (!card || !under) return;
    var on = !card.classList.contains('flux-collapsed');
    card.classList.toggle('flux-collapsed', on);
    if (on) under.style.setProperty('display', 'none', 'important');
    else under.style.removeProperty('display');
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-label', on ? 'Réduire' : 'Agrandir');
  };
})();
