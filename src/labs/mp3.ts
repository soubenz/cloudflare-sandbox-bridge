/**
 * Just enough MP3 to size a narration clip: how long it plays, and whether
 * a file is plausibly an MP3 at all. No dependencies, so the CLI (which measures
 * the clips it writes) and the Worker (which checks what a publish uploads) share it.
 */

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const BITRATES_V1_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
const BITRATES_V2_L1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
const BITRATES_V2_L23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] } as const;

interface FrameInfo {
  length: number;
  samples: number;
  rate: number;
}

/** The frame whose header starts at `at`, or null when the four bytes are not a valid MPEG audio header. */
function frameAt(b: Uint8Array, at: number): FrameInfo | null {
  if (at + 4 > b.length) return null;
  const b1 = b[at + 1]!;
  if (b[at] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5, 1 = reserved
  const layer = (b1 >> 1) & 3; // 3 = layer I, 2 = layer II, 1 = layer III, 0 = reserved
  if (version === 1 || layer === 0) return null;
  const b2 = b[at + 2]!;
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const mpeg1 = version === 3;
  const table = layer === 3 ? (mpeg1 ? BITRATES_V1_L1 : BITRATES_V2_L1) : layer === 2 ? (mpeg1 ? BITRATES_V1_L2 : BITRATES_V2_L23) : mpeg1 ? BITRATES_V1_L3 : BITRATES_V2_L23;
  const bitrate = table[bitrateIndex]! * 1000;
  const rate = RATES[version as 3 | 2 | 0][rateIndex]!;
  const padding = (b2 >> 1) & 1;
  if (layer === 3) return { length: (Math.floor((12 * bitrate) / rate) + padding) * 4, samples: 384, rate };
  const samples = layer === 2 || mpeg1 ? 1152 : 576;
  return { length: Math.floor(((samples / 8) * bitrate) / rate) + padding, samples, rate };
}

/** Bytes of an ID3v2 tag at the start of the file (0 when there is none). */
function id3Size(b: Uint8Array): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
  const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
  const footer = (b[5]! & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

/**
 * Playing time in seconds, by walking the frame headers (MPEG-1, 2 and 2.5, layers I to III;
 * Workers AI speech is MPEG-2 layer III, 576 samples a frame). A leading ID3v2 tag is skipped,
 * and a Xing/Info frame (a silent header some encoders write first) is not counted.
 * Returns 0 for bytes that hold no audio frame.
 */
export function mp3Seconds(bytes: Uint8Array): number {
  let pos = id3Size(bytes);
  let seconds = 0;
  let first = true;
  while (pos + 4 <= bytes.length) {
    const f = frameAt(bytes, pos);
    if (!f || f.length < 4) {
      pos += 1; // junk between frames: look for the next header
      continue;
    }
    const isInfo = first && /Xing|Info/.test(String.fromCharCode(...bytes.subarray(pos + 4, Math.min(bytes.length, pos + 44))));
    first = false;
    // A truncated last frame still counts for what is there, never beyond the end of the file.
    if (!isInfo) seconds += f.samples / f.rate;
    pos += f.length;
  }
  return seconds;
}

/** Whether `bytes` start like an MP3: an ID3v2 tag or an MPEG audio frame header (and one frame follows the tag). */
export function looksLikeMp3(bytes: Uint8Array): boolean {
  const start = id3Size(bytes);
  return frameAt(bytes, start) !== null;
}
