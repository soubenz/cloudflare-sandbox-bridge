import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { terminalUrl } from './api.js';
import { monoFamily, windowPalette, withAlpha } from './palette.js';

/**
 * Attaches xterm.js to the session's terminal relay.
 *
 * The relay's protocol, which is not the SDK's: output arrives as raw binary
 * frames (the Worker consumes the container's JSON control frames and
 * forwards only bytes), and input goes back as raw binary. A text frame
 * beginning with \x01 is a control message — the only one the client
 * receives is `reset`, sent when the container was replaced under the
 * session and the shell is starting over.
 */
const CONTROL_PREFIX = '\x01';

export function attachTerminal({ container, sessionId, token, onNotice, onStatus, onInput }) {
  // The window's own colours (styles.css tokens), so the terminal is the same navy as the editor and the bar around it.
  const palette = windowPalette();
  const family = monoFamily();
  const term = new Terminal({
    fontFamily: family,
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    theme: {
      background: palette.terminal,
      foreground: palette.text,
      cursor: palette.accent,
      cursorAccent: palette.terminal,
      selectionBackground: withAlpha(palette.accent, 0.3),
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  safeFit();
  // The page's own monospace face may still be loading: measure again once it is, or the cells are sized for the fallback.
  document.fonts?.load?.("13px 'JetBrains Mono'")
    .then(() => {
      term.options.fontFamily = family;
      safeFit();
    })
    .catch(() => {});

  const encoder = new TextEncoder();
  let ws = null;
  let open = false;
  let disposed = false;
  let attempt = 0;
  let retryTimer = 0;
  let pingTimer = 0;
  // A drop is usually a deploy or a blip, not the end of the lab: try again after 1, 2, 4, then every 8
  // seconds, for about a minute, before handing the choice back to the learner (the Reconnect button).
  const RETRY_SECONDS = [1, 2, 4, 8, 8, 8, 8, 8];
  // Not input: the server ignores it for the idle clock. It only keeps the path warm and shows a dead one sooner.
  const PING_EVERY_MS = 25_000;
  let everOpened = false;

  function connect() {
    if (disposed) return;
    ws = new WebSocket(terminalUrl(sessionId, token));
    ws.binaryType = 'arraybuffer';
    const mine = ws;

    mine.onopen = () => {
      if (mine !== ws) return;
      open = true;
      // The shell lives in the lab, so a re-attach redraws it: start from a clean screen rather than stacking a copy.
      if (everOpened && attempt > 0) term.reset();
      everOpened = true;
      attempt = 0;
      onStatus?.('open');
      safeFit();
      sendResize();
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (open) ws.send(`${CONTROL_PREFIX}${JSON.stringify({ type: 'ping' })}`);
      }, PING_EVERY_MS);
      // Only take focus when the terminal is on screen: a reconnect after a
      // container restart would otherwise pull the cursor out of the editor
      // mid-keystroke, and send the next few keys to a shell nobody can see.
      if (container.offsetWidth) term.focus();
    };

    mine.onmessage = (event) => {
      if (typeof event.data === 'string') {
        if (event.data.startsWith(CONTROL_PREFIX)) {
          const msg = safeParse(event.data.slice(1));
          if (msg?.type === 'reset') {
            term.reset();
            onNotice?.('Your lab was restarted, so the terminal started over.');
          }
          return;
        }
        term.write(event.data);
        return;
      }
      term.write(new Uint8Array(event.data));
    };

    mine.onclose = (event) => {
      if (mine !== ws) return;
      open = false;
      clearInterval(pingTimer);
      if (disposed) return;
      if (attempt < RETRY_SECONDS.length) {
        const wait = RETRY_SECONDS[attempt];
        attempt += 1;
        onStatus?.('reconnecting');
        retryTimer = setTimeout(connect, wait * 1000);
        return;
      }
      // A blank black rectangle reads as a broken app. Say what happened.
      onStatus?.('closed');
      onNotice?.('The terminal lost its connection.');
    };

    mine.onerror = () => {
      // `close` follows an error and does the retrying; this only records that nothing is open.
      open = false;
    };
  }

  // Coming back to the tab, or the network returning, is a better moment to retry than a timer's.
  function retryNow() {
    if (disposed || open || !everOpened) return;
    if (ws && ws.readyState === WebSocket.CONNECTING) return;
    clearTimeout(retryTimer);
    attempt = 0;
    connect();
  }
  const onVisible = () => {
    if (document.visibilityState === 'visible') retryNow();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', retryNow);
  // No right-click menu on the terminal: the shell is the only thing in it.
  container.addEventListener('contextmenu', (event) => event.preventDefault());

  term.onData((data) => {
    // Typing is the learner saying they are there, whether or not the
    // socket is up to carry it (the server refreshes its idle clock itself).
    onInput?.();
    if (open) ws.send(encoder.encode(data));
  });

  function sendResize() {
    if (!open) return;
    ws.send(`${CONTROL_PREFIX}${JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })}`);
  }

  term.onResize(sendResize);
  connect();

  /**
   * Fitting a hidden terminal (the Brief tab is showing, so this view is
   * display:none) measures zero and would shrink the PTY to nothing, so
   * only fit something that is actually laid out.
   */
  function safeFit() {
    if (!container.offsetWidth || !container.offsetHeight) return;
    try {
      fit.fit();
    } catch {
      /* xterm not ready yet; the next resize fits it */
    }
  }

  /**
   * Refit whenever the terminal's own box changes, not only when the window
   * does: the side panes collapse at narrower widths, the operator's
   * activity pane comes and goes, and the view is revealed by a tab switch
   * — none of which fire a window resize. One fit per frame is plenty.
   */
  let frame = 0;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(safeFit);
  });
  observer.observe(container);

  return {
    term,
    refit: safeFit,
    focus: () => term.focus(),
    dispose() {
      disposed = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', retryNow);
      observer.disconnect();
      cancelAnimationFrame(frame);
      try {
        ws?.close();
      } catch {
        /* already closing */
      }
      term.dispose();
    },
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
