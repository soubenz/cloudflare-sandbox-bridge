import { describe, it, expect } from 'vitest';

type Notice = { key: string; tone: string; title: string; detail: string };
const { learnerAlert, createAlertFilter } = (await import('../../dashboard/src/learner-alerts.js' as string)) as {
  learnerAlert: (data: unknown) => Notice | null;
  createAlertFilter: () => { take: (data: unknown) => Notice | null; reset: () => void };
};

/**
 * Which `alert` events reach the learner's Lab activity strip
 * (dashboard/src/learner-alerts.js). The live incident this pins: after a
 * deploy, a running lab got one "Something went wrong" per health tick
 * (timer_failed) plus one for the terminal socket closing, while the lab
 * itself was fine.
 */
describe('learnerAlert', () => {
  const internal = [
    { kind: 'timer_failed', timer: 'health', error: 'ApiError:500:internal_error: Internal error' },
    { kind: 'timer_failed', timer: 'metrics', error: 'x' },
    { kind: 'health_unreachable', error: 'ApiError:500:internal_error: Internal error', error_name: 'X' },
    { kind: 'terminal_upstream_closed' },
    { kind: 'terminal_resize_failed', error: 'x' },
    { kind: 'terminal_reconnect_failed', error: 'x' },
    { kind: 'checks_history_failed' },
    { kind: 'check_run_count_failed' },
    { kind: 'final_metrics_failed' },
    { kind: 'set_allowed_hosts_failed' },
    { kind: 'solution_unlock_failed' },
    { kind: 'pressure_failed', event_id: 'p1', exit_code: 1 },
    { kind: 'something_new_nobody_mapped' },
    { kind: '__proto__' },
    { kind: 'toString' },
    {},
    null,
    undefined,
  ];
  for (const data of internal) {
    it(`hides ${JSON.stringify(data)}`, () => {
      expect(learnerAlert(data)).toBeNull();
    });
  }

  const shown = ['boot_gave_up', 'stuck_boot', 'recover_failed', 'recover_no_snapshot', 'recover_workspace_kept', 'snapshot_on_end_failed'];
  for (const kind of shown) {
    it(`shows ${kind} with a plain, specific message`, () => {
      const notice = learnerAlert({ kind, error: 'ApiError:500:internal_error: Internal error' });
      if (!notice) throw new Error(`${kind} is hidden`);
      expect(notice.key).toBe(`alert:${kind}`);
      expect(['bad', 'good', 'warn', 'info']).toContain(notice.tone);
      expect(notice.title.length).toBeGreaterThan(0);
      expect(notice.detail.length).toBeGreaterThan(0);
      // Never the old catch-all, never internal error text.
      expect(`${notice.title} ${notice.detail}`).not.toMatch(/Something went wrong|ApiError|internal_error|undefined/);
    });
  }

  it('gives each shown kind its own words', () => {
    const titles = shown.map((kind) => learnerAlert({ kind })?.title);
    expect(new Set(titles).size).toBe(shown.length);
  });
});

describe('createAlertFilter', () => {
  it('shows a repeated alert once, and never the hidden ones', () => {
    const filter = createAlertFilter();
    const out = [
      { kind: 'terminal_upstream_closed' },
      { kind: 'timer_failed', timer: 'health' },
      { kind: 'timer_failed', timer: 'health' },
      { kind: 'recover_failed', error: 'a' },
      { kind: 'timer_failed', timer: 'health' },
      { kind: 'recover_failed', error: 'b' },
      { kind: 'recover_failed', error: 'c' },
      { kind: 'recover_no_snapshot' },
    ]
      .map((d) => filter.take(d))
      .flatMap((n) => (n ? [n.key] : []));
    expect(out).toEqual(['alert:recover_failed', 'alert:recover_no_snapshot']);
  });

  it('starts over after reset (a new session)', () => {
    const filter = createAlertFilter();
    expect(filter.take({ kind: 'recover_failed' })).not.toBeNull();
    expect(filter.take({ kind: 'recover_failed' })).toBeNull();
    filter.reset();
    expect(filter.take({ kind: 'recover_failed' })).not.toBeNull();
  });

  it('separate filters do not share state', () => {
    const a = createAlertFilter();
    const b = createAlertFilter();
    a.take({ kind: 'stuck_boot' });
    expect(b.take({ kind: 'stuck_boot' })).not.toBeNull();
  });
});
