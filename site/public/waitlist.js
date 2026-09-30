// Progressive enhancement only: the form works without this.
(function () {
  var q = new URLSearchParams(location.search);
  var form = document.querySelector('.form-card');
  var plan = q.get('plan');
  if (plan === 'team' || plan === 'individual') {
    form.querySelector('input[name="plan"][value="' + plan + '"]').checked = true;
  }
  var from = q.get('from');
  if (from && /^[a-z0-9_-]{1,32}$/i.test(from)) form.elements.source.value = from;
  var e = q.get('e');
  var msg = e && form.querySelector('[data-error="' + e.replace(/[^a-z]/g, '') + '"]');
  if (msg) { msg.hidden = false; form.elements.email.focus(); }
  form.addEventListener('submit', function (ev) {
    if (!form.elements.email.checkValidity()) {
      ev.preventDefault();
      form.querySelectorAll('.form-error').forEach(function (m) { m.hidden = true; });
      form.querySelector('[data-error="email"]').hidden = false;
      form.elements.email.focus();
    }
  });
})();
