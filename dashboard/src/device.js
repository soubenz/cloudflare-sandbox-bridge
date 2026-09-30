/**
 * Is this screen too small to run a lab on? Pure, no DOM, so a test can pin it.
 *
 * A lab puts a terminal, an editor and live checks side by side; on a phone
 * there is no room for that, so the console asks the learner to come back on
 * a computer instead of starting a container that cannot be used. Browsing
 * the launcher, the lessons and the quiz still works everywhere: only
 * starting or rejoining a lab is gated (see guardDesktop in app.js).
 *
 *   width   the viewport width in CSS pixels (window.innerWidth)
 *   coarse  the primary pointer is a finger (matchMedia('(pointer: coarse)'))
 *
 * Phone-like means narrower than 760px, or a touch screen narrower than
 * 900px (a tablet held upright). A narrow desktop window counts too: the
 * same layout problem, the same way out (widen the window).
 */

export const PHONE_MAX_WIDTH = 760;
export const TOUCH_MAX_WIDTH = 900;

export function isPhoneLike({ width, coarse = false } = {}) {
  const w = Number(width);
  // No width to go on (a blocked or odd environment) must never lock anyone out.
  if (!Number.isFinite(w) || w <= 0) return false;
  return w < PHONE_MAX_WIDTH || (Boolean(coarse) && w < TOUCH_MAX_WIDTH);
}

/** The live inputs, read from a window (or a stand-in in a test). */
export function readDevice(win = globalThis.window) {
  if (!win) return { width: 0, coarse: false };
  let coarse = false;
  try {
    coarse = Boolean(win.matchMedia?.('(pointer: coarse)').matches);
  } catch {
    /* no matchMedia: treat the pointer as a mouse */
  }
  return { width: win.innerWidth, coarse };
}

/** `isPhoneLike` of the current window. */
export const phoneLikeNow = (win) => isPhoneLike(readDevice(win));
