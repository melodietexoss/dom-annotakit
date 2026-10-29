/**
 * dom-annotakit — compact synchronous SHA-1 → hex (design D2c-2).
 *
 * The import flow needs `sha1(noteText)[0:8]` for DETERMINISTIC thread ids
 * (recycle-proof: SingleFile note ids restart at 1 on a re-save, so the note
 * TEXT joins the identity). The host app is browser-side — `node:crypto` is
 * unavailable and `crypto.subtle.digest` is ASYNC (it would serialize the
 * whole per-note import loop for a value we need synchronously to build the
 * id). A ~50-line public-domain-style implementation is the honest trade;
 * `scripts/singlefile-import-test.mjs` pins it against `node:crypto`
 * (the Node suite runs where node:crypto exists — that is the drift check).
 */

/* eslint-disable no-bitwise */

export function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const ml = bytes.length;
  // pad to a 64-byte multiple: message || 0x80 || zeros || 64-bit big-endian bit length
  const total = (((ml + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[ml] = 0x80;
  const view = new DataView(buf.buffer);
  const bitLen = ml * 8;
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(total - 4, bitLen >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = ((n << 1) | (n >>> 31)) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = ((((a << 5) | (a >>> 27)) >>> 0) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
}
