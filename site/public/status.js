// Reads the public liveness endpoint of the sandbox API and shows the result.
(function () {
  var API = 'https://opalix-sandbox.soubenz94.workers.dev/health';
  var card = document.getElementById('status');
  var text = document.getElementById('status-text');
  var time = document.getElementById('status-time');

  function show(state, label) {
    card.setAttribute('data-state', state);
    text.textContent = label;
    time.textContent = 'Checked ' + new Date().toLocaleString();
  }

  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, 8000);
  fetch(API, { cache: 'no-store', signal: ctl.signal })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (body) {
      if (body && body.ok === true) show('ok', 'All systems normal');
      else show('degraded', 'Degraded');
    })
    .catch(function () { show('degraded', 'Degraded'); })
    .then(function () { clearTimeout(timer); });
})();
