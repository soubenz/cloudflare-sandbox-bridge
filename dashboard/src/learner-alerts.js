/**
 * Which of the API's `alert` events a learner is told about, and in what words.
 *
 * Most alerts are operations telemetry: a timer that threw, a terminal socket
 * that closed, a metrics write that failed, the health probe losing the
 * container for a few minutes after a deploy. The lab usually carries on
 * through them, the learner cannot do anything about them, and showing each
 * one as "Something went wrong" (as the console used to, once per health tick)
 * only alarms them. Those stay in admin mode's event log, raw.
 *
 * What is shown is what changes the learner's lab or asks something of them,
 * each with a plain message that says what happened and what to do. An alert
 * kind not listed here is not shown.
 */
const SHOWN = {
  boot_gave_up: () => ({
    tone: 'bad',
    title: 'Your lab could not start',
    detail: 'It was tried a few times and did not come up. Start the lab again.',
  }),
  stuck_boot: () => ({
    tone: 'bad',
    title: 'Your lab got stuck starting',
    detail: 'It has been stopped. Start the lab again.',
  }),
  recover_failed: () => ({
    tone: 'bad',
    title: 'Your lab could not be restored yet',
    detail: 'It tries again on its own in a minute. If this keeps coming back, use End & save, then start the lab again.',
  }),
  recover_no_snapshot: () => ({
    tone: 'bad',
    title: 'Your files were reset',
    detail: 'Your lab had to restart and there was no saved copy of your work, so the workspace is back to its starting files.',
  }),
  recover_workspace_kept: () => ({
    tone: 'good',
    title: 'Your files are safe',
    detail: 'Your lab restarted, and everything in your workspace was kept.',
  }),
  snapshot_on_end_failed: () => ({
    tone: 'bad',
    title: 'Your work was not saved',
    detail: 'The lab ended but saving your workspace failed, so this session cannot be resumed.',
  }),
};

/**
 * The learner-facing notice for one `alert` event's data, or null when it is
 * not one to show. `key` identifies the notice for de-duplication: the same
 * alert kind twice in a session is one notice.
 */
export function learnerAlert(data) {
  const kind = typeof data?.kind === 'string' ? data.kind : '';
  const build = Object.prototype.hasOwnProperty.call(SHOWN, kind) ? SHOWN[kind] : null;
  if (!build) return null;
  return { key: `alert:${kind}`, ...build(data) };
}

/**
 * A per-session filter for learner alerts: `take(data)` returns the notice the
 * first time its kind is seen, and null for anything hidden or already shown.
 * `reset()` starts over for a new session.
 */
export function createAlertFilter() {
  const shown = new Set();
  return {
    take(data) {
      const notice = learnerAlert(data);
      if (!notice || shown.has(notice.key)) return null;
      shown.add(notice.key);
      return notice;
    },
    reset() {
      shown.clear();
    },
  };
}
