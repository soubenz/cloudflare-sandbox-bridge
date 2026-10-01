import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { looksLikeMp3, mp3Seconds } from '../../src/labs/mp3';

/**
 * The real clips Workers AI (aura-2) made for the voices: mono, 48 kbps, MPEG-2 layer III,
 * 576 samples a frame. The duration must agree with bytes * 8 / bitrate.
 */
const DIR = join(__dirname, '..', 'fixtures', 'audio');
const clips = readdirSync(DIR).filter((f) => f.endsWith('.mp3'));

describe('mp3Seconds', () => {
  it('has real clips to measure', () => {
    expect(clips.length).toBeGreaterThanOrEqual(3);
  });

  for (const name of clips) {
    it(`${name}: within 3% of bytes * 8 / 48000`, () => {
      const bytes = new Uint8Array(readFileSync(join(DIR, name)));
      const expected = (bytes.length * 8) / 48000;
      const got = mp3Seconds(bytes);
      expect(got).toBeGreaterThan(1);
      expect(Math.abs(got - expected) / expected).toBeLessThan(0.03);
    });
  }

  it('counts 576 samples a frame at the clip rate for MPEG-2 layer III', () => {
    const bytes = new Uint8Array(readFileSync(join(DIR, clips[0]!)));
    // 48 kbps at 24 kHz: 72 * 48000 / 24000 = 144 bytes a frame (+1 with padding).
    const frames = Math.round((mp3Seconds(bytes) * 24000) / 576);
    expect(Math.abs(frames - bytes.length / 144)).toBeLessThan(bytes.length / 144 / 50);
  });

  it('skips a leading ID3v2 tag', () => {
    const bytes = new Uint8Array(readFileSync(join(DIR, clips[0]!)));
    const tag = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20, ...new Array(20).fill(0)]); // 20 bytes of tag body
    const tagged = new Uint8Array(tag.length + bytes.length);
    tagged.set(tag);
    tagged.set(bytes, tag.length);
    expect(mp3Seconds(tagged)).toBeCloseTo(mp3Seconds(bytes), 6);
    expect(looksLikeMp3(tagged)).toBe(true);
  });

  it('measures MPEG-1 layer III too (1152 samples a frame)', () => {
    // 128 kbps at 44.1 kHz: 144 * 128000 / 44100 = 417 bytes (418 padded). Header FF FB 90 00 (no padding).
    const frame = new Uint8Array(417);
    frame.set([0xff, 0xfb, 0x90, 0x00]);
    const bytes = new Uint8Array(417 * 10);
    for (let i = 0; i < 10; i++) bytes.set(frame, i * 417);
    expect(mp3Seconds(bytes)).toBeCloseTo((10 * 1152) / 44100, 6);
  });

  it('is 0 for bytes that are not audio', () => {
    expect(mp3Seconds(new Uint8Array(0))).toBe(0);
    expect(mp3Seconds(new TextEncoder().encode('not an mp3 at all, just some words'))).toBe(0);
  });

  it('does not count a Xing/Info header frame', () => {
    const real = new Uint8Array(readFileSync(join(DIR, clips[0]!)));
    // A silent first frame, as encoders write: same header as the clip's, "Info" at the Xing offset.
    const info = new Uint8Array(144);
    info.set(real.subarray(0, 4));
    info.set(new TextEncoder().encode('Info'), 13);
    const withInfo = new Uint8Array(info.length + real.length);
    withInfo.set(info);
    withInfo.set(real, info.length);
    expect(mp3Seconds(withInfo)).toBeCloseTo(mp3Seconds(real), 6);
  });
});

describe('looksLikeMp3', () => {
  it('accepts the real clips and rejects other things', () => {
    for (const name of clips) expect(looksLikeMp3(new Uint8Array(readFileSync(join(DIR, name))))).toBe(true);
    expect(looksLikeMp3(new TextEncoder().encode('<html>hello</html>'))).toBe(false);
    expect(looksLikeMp3(new Uint8Array(0))).toBe(false);
    expect(looksLikeMp3(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toBe(false); // reserved version/layer/bitrate
  });
});
