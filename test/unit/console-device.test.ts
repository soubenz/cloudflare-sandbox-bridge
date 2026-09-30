import { describe, it, expect } from 'vitest';

/**
 * Is this screen too small to run a lab on (dashboard/src/device.js)? The console
 * shows the "Labs work best on a desktop" notice instead of starting or rejoining
 * a lab when it is. Pure module, imported directly.
 */
const d = (await import('../../dashboard/src/device.js' as string)) as {
  isPhoneLike: (o?: { width?: unknown; coarse?: unknown }) => boolean;
  readDevice: (win?: unknown) => { width: number; coarse: boolean };
  phoneLikeNow: (win?: unknown) => boolean;
  PHONE_MAX_WIDTH: number;
  TOUCH_MAX_WIDTH: number;
};

describe('isPhoneLike', () => {
  it('is true below 760px whatever the pointer', () => {
    for (const width of [320, 375, 390, 430, 759]) {
      expect(d.isPhoneLike({ width, coarse: false })).toBe(true);
      expect(d.isPhoneLike({ width, coarse: true })).toBe(true);
    }
  });

  it('is false from 760px with a mouse', () => {
    for (const width of [760, 768, 899, 900, 1024, 1440, 2560]) expect(d.isPhoneLike({ width, coarse: false })).toBe(false);
  });

  it('is true for a touch screen narrower than 900px, false from 900px', () => {
    for (const width of [760, 768, 820, 899]) expect(d.isPhoneLike({ width, coarse: true })).toBe(true);
    for (const width of [900, 1024, 1180, 1366]) expect(d.isPhoneLike({ width, coarse: true })).toBe(false);
  });

  it('has its edges where the owner put them', () => {
    expect(d.PHONE_MAX_WIDTH).toBe(760);
    expect(d.TOUCH_MAX_WIDTH).toBe(900);
    expect(d.isPhoneLike({ width: 759.9 })).toBe(true);
    expect(d.isPhoneLike({ width: 760 })).toBe(false);
  });

  it('never locks anyone out for want of a width', () => {
    for (const width of [0, -5, NaN, undefined, null, 'wide', Infinity]) expect(d.isPhoneLike({ width, coarse: true })).toBe(false);
    expect(d.isPhoneLike()).toBe(false);
    expect(d.isPhoneLike({})).toBe(false);
  });

  it('treats a missing pointer as a mouse', () => {
    expect(d.isPhoneLike({ width: 800 })).toBe(false);
  });
});

describe('readDevice', () => {
  const win = (width: number, coarse: boolean) => ({ innerWidth: width, matchMedia: (q: string) => ({ matches: q === '(pointer: coarse)' && coarse }) });

  it('reads the width and the pointer from a window', () => {
    expect(d.readDevice(win(390, true))).toEqual({ width: 390, coarse: true });
    expect(d.readDevice(win(1440, false))).toEqual({ width: 1440, coarse: false });
  });

  it('follows the window when it is resized or turned', () => {
    const w = win(820, true);
    expect(d.phoneLikeNow(w)).toBe(true);
    w.innerWidth = 1180; // the tablet is turned sideways
    expect(d.phoneLikeNow(w)).toBe(false);
  });

  it('survives a window with no matchMedia, and no window at all', () => {
    expect(d.readDevice({ innerWidth: 500 })).toEqual({ width: 500, coarse: false });
    expect(d.readDevice({ innerWidth: 500, matchMedia: () => { throw new Error('nope'); } })).toEqual({ width: 500, coarse: false });
    expect(d.readDevice(null)).toEqual({ width: 0, coarse: false });
    expect(d.phoneLikeNow(null)).toBe(false);
  });
});
