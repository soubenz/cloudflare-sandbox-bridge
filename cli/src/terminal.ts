import WebSocket from 'ws';

/**
 * Attaches the current TTY to a session's terminal over the WS relay
 * (src/session/terminal.ts). Raw stdin bytes go out as binary frames;
 * SIGWINCH sends a resize control frame (`\x01{"type":"resize",...}` — see
 * the relay's protocol comment).
 */
export function attachTerminal(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let stdinListener: ((chunk: Buffer) => void) | undefined;

    const sendResize = () => {
      const cols = process.stdout.columns ?? 80;
      const rows = process.stdout.rows ?? 24;
      ws.send('\x01' + JSON.stringify({ type: 'resize', cols, rows }));
    };

    ws.on('open', () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
      sendResize();
      process.on('SIGWINCH', sendResize);

      stdinListener = (chunk: Buffer) => ws.send(chunk);
      process.stdin.on('data', stdinListener);
    });

    ws.on('message', (data) => {
      process.stdout.write(data as Buffer);
    });

    const cleanup = () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      if (stdinListener) process.stdin.off('data', stdinListener);
      process.off('SIGWINCH', sendResize);
    };

    ws.on('close', () => {
      cleanup();
      resolve();
    });
    ws.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}
