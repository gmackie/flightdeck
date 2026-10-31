// Seeded, dependency-free PRNG (xmur3 string hash -> sfc32). Same seed, same sequence, on any platform.

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** @param {string | number} seed */
export function createRng(seed) {
  const seedHash = xmur3(String(seed));
  let a = seedHash();
  let b = seedHash();
  let c = seedHash();
  let d = seedHash();
  const float = () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 16; i++) float();

  const rng = {
    float,
    /** Float in [lo, hi). */
    range: (lo, hi) => lo + (hi - lo) * float(),
    /** Integer in [lo, hi], both inclusive. */
    int: (lo, hi) => lo + Math.floor(float() * (hi - lo + 1)),
    chance: (p) => float() < p,
    pick: (items) => items[Math.floor(float() * items.length)],
    /** @param {[unknown, number][]} pairs */
    weighted(pairs) {
      let total = 0;
      for (const [, w] of pairs) total += w;
      let x = float() * total;
      for (const [value, w] of pairs) {
        x -= w;
        if (x < 0) return value;
      }
      return pairs[pairs.length - 1][0];
    },
    /** Standard normal via Box-Muller. */
    gauss() {
      const u = 1 - float();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * float());
    },
    /** Opaque lowercase base36 id; ~103 bits at the default length. */
    id(len = 20) {
      let s = "";
      for (let i = 0; i < len; i++) s += ID_ALPHABET[Math.floor(float() * 36)];
      return s;
    },
  };
  return rng;
}
