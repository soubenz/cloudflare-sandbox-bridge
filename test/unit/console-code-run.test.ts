import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeDom, type FakeDocument, type FakeElement } from '../fakes/fake-dom';

/**
 * The Run button on a lab brief's shell blocks (dashboard/src/code-copy.js), and the terminal's send()
 * it types with (dashboard/src/terminal.js).
 *
 * What is pinned here:
 *   - which blocks get Run: a ```bash / sh / shell / console block (data-lang, or a language-x class), in the
 *     brief, while there is a terminal; never a lesson's, never a plain or python block, never without a
 *     terminal, and refresh() takes it off when the terminal goes and puts it back when it comes;
 *   - the commands a block runs: no blank lines, no # comments, no `$ ` prompt, one per line, and only the
 *     prompted lines of a transcript;
 *   - what is sent: Ctrl-E Ctrl-U, then each line with '\r', and the terminal is shown;
 *   - a terminal that is not connected: nothing is sent, nothing is shown, and the button says
 *     "Terminal not ready" for a moment;
 *   - terminal.js send(): false (and nothing on the wire) until the socket is open, the bytes once it is.
 */

type Opts = { terminal?: () => { send: (t: string) => boolean } | null; showTerminal?: () => void };
const CC = (await import('../../dashboard/src/code-copy.js' as string)) as {
  SHELL_LANGS: Set<string>;
  CLEAR_LINE: string;
  blockLang: (pre: FakeElement) => string;
  isShellBlock: (pre: FakeElement) => boolean;
  canRun: (pre: FakeElement, terminal?: Opts['terminal']) => boolean;
  commandLines: (text: string) => string[];
  hasPlaceholder: (lines: string[]) => boolean;
  sendCommands: (send: (t: string) => boolean, lines: string[]) => boolean;
  decorateBlocks: (root: FakeElement, opts?: Opts) => void;
  installCodeCopy: (root: FakeElement, opts?: Opts) => { dispose: () => void; refresh: () => void };
};

let dom: ReturnType<typeof installFakeDom>;
let doc: FakeDocument;

/** A <pre><code> with `text`, its fence language as data-lang (as both renderers draw it), inside a `.cls` container. */
function block(text: string, { lang = 'bash', cls = 'brief', attr = 'data-lang' }: { lang?: string; cls?: string; attr?: 'data-lang' | 'class' } = {}) {
  const host = doc.createElement(cls === 'brief' ? 'article' : 'div');
  host.className = cls;
  const pre = doc.createElement('pre');
  const code = doc.createElement('code');
  if (lang) {
    if (attr === 'data-lang') pre.setAttribute('data-lang', lang);
    else code.className = `language-${lang}`;
  }
  code.textContent = text;
  pre.append(code);
  host.append(pre);
  doc.body.append(host);
  return { host, pre };
}

/** A terminal that records what it was sent; `open` says whether its socket is up. */
function fakeTerminal(open = true) {
  const sent: string[] = [];
  return { sent, open, send: vi.fn((t: string) => (open ? (sent.push(t), true) : false)) };
}

const run = (pre: FakeElement) => pre.querySelector('.code-run');
const runLabel = (pre: FakeElement) => pre.querySelector('.code-run-label')!.textContent;

beforeEach(() => {
  dom = installFakeDom();
  doc = dom.document;
});
afterEach(() => {
  vi.useRealTimers();
  dom.restore();
});

// ----------------------------------------------------------------- which blocks

describe('which blocks get Run', () => {
  it('a shell block in the brief with a terminal: bash, sh, shell and console, any case, from data-lang or a language- class', () => {
    expect([...CC.SHELL_LANGS].sort()).toEqual(['bash', 'console', 'sh', 'shell']);
    const term = fakeTerminal();
    for (const lang of ['bash', 'sh', 'shell', 'console', 'BASH']) {
      const { pre } = block('ls', { lang });
      expect(CC.canRun(pre, () => term)).toBe(true);
    }
    const { pre } = block('ls', { lang: 'sh', attr: 'class' });
    expect(CC.blockLang(pre)).toBe('sh');
    expect(CC.canRun(pre, () => term)).toBe(true);
  });

  it('not a block of another language, or of none', () => {
    const term = fakeTerminal();
    for (const lang of ['', 'python', 'yaml', 'json', 'bashrc']) {
      const { pre } = block('ls', { lang });
      expect(CC.isShellBlock(pre)).toBe(false);
      expect(CC.canRun(pre, () => term)).toBe(false);
    }
  });

  it('not outside the brief: a lesson, the pre-lab flow, the story', () => {
    const term = fakeTerminal();
    for (const cls of ['lesson-body', 'learn-prose', 'lessons']) {
      const { pre } = block('ls', { cls });
      expect(CC.canRun(pre, () => term)).toBe(false);
      CC.decorateBlocks(doc.body, { terminal: () => term });
      // It is still copied, just not run.
      expect(pre.querySelector('.code-copy')).not.toBeNull();
      expect(run(pre)).toBeNull();
    }
  });

  it('not without a terminal (no session, or an ended one), nor for a block with nothing to run', () => {
    const { pre } = block('ls');
    expect(CC.canRun(pre)).toBe(false);
    expect(CC.canRun(pre, () => null)).toBe(false);
    const { pre: comments } = block('# only a comment\n\n');
    expect(CC.canRun(comments, () => fakeTerminal())).toBe(false);
  });

  it('not a block with a <placeholder> in a command: the whole block gets Copy only', () => {
    const term = fakeTerminal();
    const { pre } = block('python3 -B platform/onboard.py growth\npython3 -B platform/onboard.py <team-name>');
    expect(CC.canRun(pre, () => term)).toBe(false);
    CC.decorateBlocks(doc.body, { terminal: () => term });
    expect(pre.querySelector('.code-copy')).not.toBeNull();
    expect(run(pre)).toBeNull();
    // A placeholder in a comment is not run, so it does not count.
    const { pre: commented } = block('# replace <team-name> with yours\nls');
    expect(CC.canRun(commented, () => term)).toBe(true);
  });

  it('what counts as a placeholder, and what is a heredoc or a redirect', () => {
    for (const line of [
      'python3 -B platform/onboard.py <team-name>',
      "psql -c \"select 1 where id = '<the id you got back>';\"",
      'curl <URL>',
      'echo <x>',
      'run <name_2>',
    ]) {
      expect(CC.hasPlaceholder([line]), line).toBe(true);
    }
    for (const line of [
      'python3 run_tool.py --label some-name < program.py',
      'sort <in >out',
      'cat <<EOF',
      'cat <<EOF>',
      'diff <(ls a) <(ls b)',
      'echo "a < b > c"',
      'echo <1x>',
      'echo <>',
      'python3 -B send_calls.py support "hello gateway"',
    ]) {
      expect(CC.hasPlaceholder([line]), line).toBe(false);
    }
  });

  it('decorating adds Run beside Copy, in one row, Run first; a lesson block keeps Copy alone', () => {
    const term = fakeTerminal();
    const { pre } = block('python3 -B send_calls.py support "hello gateway"');
    const { pre: lesson } = block('ls', { cls: 'lesson-body' });
    CC.decorateBlocks(doc.body, { terminal: () => term });
    expect(pre.classList.contains('has-copy')).toBe(true);
    expect(pre.classList.contains('has-run')).toBe(true);
    const row = pre.querySelector('.code-actions')!;
    expect(row.children.map((b) => b.className)).toEqual(['code-run', 'code-copy']);
    const button = run(pre)!;
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('Run this in the terminal');
    expect(runLabel(pre)).toBe('Run');
    expect(lesson.classList.contains('has-run')).toBe(false);
    expect(lesson.querySelector('.code-actions')).toBeNull();
    // What Copy copies is still only the code.
    expect(pre.querySelector('code')!.textContent).toBe('python3 -B send_calls.py support "hello gateway"');
  });

  it('refresh() takes Run off when the terminal goes (Copy goes back to its corner) and puts it back when it comes', () => {
    const g = globalThis as Record<string, unknown>;
    const before = g.MutationObserver;
    g.MutationObserver = class {
      observe() {}
      disconnect() {}
    };
    try {
      let term: ReturnType<typeof fakeTerminal> | null = null;
      const { pre } = block('ls');
      const blocks = CC.installCodeCopy(doc.body, { terminal: () => term });
      expect(pre.querySelector('.code-copy')).not.toBeNull();
      expect(run(pre)).toBeNull();
      term = fakeTerminal();
      blocks.refresh();
      expect(run(pre)).not.toBeNull();
      expect(pre.querySelectorAll('.code-run')).toHaveLength(1);
      blocks.refresh();
      expect(pre.querySelectorAll('.code-run')).toHaveLength(1);
      term = null;
      blocks.refresh();
      expect(run(pre)).toBeNull();
      expect(pre.querySelector('.code-actions')).toBeNull();
      expect(pre.classList.contains('has-run')).toBe(false);
      expect(pre.children.map((c) => c.className)).toEqual(['', 'code-copy']);
      blocks.dispose();
    } finally {
      g.MutationObserver = before;
    }
  });
});

// ------------------------------------------------------------ the commands

describe('the commands a block runs', () => {
  it('one per line, without blank lines or # comments', () => {
    expect(CC.commandLines('python3 -B send_calls.py support "hello gateway"\npython3 -B send_calls.py fast "hello gateway"')).toEqual([
      'python3 -B send_calls.py support "hello gateway"',
      'python3 -B send_calls.py fast "hello gateway"',
    ]);
    expect(CC.commandLines('# send one call\n\ncurl -s localhost:4000/health\n   \n  # indented comment\nls -la\n')).toEqual(['curl -s localhost:4000/health', 'ls -la']);
    // A # later in the line is the command's own.
    expect(CC.commandLines('echo "#1" # trailing')).toEqual(['echo "#1" # trailing']);
    expect(CC.commandLines('')).toEqual([]);
    expect(CC.commandLines('\r\nls\r\n')).toEqual(['ls']);
  });

  it('a `$ ` prompt is taken off, and in a transcript only the prompted lines run (the rest is output)', () => {
    expect(CC.commandLines('$ ls\n$ cat brief.md')).toEqual(['ls', 'cat brief.md']);
    expect(CC.commandLines('$ curl -s localhost:4000/health\n{"status": "ok"}\n\n$ echo done\ndone')).toEqual(['curl -s localhost:4000/health', 'echo done']);
    expect(CC.commandLines('$ # a comment after a prompt')).toEqual([]);
    // Only a `$ ` with its space is a prompt.
    expect(CC.commandLines('$HOME/bin/tool')).toEqual(['$HOME/bin/tool']);
  });
});

// --------------------------------------------------------------- the sending

describe('what Run sends', () => {
  it('Ctrl-E Ctrl-U to clear the half-typed line, then each line followed by Enter', () => {
    expect(CC.CLEAR_LINE).toBe('\x05\x15');
    const term = fakeTerminal();
    expect(CC.sendCommands(term.send, ['ls', 'echo hi'])).toBe(true);
    expect(term.sent).toEqual(['\x05\x15', 'ls\r', 'echo hi\r']);
    // Nothing to run sends nothing.
    const idle = fakeTerminal();
    expect(CC.sendCommands(idle.send, [])).toBe(false);
    expect(idle.send).not.toHaveBeenCalled();
  });

  it('a click types the block into the terminal, shows the terminal and reads "Running" for a moment', () => {
    vi.useFakeTimers();
    const term = fakeTerminal();
    const showTerminal = vi.fn();
    const { pre } = block('# start here\npython3 -B send_calls.py support "hello gateway"\n\npython3 -B send_calls.py fast "hello gateway"');
    CC.decorateBlocks(doc.body, { terminal: () => term, showTerminal });
    run(pre)!.click();
    expect(term.sent).toEqual(['\x05\x15', 'python3 -B send_calls.py support "hello gateway"\r', 'python3 -B send_calls.py fast "hello gateway"\r']);
    expect(showTerminal).toHaveBeenCalledTimes(1);
    expect(runLabel(pre)).toBe('Running');
    expect(run(pre)!.dataset.state).toBe('running');
    vi.advanceTimersByTime(2000);
    expect(runLabel(pre)).toBe('Run');
    expect(run(pre)!.dataset.state).toBeUndefined();
    expect(run(pre)!.getAttribute('aria-label')).toBe('Run this in the terminal');
  });

  it('a terminal that is not connected: nothing is sent or shown, and the button says "Terminal not ready" for a moment', () => {
    vi.useFakeTimers();
    const term = fakeTerminal(false);
    const showTerminal = vi.fn();
    const { pre } = block('ls\npwd');
    CC.decorateBlocks(doc.body, { terminal: () => term, showTerminal });
    run(pre)!.click();
    // Only the first write was tried, and refused: no command went after it.
    expect(term.send).toHaveBeenCalledTimes(1);
    expect(term.send).toHaveBeenCalledWith('\x05\x15');
    expect(term.sent).toEqual([]);
    expect(showTerminal).not.toHaveBeenCalled();
    expect(runLabel(pre)).toBe('Terminal not ready');
    expect(run(pre)!.dataset.state).toBe('not-ready');
    expect(run(pre)!.getAttribute('aria-label')).toMatch(/not connected/);
    vi.advanceTimersByTime(2000);
    expect(runLabel(pre)).toBe('Run');
  });

  it('a terminal that went away between drawing and clicking is "not ready" too', () => {
    let term: ReturnType<typeof fakeTerminal> | null = fakeTerminal();
    const showTerminal = vi.fn();
    const { pre } = block('ls');
    CC.decorateBlocks(doc.body, { terminal: () => term, showTerminal });
    term = null;
    run(pre)!.click();
    expect(showTerminal).not.toHaveBeenCalled();
    expect(runLabel(pre)).toBe('Terminal not ready');
  });
});

// ------------------------------------------------------ terminal.js send()

describe('the terminal’s send()', () => {
  it('writes the bytes only while the socket is open, and says whether it did', async () => {
    vi.resetModules();
    vi.doMock('@xterm/xterm', () => ({
      Terminal: class {
        options: Record<string, unknown> = {};
        cols = 80;
        rows = 24;
        loadAddon() {}
        open() {}
        onData() {}
        onResize() {}
        focus() {}
        reset() {}
        write() {}
        dispose() {}
      },
    }));
    vi.doMock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
    vi.doMock('../../dashboard/src/api.js', () => ({ terminalUrl: () => 'wss://example.test/terminal' }));
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      static OPEN = 1;
      readyState = 0;
      sent: unknown[] = [];
      binaryType = '';
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) {
        sockets.push(this);
      }
      send(data: unknown) {
        this.sent.push(data);
      }
      close() {}
    }
    const g = globalThis as Record<string, any>;
    const saved = { WebSocket: g.WebSocket, ResizeObserver: g.ResizeObserver, window: g.window, raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame };
    g.WebSocket = FakeSocket;
    g.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    g.window = { addEventListener() {}, removeEventListener() {} };
    g.requestAnimationFrame = () => 0;
    g.cancelAnimationFrame = () => {};
    try {
      const { attachTerminal } = (await import('../../dashboard/src/terminal.js' as string)) as {
        attachTerminal: (o: Record<string, unknown>) => { send: (t: string) => boolean; dispose: () => void };
      };
      const onInput = vi.fn();
      const t = attachTerminal({ container: doc.createElement('div'), sessionId: 's', token: 't', onInput });
      const ws = sockets[0]!;
      // Not open yet: refused, nothing sent.
      expect(t.send('\x05\x15')).toBe(false);
      expect(ws.sent).toEqual([]);
      ws.readyState = FakeSocket.OPEN;
      ws.onopen!();
      const before = ws.sent.length; // the open sends its size first
      expect(t.send('\x05\x15')).toBe(true);
      expect(t.send('ls\r')).toBe(true);
      const typed = ws.sent.slice(before).map((d) => new TextDecoder().decode(d as Uint8Array));
      expect(typed).toEqual(['\x05\x15', 'ls\r']);
      // Typing for the learner is the learner being there.
      expect(onInput).toHaveBeenCalled();
      // Gone again: refused.
      ws.readyState = 3;
      ws.onclose!();
      expect(t.send('pwd\r')).toBe(false);
      t.dispose();
      expect(t.send('pwd\r')).toBe(false);
    } finally {
      Object.assign(g, { WebSocket: saved.WebSocket, ResizeObserver: saved.ResizeObserver, window: saved.window, requestAnimationFrame: saved.raf, cancelAnimationFrame: saved.caf });
      vi.doUnmock('@xterm/xterm');
      vi.doUnmock('@xterm/addon-fit');
      vi.doUnmock('../../dashboard/src/api.js');
    }
  });
});
