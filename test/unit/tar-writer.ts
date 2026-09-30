import { gzipSync } from 'node:zlib';

/**
 * A tiny tar writer for the solution-reveal tests, so a test can build the
 * archives the real `tar` never would (a `..` path, an absolute path, a
 * binary file) alongside the ones it does. It is not imported by any source.
 */
export interface TarSpec {
  name: string;
  /** Text or bytes; ignored for a directory. */
  content?: string | Uint8Array;
  /** `0` regular (default), `5` directory, `2` symlink. */
  type?: '0' | '5' | '2';
}

const enc = new TextEncoder();

function field(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  out.set(enc.encode(text).subarray(0, length));
  return out;
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function header(name: string, size: number, type: string, opts: { prefix?: string; magic?: 'ustar' | 'gnu' } = {}): Uint8Array {
  const block = new Uint8Array(512);
  block.set(field(name, 100), 0);
  block.set(field(octal(0o644, 8), 8), 100);
  block.set(field(octal(0, 8), 8), 108);
  block.set(field(octal(0, 8), 8), 116);
  block.set(field(octal(size, 12), 12), 124);
  block.set(field(octal(0, 12), 12), 136);
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  if (opts.magic === 'gnu') block.set(enc.encode('ustar  \0'), 257);
  else {
    block.set(enc.encode('ustar\0'), 257);
    block.set(enc.encode('00'), 263);
  }
  if (opts.prefix) block.set(field(opts.prefix, 155), 345);
  let sum = 0;
  for (const b of block) sum += b;
  block.set(field(sum.toString(8).padStart(6, '0') + '\0 ', 8), 148);
  return block;
}

function padded(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  out.set(bytes);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function body(content: string | Uint8Array | undefined): Uint8Array {
  return typeof content === 'string' ? enc.encode(content) : (content ?? new Uint8Array());
}

export type LongNameStyle = 'ustar-prefix' | 'gnu-L' | 'pax';

/** An uncompressed tar archive. Names over 100 bytes are written in the given style. */
export function makeTar(entries: TarSpec[], style: LongNameStyle = 'gnu-L'): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const data = e.type === '5' || e.type === '2' ? new Uint8Array() : body(e.content);
    const type = e.type ?? '0';
    const nameBytes = enc.encode(e.name).length;
    if (nameBytes > 100 && style === 'gnu-L') {
      const long = enc.encode(e.name + '\0');
      parts.push(header('././@LongLink', long.length, 'L', { magic: 'gnu' }), padded(long));
      parts.push(header(e.name.slice(0, 99), data.length, type, { magic: 'gnu' }), padded(data));
    } else if (nameBytes > 100 && style === 'pax') {
      const record = (() => {
        const rest = ` path=${e.name}\n`;
        let len = enc.encode(rest).length + 1;
        while (enc.encode(`${len}${rest}`).length !== len) len = enc.encode(`${len}${rest}`).length;
        return enc.encode(`${len}${rest}`);
      })();
      parts.push(header('PaxHeader/x', record.length, 'x'), padded(record));
      parts.push(header(e.name.slice(0, 99), data.length, type), padded(data));
    } else if (nameBytes > 100 && style === 'ustar-prefix') {
      const cut = e.name.lastIndexOf('/', e.name.length - 1);
      parts.push(header(e.name.slice(cut + 1), data.length, type, { prefix: e.name.slice(0, cut) }), padded(data));
    } else {
      parts.push(header(e.name, data.length, type), padded(data));
    }
  }
  parts.push(new Uint8Array(1024));
  return concat(parts);
}

export function makeTgz(entries: TarSpec[], style?: LongNameStyle): Buffer {
  return gzipSync(makeTar(entries, style));
}

/** A ReadableStream over the bytes, the shape an R2 object body has. */
export function streamOf(bytes: Uint8Array, chunk = 1024): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(at, at + chunk));
      at += chunk;
    },
  });
}
