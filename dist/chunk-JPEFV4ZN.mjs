// src/singlefile/sha1.ts
function sha1Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const ml = bytes.length;
  const total = (ml + 8 >> 6) + 1 << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[ml] = 128;
  const view = new DataView(buf.buffer);
  const bitLen = ml * 8;
  view.setUint32(total - 8, Math.floor(bitLen / 4294967296));
  view.setUint32(total - 4, bitLen >>> 0);
  let h0 = 1732584193;
  let h1 = 4023233417;
  let h2 = 2562383102;
  let h3 = 271733878;
  let h4 = 3285377520;
  const w = new Uint32Array(80);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (n << 1 | n >>> 31) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f;
      let k;
      if (i < 20) {
        f = b & c | ~b & d;
        k = 1518500249;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 1859775393;
      } else if (i < 60) {
        f = b & c | b & d | c & d;
        k = 2400959708;
      } else {
        f = b ^ c ^ d;
        k = 3395469782;
      }
      const t = ((a << 5 | a >>> 27) >>> 0) + f + e + k + w[i] >>> 0;
      e = d;
      d = c;
      c = (b << 30 | b >>> 2) >>> 0;
      b = a;
      a = t;
    }
    h0 = h0 + a >>> 0;
    h1 = h1 + b >>> 0;
    h2 = h2 + c >>> 0;
    h3 = h3 + d >>> 0;
    h4 = h4 + e >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, "0")).join("");
}

export {
  sha1Hex
};
