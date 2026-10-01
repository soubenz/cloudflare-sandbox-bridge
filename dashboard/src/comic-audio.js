/**
 * The motion comic's voices, as pure logic with no DOM and no Audio.
 *
 * The comic has one clock (comic-timeline.js); the narration is scheduled against that
 * same clock, never against its own. Each frame comic.js asks one question, "which clip
 * should be sounding at this moment of the clock, and how far into it?" (audioWanted),
 * and hands the answer to audioReduce, which says what to do about it: stop this, start
 * that. Skip, Replay, a seek, a hidden tab, the Sound toggle and destroy all work the same
 * way: the answer becomes "nothing", or a different clip, and the old one is stopped.
 * Because there is one `current` clip (and the timeline schedules one narrator clip per voiced
 * panel, never overlapping), two never play at once.
 *
 *   state    { current, blocked, finished, failed }
 *   events   { type: 'sync', wanted }          every frame, and whenever anything above changes
 *            { type: 'rejected', key, name }   play() was refused (NotAllowedError: the browser wants a tap)
 *            { type: 'errored', key }          the clip could not be loaded or played: skip it, silently
 *            { type: 'ended', key }            the clip played to its end
 *            { type: 'gesture' }               the learner tapped something: the browser will allow sound now
 *   commands { type: 'play', key, offset } | { type: 'stop', key }
 */

/** A clip started up to this late (frame time, a busy tab) starts from its beginning rather than seeking into it. */
export const LATE_START = 0.3;

/**
 * The clip sounding at clock time `t` (clips are `{ key, start, end }`, in start order), or null.
 * `running` is whether the clock is advancing (not done, not paused, tab visible, comic on screen);
 * `sound` is the learner's Sound toggle.
 */
export function audioWanted(clips, t, { running, sound }) {
  if (!running || !sound) return null;
  for (const clip of clips) {
    if (t >= clip.start && t < clip.end) return { clip, offset: t - clip.start };
  }
  return null;
}

export const initialAudio = () => ({ current: null, blocked: false, finished: null, failed: [] });

/** Where a clip's file is served from: the console Worker's cookie-gated proxy of the API route. */
export const clipUrl = (slug, key) => `/api/audio/${encodeURIComponent(slug)}/${key}.mp3`;

export function audioReduce(state, event) {
  switch (event.type) {
    case 'sync': {
      const wanted = event.wanted;
      // A clip that has already played out stays out until the clock has moved on from it.
      const finished = wanted && state.finished === wanted.clip.key ? state.finished : null;
      const playable = wanted && !state.blocked && !finished && !state.failed.includes(wanted.clip.key) ? wanted : null;
      const commands = [];
      if (!playable) {
        if (state.current !== null) commands.push({ type: 'stop', key: state.current });
        return { state: { ...state, current: null, finished }, commands };
      }
      const key = playable.clip.key;
      if (state.current === key) return { state: { ...state, finished }, commands };
      if (state.current !== null) commands.push({ type: 'stop', key: state.current });
      commands.push({ type: 'play', key, offset: playable.offset < LATE_START ? 0 : playable.offset });
      return { state: { ...state, current: key, finished }, commands };
    }
    case 'rejected': {
      // An answer to a clip that has since been stopped or replaced is of no interest.
      if (state.current !== event.key) return { state, commands: [] };
      if (event.name === 'NotAllowedError') return { state: { ...state, current: null, blocked: true }, commands: [] };
      return { state: { ...state, current: null, failed: [...state.failed, event.key] }, commands: [] };
    }
    case 'errored': {
      const failed = state.failed.includes(event.key) ? state.failed : [...state.failed, event.key];
      return { state: { ...state, current: state.current === event.key ? null : state.current, failed }, commands: [] };
    }
    case 'ended':
      return { state: state.current === event.key ? { ...state, current: null, finished: event.key } : state, commands: [] };
    case 'gesture':
      return state.blocked ? { state: { ...state, blocked: false }, commands: [] } : { state, commands: [] };
    default:
      return { state, commands: [] };
  }
}
