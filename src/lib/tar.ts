/**
 * A small tar reader and gunzip helper for the Worker: just enough to read a
 * lab's `solution.tgz` back out of R2.
 *
 * What it reads is what the CLI's `tar czf` writes (GNU tar on Linux, bsdtar
 * on macOS):
 *
 *   - ustar headers, including the `prefix` field for names over 100 bytes;
 *   - the GNU `L` long-name entry, which GNU tar writes for a name that does
 *     not fit ustar;
 *   - the pax `x` extended header (`path=`), which bsdtar writes for the same
 *     case (and for xattrs, which are ignored); the `g` global header is
 *     skipped.
 *
 * Only regular files come out. Directories, links, devices and every other
 * entry type are skipped. A name that is absolute, or that has a `..`
 * segment, makes the whole archive unreadable (`TarError`), because nothing
 * the CLI produces contains one.
 */

export class TarError extends Error {
  constructor(
    readonly code: 'bad_header' | 'bad_checksum' | 'unsafe_path' | 'truncated' | 'bad_size',
    message: string
  ) {
    super(message);
    this.name = 'TarError';
  }
}

export interface TarFile {
  /** Relative, `/`-separated, with any leading `./` removed. */
  path: string;
  /** A view into the archive buffer, not a copy. */
  content: Uint8Array;
}

export interface ParsedTar {
  files: TarFile[];
  /** True only when `tolerateTruncation` was set and the archive ended inside an entry. */
  truncated: boolean;
}

const BLOCK = 512;
const decoder = new TextDecoder('utf-8');

function cString(block: Uint8Array, start: number, length: number): string {
  let end = start;
  const limit = start + length;
  while (end < limit && block[end] !== 0) end++;
  return decoder.decode(block.subarray(start, end));
}

function isZeroBlock(data: Uint8Array, offset: number): boolean {
  for (let i = offset; i < offset + BLOCK; i++) if (data[i] !== 0) return false;
  return true;
}

function parseOctal(data: Uint8Array, start: number, length: number, what: string): number {
  const text = cString(data, start, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError('bad_size', `tar: ${what} field is not octal`);
  return Number.parseInt(text, 8);
}

function checksumOk(data: Uint8Array, offset: number): boolean {
  const stored = parseOctal(data, offset + 148, 8, 'checksum');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : data[offset + i]!;
  return sum === stored;
}

/** `len key=value\n` records; `len` counts the whole record, its own digits included. */
function parsePax(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let pos = 0;
  while (pos < data.length) {
    let space = pos;
    while (space < data.length && data[space] !== 0x20) space++;
    const len = Number.parseInt(decoder.decode(data.subarray(pos, space)), 10);
    if (!Number.isFinite(len) || len <= space - pos + 1 || pos + len > data.length) break;
    const record = decoder.decode(data.subarray(space + 1, pos + len - 1)); // drop the trailing \n
    const eq = record.indexOf('=');
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    pos += len;
  }
  return out;
}

/**
 * Normalises an archive name to a safe relative path, or throws. `null` means
 * "nothing to keep" (the archive root `./`).
 */
export function safeTarPath(raw: string): string | null {
  if (raw.includes('\0') || raw.includes('\\')) throw new TarError('unsafe_path', `tar: refusing path ${JSON.stringify(raw)}`);
  if (raw.startsWith('/')) throw new TarError('unsafe_path', `tar: refusing absolute path ${JSON.stringify(raw)}`);
  const parts = raw.split('/');
  const kept: string[] = [];
  for (const part of parts) {
    if (part === '..') throw new TarError('unsafe_path', `tar: refusing path with ".." ${JSON.stringify(raw)}`);
    if (part === '' || part === '.') continue;
    kept.push(part);
  }
  return kept.length === 0 ? null : kept.join('/');
}

/** Reads every regular file out of an uncompressed tar archive. Later entries of the same name replace earlier ones. */
export function parseTar(data: Uint8Array, opts: { tolerateTruncation?: boolean } = {}): ParsedTar {
  const files = new Map<string, TarFile>();
  let truncated = false;
  let offset = 0;
  let longName: string | undefined;
  let paxPath: string | undefined;

  while (offset + BLOCK <= data.length) {
    if (isZeroBlock(data, offset)) break; // end-of-archive marker
    if (!checksumOk(data, offset)) throw new TarError('bad_checksum', `tar: bad header checksum at byte ${offset}`);

    const size = parseOctal(data, offset + 124, 12, 'size');
    const type = String.fromCharCode(data[offset + 156] || 0x30); // NUL is an old-style regular file
    const bodyStart = offset + BLOCK;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > data.length) {
      if (opts.tolerateTruncation) {
        truncated = true;
        break;
      }
      throw new TarError('truncated', `tar: entry at byte ${offset} runs past the end of the archive`);
    }
    const body = data.subarray(bodyStart, bodyEnd);
    const next = bodyStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'L') {
      longName = cString(body, 0, body.length);
    } else if (type === 'x') {
      paxPath = parsePax(body).get('path');
    } else if (type === 'g' || type === 'K') {
      // Global pax defaults and GNU long link targets: nothing we use.
    } else {
      let name = cString(data, offset, 100);
      const isUstar = cString(data, offset + 257, 6) === 'ustar' && cString(data, offset + 263, 2) === '00';
      const prefix = isUstar ? cString(data, offset + 345, 155) : '';
      if (prefix) name = `${prefix}/${name}`;
      if (paxPath !== undefined) name = paxPath;
      else if (longName !== undefined) name = longName;
      longName = undefined;
      paxPath = undefined;

      const path = safeTarPath(name);
      if ((type === '0' || type === '7') && path !== null && !name.endsWith('/')) {
        files.set(path, { path, content: body });
      }
    }
    offset = next;
  }

  return { files: [...files.values()], truncated };
}

/**
 * Gunzips a stream into memory, stopping at `maxBytes` of output. A gzip
 * bomb costs at most that much memory and the stream is cancelled.
 */
export async function gunzip(
  source: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = source.pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes, truncated };
}
