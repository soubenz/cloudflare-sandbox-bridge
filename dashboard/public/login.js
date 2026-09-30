// The login page's script, served as a static file so the page's CSP can say
// `script-src 'self'` with no inline exceptions. The Worker lets exactly this
// one path through the password gate (see worker.js).
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('pw').value }),
  });
  if (res.ok) location.reload();
  else if (res.status === 401) err.textContent = 'Wrong password.';
  else if (res.status === 429) err.textContent = 'Too many attempts — try again in a minute';
  else err.textContent = 'Could not sign in (' + res.status + ').';
});
