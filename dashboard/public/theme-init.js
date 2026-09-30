// Runs before first paint (a classic script in <head>, which the CSP's
// script-src 'self' allows), so a saved light or dark choice is on <html>
// before the stylesheet applies. app.js owns the toggle; this only reads.
try {
  const saved = localStorage.getItem('opalixTheme');
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
} catch {
  // Blocked storage: follow the system preference.
}
