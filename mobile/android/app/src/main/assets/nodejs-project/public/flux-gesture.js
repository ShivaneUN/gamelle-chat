(function () {
  var card = document.querySelector('.live-card');
  var under = document.getElementById('underFlux');
  var btn = document.getElementById('fluxSizeBtn');
  if (!card || !under || !btn) return;

  function apply(on) {
    card.classList.toggle('flux-collapsed', !!on);
    under.style.display = on ? 'none' : '';
    btn.textContent = on ? 'Réduire' : 'Agrandir';
    btn.className = 'chip-btn ' + (on ? 'toggle-on' : 'toggle-off');
  }

  btn.addEventListener('click', function () {
    apply(!card.classList.contains('flux-collapsed'));
  });
})();
