import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { terminalUrl } from './api.js';

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

export function attachTerminal({ container, sessionId, token, onNotice, onStatus }) {
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    theme: {
      background: '#0b0e13',
      foreground: '#e6e9ef',
      cursor: '#6aaee8',
      cursorAccent: '#0b0e13',
      selectionBackground: 'rgba(106, 174, 232, 0.35)',
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  safeFit();

  const ws = new WebSocket(terminalUrl(sessionId, token));
  ws.binaryType = 'arraybuffer';
  const encoder = new TextEncoder();
  let open = false;

  ws.onopen = () => {
    open = true;
    onStatus?.('open');
    safeFit();
    sendResize();
    // Only take focus when the terminal is on screen: a reconnect after a
    // container restart would otherwise pull the cursor out of the editor
    // mid-keystroke, and send the next few keys to a shell nobody can see.
    if (container.offsetWidth) term.focus();
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      if (event.data.startsWith(CONTROL_PREFIX)) {
        const msg = safeParse(event.data.slice(1));
        if (msg?.type === 'reset') {
          term.reset();
          onNotice?.('The container was replaced; the shell has restarted.');
        }
        return;
      }
      term.write(event.data);
      return;
    }
    term.write(new Uint8Array(event.data));
  };

  ws.onclose = (event) => {
    open = false;
    // A blank black rectangle reads as a broken app. Say what happened.
    onStatus?.('closed', event.reason || `closed (${event.code})`);
    onNotice?.('Terminal disconnected.');
  };

  ws.onerror = () => {
    open = false;
    onStatus?.('closed', 'could not connect');
  };

  term.onData((data) => {
    if (open) ws.send(encoder.encode(data));
  });

  function sendResize() {
    if (!open) return;
    ws.send(`${CONTROL_PREFIX}${JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })}`);
  }

  term.onResize(sendResize);

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
      observer.disconnect();
      cancelAnimationFrame(frame);
      try {
        ws.close();
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
