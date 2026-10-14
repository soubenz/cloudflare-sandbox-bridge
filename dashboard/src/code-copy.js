/**
 * A "Copy" button on every code block a learner reads: the lab brief and the lessons, and a "Run"
 * button beside it on the brief's shell blocks while the lab's terminal is open.
 *
 * The blocks are rendered by the markdown helpers as plain <pre><code>; rather than touch every
 * place that renders one, this watches the page and adds the button to any block it has not seen,
 * so a block that appears later (a tab opened, the next lesson drawn) gets one too. Blocks that are
 * not meant to be copied (the log tail, the comic's text) are left alone: only the containers named
 * in SCOPE are decorated.
 *
 * Run types the block's commands into the lab's terminal and presses Enter. It is only offered where
 * that makes sense: a ```bash (sh, shell, console) block, in the brief (RUN_SCOPE), while the page has a
 * terminal to type into (the `terminal` option of installCodeCopy). Lessons, the pre-lab flow and the
 * story are read before a lab exists, so they never get one.
 */

/** Where a code block is something to copy: the brief, a lesson, the story as text. */
const SCOPE = '.brief, .learn-prose, .lesson-body, .lessons';
/** Where a shell block is something to run: the brief of a running lab, and nowhere else. */
const RUN_SCOPE = '.brief';
/** The fence languages that are commands for the lab's shell. */
export const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'console']);
const DONE = 'data-copy-ready';
/** Ctrl-E then Ctrl-U: to the end of the line, then cut it, so a half-typed command is not run with ours. */
export const CLEAR_LINE = '\x05\x15';
const RUN_LABEL = 'Run this in the terminal';
const PLAY_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M7 4.8v14.4a1 1 0 0 0 1.52.85l11.5-7.2a1 1 0 0 0 0-1.7L8.52 3.95A1 1 0 0 0 7 4.8z"/></svg>';

/** The fence language of a block (data-lang on the <pre> or its <code>, or a `language-x` class), lower case; '' when it has none. */
export function blockLang(pre) {
  const code = pre.querySelector('code');
  const from = (el) => {
    if (!el) return '';
    const lang = el.getAttribute('data-lang');
    if (lang) return lang;
    const cls = /(?:^|\s)language-([\w+-]+)/.exec(el.getAttribute('class') || '');
    return cls ? cls[1] : '';
  };
  return (from(pre) || from(code)).toLowerCase();
}

/** Whether a block is shell commands: its fence said bash, sh, shell or console. */
export function isShellBlock(pre) {
  return SHELL_LANGS.has(blockLang(pre));
}

/**
 * A `<placeholder>` for the learner to fill in (`<team-name>`, `<the id you got back>`): angle brackets
 * around letters, digits, spaces, `-` and `_`, starting with a letter and not ending in a space. A heredoc
 * (`<<EOF`) and a redirect (`< file`, `<in >out`) are not one.
 */
const PLACEHOLDER = /(?<!<)<[A-Za-z](?:[A-Za-z0-9 _-]*[A-Za-z0-9_-])?>/;

/** Whether any of the commands has a placeholder in it: typed as it is, it would fail (or redirect). */
export function hasPlaceholder(lines) {
  return lines.some((line) => PLACEHOLDER.test(line));
}

/**
 * Whether a block may carry a Run button: a shell block in the brief, with a terminal to type into, and
 * commands that can run as written (at least one, and no placeholder: that block gets Copy only).
 */
export function canRun(pre, terminal) {
  if (!isShellBlock(pre) || !pre.closest(RUN_SCOPE) || !terminal?.()) return false;
  const lines = commandLines(codeText(pre));
  return lines.length > 0 && !hasPlaceholder(lines);
}

/**
 * The commands a shell block runs, one per line: blank lines and `#` comments are dropped and a `$ `
 * prompt is taken off. A block that shows prompts (a `console` transcript) runs only its prompted
 * lines; the others are the output it shows.
 */
export function commandLines(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const prompt = /^\s*\$ /;
  const prompted = lines.some((l) => prompt.test(l));
  const out = [];
  for (const raw of lines) {
    if (prompted && !prompt.test(raw)) continue;
    const line = raw.replace(prompt, '').trim();
    if (!line || line.startsWith('#')) continue;
    out.push(line);
  }
  return out;
}

/**
 * Types `lines` into a terminal and presses Enter after each: the half-typed line is cleared first
 * (CLEAR_LINE). `send(text)` returns false when nothing could be sent (the terminal is not connected);
 * then nothing more is sent and this returns false.
 */
export function sendCommands(send, lines) {
  if (!lines.length || !send(CLEAR_LINE)) return false;
  for (const line of lines) send(`${line}\r`);
  return true;
}

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

/**
 * The Run button: types the block's commands into the terminal (`terminal()` returns it, or null),
 * after `showTerminal()` has put the terminal on screen. Says "Running", or "Terminal not ready" when
 * the terminal is not connected (and then sends nothing and shows nothing).
 */
function runButton(pre, { terminal, showTerminal }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'code-run';
  button.innerHTML = PLAY_ICON;
  const label = document.createElement('span');
  label.className = 'code-run-label';
  label.textContent = 'Run';
  button.append(label);
  button.setAttribute('aria-label', RUN_LABEL);
  let timer;
  button.addEventListener('click', () => {
    const term = terminal?.();
    const lines = commandLines(codeText(pre));
    const ok = Boolean(term) && sendCommands((text) => term.send(text), lines);
    if (ok) showTerminal?.();
    label.textContent = ok ? 'Running' : 'Terminal not ready';
    button.dataset.state = ok ? 'running' : 'not-ready';
    button.setAttribute('aria-label', ok ? 'Sent to the terminal' : 'The terminal is not connected yet; try again in a moment');
    clearTimeout(timer);
    timer = setTimeout(() => {
      label.textContent = 'Run';
      delete button.dataset.state;
      button.setAttribute('aria-label', RUN_LABEL);
    }, 2000);
  });
  return button;
}

/**
 * Adds the Run button to a decorated block that may have one, and takes it off one that may not (any
 * more). With Run, the two buttons sit in one row (.code-actions), Run first and Copy in its corner.
 */
function syncRun(pre, opts) {
  const actions = pre.querySelector('.code-actions');
  const want = canRun(pre, opts.terminal);
  if (want && !actions) {
    const row = document.createElement('div');
    row.className = 'code-actions';
    row.append(runButton(pre, opts));
    const copy = pre.querySelector('.code-copy');
    if (copy) row.append(copy);
    pre.classList.add('has-run');
    pre.append(row);
  } else if (!want && actions) {
    const copy = actions.querySelector('.code-copy');
    if (copy) pre.append(copy);
    actions.remove();
    pre.classList.remove('has-run');
  }
}

function decorate(pre, opts) {
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
  syncRun(pre, opts);
}

/** Decorates every block in `root` (and `root` itself when it is one) that is not decorated yet. */
export function decorateBlocks(root, opts = {}) {
  if (root.nodeType !== 1) return;
  if (root.matches?.('pre')) decorate(root, opts);
  root.querySelectorAll?.('pre').forEach((pre) => decorate(pre, opts));
}

/**
 * Starts decorating code blocks now and as they appear. Safe to call once at start-up.
 *
 *   terminal      () => the open lab's terminal ({ send(text) → boolean }), or null when there is none
 *   showTerminal  () => puts the terminal on screen (called on a Run that was sent)
 *
 * Returns { dispose, refresh }: call refresh() when the terminal comes or goes, so the brief's Run
 * buttons follow it.
 */
export function installCodeCopy(root = document.body, opts = {}) {
  decorateBlocks(root, opts);
  const observer = new MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach((n) => decorateBlocks(n, opts));
  });
  observer.observe(root, { childList: true, subtree: true });
  return {
    dispose: () => observer.disconnect(),
    refresh: () => root.querySelectorAll(`pre[${DONE}]`).forEach((pre) => syncRun(pre, opts)),
  };
}
