import { describe, it, expect } from 'vitest';
import { parseCheckOutput, lastNonEmptyLine } from '../../src/session/checks';

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
