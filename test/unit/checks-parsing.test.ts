import { describe, it, expect } from 'vitest';
import { parseCheckOutput, lastNonEmptyLine, summarizeCheckOutput, classifyCheckError } from '../../src/session/checks';

describe('parseCheckOutput', () => {
  it('parses a JSON result line', () => {
    const result = parseCheckOutput('some log line\n{"pass": true, "message": "all good"}');
    expect(result).toEqual({ pass: true, message: 'all good' });
  });

  it('returns undefined for plain-text output', () => {
    expect(parseCheckOutput('just some log output\nok')).toBeUndefined();
  });

  it('returns undefined for JSON missing pass/message', () => {
    expect(parseCheckOutput('{"foo": "bar"}')).toBeUndefined();
  });

  it('returns undefined for empty output', () => {
    expect(parseCheckOutput('')).toBeUndefined();
  });
});

describe('lastNonEmptyLine', () => {
  it('returns the last non-blank line', () => {
    expect(lastNonEmptyLine('a\nb\n\n  \nc\n')).toBe('c');
  });

  it('returns undefined when every line is blank', () => {
    expect(lastNonEmptyLine('\n  \n\n')).toBeUndefined();
  });
});

describe('summarizeCheckOutput', () => {
  it('does not staple the stderr tail onto a check the script reported as passing', () => {
    const result = summarizeCheckOutput({
      stdout: '{"pass": true, "message": "all good"}',
      stderr: 'warning: noisy teardown failed',
      exitCode: 1,
      timedOut: false,
    });
    expect(result.pass).toBe(true);
    expect(result.message).toBe('all good');
  });

  it('appends the stderr tail when the script reported a failure despite exit 0', () => {
    const result = summarizeCheckOutput({
      stdout: '{"pass": false, "message": "port 8000 closed"}',
      stderr: 'connect: connection refused',
      exitCode: 0,
      timedOut: false,
    });
    expect(result.pass).toBe(false);
    expect(result.message).toBe('port 8000 closed\nconnect: connection refused');
  });

  it('falls back to the exit status when there is no JSON result line', () => {
    expect(summarizeCheckOutput({ stdout: 'done', stderr: '', exitCode: 0, timedOut: false })).toEqual({
      pass: true,
      message: 'done',
    });
    expect(summarizeCheckOutput({ stdout: '', stderr: 'boom', exitCode: 2, timedOut: false })).toEqual({
      pass: false,
      message: 'failed\nboom',
    });
  });

  it('treats a timeout as a failure even on exit 0', () => {
    expect(summarizeCheckOutput({ stdout: '', stderr: '', exitCode: 0, timedOut: true }).pass).toBe(false);
  });
});

describe('classifyCheckError', () => {
  /**
   * What actually reaches runOneCheck's catch when `proc.output({ timeout })`
   * overruns: the SDK's ProcessWaitTimeoutError, flattened by Workers RPC to
   * an error carrying only `name` and `message` (the class is gone, so
   * `instanceof` is not available to the catch).
   */
  function rpcFlattenedTimeout(timeoutMs: number): Error {
    const err = new Error(`Process output did not complete within ${timeoutMs}ms`);
    err.name = 'ProcessWaitTimeoutError';
    return err;
  }

  it('reports a check that overran its timeout as timed out', () => {
    const result = classifyCheckError(rpcFlattenedTimeout(60_000), 60);
    expect(result.timed_out).toBe(true);
  });

  it('blames timeout_s rather than repeating the SDK wording', () => {
    const result = classifyCheckError(rpcFlattenedTimeout(60_000), 60);
    expect(result.message).toContain('timeout_s');
    expect(result.message).toContain('60');
    expect(result.message).not.toContain('Process output did not complete');
  });

  it('leaves a genuinely broken check reported as an error, not a timeout', () => {
    const result = classifyCheckError(new Error('bash: no such file or directory'), 30);
    expect(result.timed_out).toBe(false);
    expect(result.message).toBe('check errored: Error: bash: no such file or directory');
  });

  it('does not mistake another SDK error for a timeout', () => {
    const err = new Error('The container was replaced');
    err.name = 'StaleProcessHandleError';
    expect(classifyCheckError(err, 30).timed_out).toBe(false);
  });

  it('handles a non-Error throw', () => {
    expect(classifyCheckError('boom', 30)).toEqual({ timed_out: false, message: 'check errored: boom' });
  });
});
