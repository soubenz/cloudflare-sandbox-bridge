import { describe, it, expect } from 'vitest';
import { STING_SOUNDS as KIT_SOUNDS } from '../../src/labs/comic-kit';

/**
 * The motion comic's sound stings (dashboard/src/comic-sfx.js): which are due as the clock moves, and the
 * synthesis of each, scheduled on a stand-in AudioContext that records what it is asked to play. The player
 * that plays them, and logs them in test mode, is comic.js (test/e2e can read `audioLog()` and `stings`).
 */
type Sting = { panel: number; sound: string; at: number };
const S = (await import('../../dashboard/src/comic-sfx.js' as string)) as {
  STING_SOUNDS: readonly string[];
  STING_DB: number;
  STING_GAIN: number;
  STING_LATE: number;
  STING_SECONDS: Record<string, number>;
  stingsDue: (stings: Sting[], from: number, to: number) => Sting[];
  SYNTH: Record<string, (ctx: unknown, out: unknown, t0: number, noise: unknown) => void>;
  playSting: (sound: string) => boolean;
};

/** An AudioContext stand-in: every node records its starts, stops and ramps. */
function fakeContext() {
  const starts: number[] = [];
  const stops: number[] = [];
  const peaks: number[] = [];
  /** An AudioParam; a gain's ramps are its levels. */
  const param = (gain = false) => ({
    value: 0,
    setValueAtTime() {},
    exponentialRampToValueAtTime(v: number) {
      if (gain) peaks.push(v);
    },
  });
  const node = () => ({ connect() {} });
  const source = () => ({
    ...node(),
    frequency: param(),
    type: '',
    buffer: null,
    start: (t: number) => starts.push(t),
    stop: (t: number) => stops.push(t),
  });
  const ctx = {
    sampleRate: 48000,
    currentTime: 0,
    createOscillator: source,
    createBufferSource: source,
    createGain: () => ({ ...node(), gain: param(true) }),
    createBiquadFilter: () => ({ ...node(), type: '', frequency: param(), Q: param() }),
  };
  return { ctx, starts, stops, peaks };
}

describe('which stings are due', () => {
  const stings: Sting[] = [
    { panel: 1, sound: 'phone', at: 2 },
    { panel: 2, sound: 'ping', at: 9.5 },
  ];

  it('is a sting whose moment the clock just reached going forwards, once', () => {
    expect(S.stingsDue(stings, 1.99, 2.01)).toEqual([stings[0]]);
    expect(S.stingsDue(stings, 2.01, 2.03)).toEqual([]);
    expect(S.stingsDue(stings, 1.9, 2)).toEqual([stings[0]]); // exactly on it
    expect(S.stingsDue(stings, 2, 2.1)).toEqual([]); // already played on the frame that reached it
  });

  it('is none going backwards (Replay, a seek back) or standing still', () => {
    expect(S.stingsDue(stings, 12, 0)).toEqual([]);
    expect(S.stingsDue(stings, 2, 2)).toEqual([]);
  });

  it('is none that the clock passed more than STING_LATE ago (a seek or Skip far past it lands nowhere near its moment)', () => {
    expect(S.stingsDue(stings, 0, 30)).toEqual([]);
    expect(S.stingsDue(stings, 1, 2 + S.STING_LATE)).toEqual([stings[0]]);
    expect(S.stingsDue(stings, 1, 2 + S.STING_LATE + 0.01)).toEqual([]);
    // a frame is never longer than the clock's largest step, so a playing comic never misses one
    expect(S.STING_LATE).toBeGreaterThanOrEqual(0.25);
  });
});

describe('the stings themselves', () => {
  it('has exactly the sounds the schema allows', () => {
    expect([...S.STING_SOUNDS]).toEqual([...KIT_SOUNDS]);
    expect(Object.keys(S.SYNTH).sort()).toEqual([...KIT_SOUNDS].sort());
    expect(Object.keys(S.STING_SECONDS).sort()).toEqual([...KIT_SOUNDS].sort());
  });

  it('plays about 14 dB under the storyteller', () => {
    expect(S.STING_DB).toBe(-14);
    expect(20 * Math.log10(S.STING_GAIN)).toBeCloseTo(-14, 9);
  });

  it('schedules each one from its start for 80 to 400 ms, as STING_SECONDS says, never above full scale', () => {
    for (const sound of KIT_SOUNDS) {
      const { ctx, starts, stops, peaks } = fakeContext();
      S.SYNTH[sound]!(ctx, {}, 10, {});
      expect(starts.length, sound).toBeGreaterThan(0);
      expect(Math.min(...starts), sound).toBe(10);
      const length = Math.max(...stops) - 10;
      expect(length, sound).toBeGreaterThanOrEqual(0.08 - 1e-9);
      expect(length, sound).toBeLessThanOrEqual(0.4 + 1e-9);
      expect(length, sound).toBeCloseTo(S.STING_SECONDS[sound]!, 1);
      expect(Math.max(...peaks), sound).toBeLessThanOrEqual(1);
    }
  });

  it('a phone is two bursts and a register two clicks before its chime', () => {
    const phone = fakeContext();
    S.SYNTH.phone!(phone.ctx, {}, 0, {});
    expect(new Set(phone.starts).size).toBe(2);
    const register = fakeContext();
    S.SYNTH.register!(register.ctx, {}, 0, {});
    expect([...new Set(register.starts)].sort()).toEqual([0, 0.06, 0.12]);
  });

  it('plays nothing before the learner has tapped (no context yet), and nothing it does not know', () => {
    expect(S.playSting('ping')).toBe(false);
    expect(S.playSting('kazoo')).toBe(false);
  });
});
