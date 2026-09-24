import { describe, it, expect } from 'vitest';
import { parseCheckOutput, lastNonEmptyLine, summarizeCheckOutput } from '../../src/session/checks';

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
