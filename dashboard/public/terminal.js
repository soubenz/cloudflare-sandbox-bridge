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

export function attachTerminal({ container, sessionId, token, onNotice }) {
  const term = new window.Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: { background: '#0b0e13', foreground: '#e6e9ef', cursor: '#5b9dd9' },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();

  const ws = new WebSocket(terminalUrl(sessionId, token));
  ws.binaryType = 'arraybuffer';
  const encoder = new TextEncoder();
  let open = false;

  ws.onopen = () => {
    open = true;
    sendResize();
    term.focus();
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

  ws.onclose = () => {
    open = false;
    onNotice?.('Terminal disconnected.');
  };

  term.onData((data) => {
    if (open) ws.send(encoder.encode(data));
  });

  function sendResize() {
    if (!open) return;
    ws.send(`${CONTROL_PREFIX}${JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })}`);
  }

  term.onResize(sendResize);

  const onWindowResize = () => {
    fit.fit();
  };
  window.addEventListener('resize', onWindowResize);

  return {
    term,
    refit: () => fit.fit(),
    dispose() {
      window.removeEventListener('resize', onWindowResize);
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
