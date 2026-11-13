/* Progressive enhancement only: every feature also works with plain HTML forms. */
(function () {
  'use strict';

  // Confirmation for destructive actions
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var msg = form.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // Unread notification badge polling
  var badge = document.querySelector('[data-unread]');
  if (badge) {
    setInterval(function () {
      if (document.hidden) return;
      fetch('/api/meldingen/aantal', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d) return;
          badge.textContent = d.unread;
          badge.hidden = !d.unread;
        })
        .catch(function () {});
    }, 30000);
  }

  // Sound toggle on swipe video
  var soundBtn = document.querySelector('[data-sound]');
  var video = document.querySelector('[data-video]');
  if (soundBtn && video) {
    soundBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      video.muted = !video.muted;
      if (!video.muted) video.play().catch(function () {});
      soundBtn.textContent = video.muted ? '🔇' : '🔊';
      soundBtn.setAttribute('aria-label', video.muted ? 'Geluid aan' : 'Geluid uit');
    });
  }

  // Swipe gestures
  var card = document.querySelector('[data-card]');
  if (card) {
    var left = document.querySelector('[data-swipe-form="left"]');
    var right = document.querySelector('[data-swipe-form="right"]');
    var hintL = card.querySelector('.swipe-hint-left');
    var hintR = card.querySelector('.swipe-hint-right');
    var startX = null, dx = 0, submitted = false;
    var submit = function (dir) {
      if (submitted) return;
      submitted = true;
      card.style.transform = 'translateX(' + (dir === 'right' ? 140 : -140) + '%) rotate(' + (dir === 'right' ? 18 : -18) + 'deg)';
      card.style.opacity = '0';
      setTimeout(function () { (dir === 'right' ? right : left).submit(); }, 180);
    };
    card.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button') || e.target.closest('[data-more]')) return;
      startX = e.clientX; dx = 0;
      card.classList.add('dragging');
      card.setPointerCapture(e.pointerId);
    });
    card.addEventListener('pointermove', function (e) {
      if (startX === null) return;
      dx = e.clientX - startX;
      card.style.transform = 'translateX(' + dx + 'px) rotate(' + dx / 20 + 'deg)';
      var p = Math.min(Math.abs(dx) / 100, 1);
      hintR.style.opacity = dx > 0 ? p : 0;
      hintL.style.opacity = dx < 0 ? p : 0;
    });
    var end = function () {
      if (startX === null) return;
      startX = null;
      card.classList.remove('dragging');
      if (dx > 100) return submit('right');
      if (dx < -100) return submit('left');
      card.style.transform = '';
      hintL.style.opacity = 0; hintR.style.opacity = 0;
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
    var more = card.querySelector('[data-more]');
    var openBtn = card.querySelector('[data-more-open]');
    var closeBtn = card.querySelector('[data-more-close]');
    if (more && openBtn && closeBtn) {
      openBtn.addEventListener('click', function () { more.hidden = false; more.scrollTop = 0; });
      closeBtn.addEventListener('click', function () { more.hidden = true; });
    }
    document.addEventListener('keydown', function (e) {
      if (more && !more.hidden) { if (e.key === 'Escape') more.hidden = true; return; }
      if (e.target.closest('input, textarea, select')) return;
      if (e.key === 'ArrowRight') submit('right');
      if (e.key === 'ArrowLeft') submit('left');
    });
    // Also animate when the buttons are used
    [left, right].forEach(function (f) {
      f.addEventListener('submit', function (e) {
        if (submitted) return;
        e.preventDefault();
        submit(f === right ? 'right' : 'left');
      });
    });
  }

  // Slot ranking: tap a time to give it the next rank; tap again to remove it.
  var slotsForm = document.querySelector('[data-slots]');
  if (slotsForm) {
    var max = Number(slotsForm.getAttribute('data-max'));
    var rows = Array.prototype.slice.call(slotsForm.querySelectorAll('[data-slot]'));
    var selects = rows.map(function (r) { return r.querySelector('select'); });
    var paint = function () {
      rows.forEach(function (r, i) { r.classList.toggle('selected', selects[i].value !== ''); });
    };
    var renumber = function () {
      var picked = selects.filter(function (s) { return s.value !== ''; })
        .sort(function (a, b) { return Number(a.value) - Number(b.value); });
      picked.forEach(function (s, i) { s.value = String(i + 1); });
      paint();
    };
    rows.forEach(function (row, i) {
      row.addEventListener('click', function (e) {
        if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
        e.preventDefault();
        var s = selects[i];
        if (s.value !== '') {
          s.value = '';
        } else {
          var used = selects.filter(function (x) { return x.value !== ''; }).length;
          if (used >= max) return;
          s.value = String(used + 1);
        }
        renumber();
      });
      selects[i].addEventListener('change', paint);
    });
    var reset = slotsForm.querySelector('[data-slots-reset]');
    if (reset) reset.addEventListener('click', function () { selects.forEach(function (s) { s.value = ''; }); paint(); });
    paint();
  }

  // Upload progress for profile videos
  var up = document.querySelector('.upload-form');
  if (up && window.XMLHttpRequest && window.FormData) {
    up.addEventListener('submit', function (e) {
      e.preventDefault();
      var bar = up.querySelector('.upload-progress');
      var btn = up.querySelector('button[type=submit]');
      var xhr = new XMLHttpRequest();
      xhr.open('POST', up.action);
      xhr.upload.addEventListener('progress', function (ev) {
        if (ev.lengthComputable) { bar.hidden = false; bar.value = Math.round((ev.loaded / ev.total) * 100); }
      });
      xhr.addEventListener('load', function () { window.location.href = xhr.responseURL || '/profiel'; });
      xhr.addEventListener('error', function () {
        btn.disabled = false;
        alert('Uploaden mislukt. Controleer je verbinding en probeer opnieuw.');
      });
      btn.disabled = true;
      xhr.send(new FormData(up));
    });
  }
})();

// Maximaal aantal keuzes bij interesse-/taalknoppen
(function () {
  var limits = { interests: 12, languages: 8 };
  document.querySelectorAll('input[data-max-group]').forEach(function (box) {
    box.addEventListener('change', function () {
      var group = box.getAttribute('data-max-group');
      var checked = document.querySelectorAll('input[data-max-group="' + group + '"]:checked').length;
      if (checked > limits[group]) {
        box.checked = false;
        alert('Je kunt maximaal ' + limits[group] + ' keuzes maken.');
      }
    });
  });
})();
