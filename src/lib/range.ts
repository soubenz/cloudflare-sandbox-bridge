/**
 * A single `Range: bytes=a-b` header against a body of `size` bytes: the inclusive byte range to
 * send, 'unsatisfiable' when it lies outside the body (answer 416), or null when there is no
 * usable single range (no header, another unit, several ranges): send the whole body, which a
 * server is always allowed to do.
 */
export function parseByteRange(header: string | null | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    // Suffix range: the last n bytes.
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== '' && Number(m[2]) < start) return null; // an invalid range: ignore the header
  }
  if (size === 0 || start >= size) return 'unsatisfiable';
  return { start, end };
}
