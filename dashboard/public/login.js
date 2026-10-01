// The login page's script, served as a static file so the page's CSP can say
// `script-src 'self'` with no inline exceptions. The Worker lets exactly this
// one path through the password gate (see worker.js).
//
// After a successful sign-in the learner goes back to the page they asked for.
// The Worker serves this form at the requested URL and names that page in
// <meta name="return-to"> (a path of this console, validated server-side by
// return-path.js); it is checked once more here, because a redirect target is
// the one thing on this page worth not trusting twice.
function returnTo() {
  const meta = document.querySelector('meta[name="return-to"]');
  const next = meta ? meta.getAttribute('content') || '/' : '/';
  const ok = next.charAt(0) === '/' && next.charAt(1) !== '/' && next.indexOf('\\') === -1 && !/[\u0000-\u001f\u007f]/.test(next);
  return ok ? next : '/';
}

document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('pw').value }),
  });
  if (res.ok) {
    const next = returnTo();
    // The same address: reload. Another (a ?next= link): replace, so Back does not return to the form.
    if (next === location.pathname + location.search) location.reload();
    else location.replace(next);
  } else if (res.status === 401) err.textContent = 'Wrong password.';
  else if (res.status === 429) err.textContent = 'Too many attempts — try again in a minute';
  else err.textContent = 'Could not sign in (' + res.status + ').';
});
