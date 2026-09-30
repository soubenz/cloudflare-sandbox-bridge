// Progressive enhancement only: the form works without this.
(function () {
  var q = new URLSearchParams(location.search);
  var form = document.querySelector('.form-card');
  var from = q.get('from');
  if (from && /^[a-z0-9_-]{1,32}$/i.test(from)) form.elements.source.value = from;
  var e = q.get('e');
  var msg = e && form.querySelector('[data-error="' + e.replace(/[^a-z]/g, '') + '"]');
  if (msg) msg.hidden = false;
  form.addEventListener('submit', function (ev) {
    if (!form.querySelector('input[name="rating"]:checked')) {
      ev.preventDefault();
      form.querySelectorAll('.form-error').forEach(function (m) { m.hidden = true; });
      form.querySelector('[data-error="rating"]').hidden = false;
      form.querySelector('input[name="rating"]').focus();
    }
  });
})();
