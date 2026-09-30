import { describe, it, expect, vi } from 'vitest';
import { parsePoolSchedule, resolvePoolTarget } from '../../src/lib/pool-schedule';

const SCHED = 'mon-fri 07-21=1; *=0';
// 2026-09-28 is a Monday, 2026-10-03 a Saturday, 2026-10-04 a Sunday.
const at = (iso: string) => new Date(`${iso}:00Z`);

describe('parsePoolSchedule', () => {
  it('parses days, hours and the catch-all', () => {
    const rules = parsePoolSchedule(SCHED);
    expect(rules).toHaveLength(2);
    expect([...rules[0]!.days!].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(rules[0]!.hours).toEqual({ start: 7, end: 21 });
    expect(rules[0]!.target).toBe(1);
    expect(rules[1]).toEqual({ days: null, hours: null, target: 0 });
  });

  it('accepts comma lists, wrapping ranges and a trailing semicolon', () => {
    const rules = parsePoolSchedule('sat,sun 0-24=2; fri-mon 8-9=3;');
    expect([...rules[0]!.days!].sort()).toEqual([0, 6]);
    expect([...rules[1]!.days!].sort()).toEqual([0, 1, 5, 6]);
  });

  it.each(['mon-fri 21-07=1', 'mon-fri 7-7=1', 'mon-fri 07-25=1', 'someday 07-21=1', 'mon-fri 07-21', 'mon-fri 07-21=x', 'mon-fri 07-21=-1', '=1', 'mon-fri=1'])(
    'rejects %j',
    (bad) => {
      expect(() => parsePoolSchedule(bad)).toThrow();
    }
  );
});

describe('resolvePoolTarget', () => {
  it('weekday inside the window uses the rule target', () => {
    expect(resolvePoolTarget(SCHED, 9, at('2026-09-28T12:00'))).toBe(1);
  });

  it('hour boundaries are [start, end)', () => {
    expect(resolvePoolTarget(SCHED, 9, at('2026-09-28T06:59'))).toBe(0);
    expect(resolvePoolTarget(SCHED, 9, at('2026-09-28T07:00'))).toBe(1);
    expect(resolvePoolTarget(SCHED, 9, at('2026-09-28T20:59'))).toBe(1);
    expect(resolvePoolTarget(SCHED, 9, at('2026-09-28T21:00'))).toBe(0);
  });

  it('weekend falls through to the catch-all', () => {
    expect(resolvePoolTarget(SCHED, 9, at('2026-10-03T12:00'))).toBe(0);
    expect(resolvePoolTarget(SCHED, 9, at('2026-10-04T12:00'))).toBe(0);
  });

  it('day boundaries are UTC: Friday 23:59 is still Friday, Saturday 00:00 is not', () => {
    expect(resolvePoolTarget('fri 0-24=1; *=0', 9, at('2026-10-02T23:59'))).toBe(1);
    expect(resolvePoolTarget('fri 0-24=1; *=0', 9, at('2026-10-03T00:00'))).toBe(0);
  });

  it('first matching rule wins', () => {
    expect(resolvePoolTarget('mon 0-24=5; mon-fri 0-24=2; *=0', 9, at('2026-09-28T12:00'))).toBe(5);
    expect(resolvePoolTarget('mon 0-24=5; mon-fri 0-24=2; *=0', 9, at('2026-09-29T12:00'))).toBe(2);
  });

  it('a schedule with no matching rule returns the fallback', () => {
    expect(resolvePoolTarget('mon-fri 07-21=1', 4, at('2026-10-03T12:00'))).toBe(4);
  });

  it('undefined or blank schedule returns the fallback', () => {
    expect(resolvePoolTarget(undefined, 3, at('2026-09-28T12:00'))).toBe(3);
    expect(resolvePoolTarget('', 3, at('2026-09-28T12:00'))).toBe(3);
    expect(resolvePoolTarget('   ', 3, at('2026-09-28T12:00'))).toBe(3);
  });

  it('an unparseable schedule returns the fallback and logs once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = 'weekdays 7am-9pm=1';
    expect(resolvePoolTarget(bad, 2, at('2026-09-28T12:00'))).toBe(2);
    expect(resolvePoolTarget(bad, 2, at('2026-09-29T12:00'))).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
