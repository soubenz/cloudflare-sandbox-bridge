/**
 * A "Copy" button on every code block a learner reads: the lab brief and the lessons.
 *
 * The blocks are rendered by the markdown helpers as plain <pre><code>; rather than touch every
 * place that renders one, this watches the page and adds the button to any block it has not seen,
 * so a block that appears later (a tab opened, the next lesson drawn) gets one too. Blocks that are
 * not meant to be copied (the log tail, the comic's text) are left alone: only the containers named
 * in SCOPE are decorated.
 */

/** Where a code block is something to copy: the brief, a lesson, the story as text. */
const SCOPE = '.brief, .learn-prose, .lesson-body, .lessons';
const DONE = 'data-copy-ready';

/** The text a block copies: its code, exactly as written, without the button's own label. */
export function codeText(pre) {
  const code = pre.querySelector('code');
  return (code ?? pre).textContent.replace(/\n$/, '');
}

/** Writes text to the clipboard; resolves false where the browser will not allow it. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the selection route */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function decorate(pre) {
  if (pre.hasAttribute(DONE) || !pre.closest(SCOPE) || pre.classList.contains('logs-tail')) return;
  pre.setAttribute(DONE, '1');
  pre.classList.add('has-copy');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'code-copy';
  button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg><span class="code-copy-label">Copy</span>';
  button.setAttribute('aria-label', 'Copy this code');
  let timer;
  button.addEventListener('click', async () => {
    const ok = await copyText(codeText(pre));
    const label = button.querySelector('.code-copy-label');
    label.textContent = ok ? 'Copied' : 'Press Ctrl+C';
    button.dataset.state = ok ? 'copied' : 'failed';
    button.setAttribute('aria-label', ok ? 'Code copied' : 'Could not copy; select the code and press Ctrl+C');
    clearTimeout(timer);
    timer = setTimeout(() => {
      label.textContent = 'Copy';
      delete button.dataset.state;
      button.setAttribute('aria-label', 'Copy this code');
    }, 2000);
  });
  pre.append(button);
}

function sweep(root) {
  if (root.nodeType !== 1) return;
  if (root.matches?.('pre')) decorate(root);
  root.querySelectorAll?.('pre').forEach(decorate);
}

/** Starts decorating code blocks now and as they appear. Safe to call once at start-up. */
export function installCodeCopy(root = document.body) {
  sweep(root);
  const observer = new MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach(sweep);
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
