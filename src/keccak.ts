// Minimal, dependency-free Keccak-256 (pre-FIPS Keccak padding: 0x01).
// ENS namehash and ABI selectors depend on it; WebCrypto ships SHA3 but not Keccak.

const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// rotation offsets r[x][y]
const R = [
  [0n, 36n, 3n, 41n, 18n],
  [1n, 44n, 10n, 45n, 2n],
  [62n, 6n, 43n, 15n, 61n],
  [28n, 55n, 25n, 21n, 56n],
  [27n, 20n, 39n, 8n, 14n],
];

const MASK = (1n << 64n) - 1n;
const rotl = (x: bigint, n: bigint): bigint => ((x << n) | (x >> (64n - n))) & MASK;

function keccakF(a: bigint[][]): void {
  for (let round = 0; round < 24; round++) {
    const c: bigint[] = new Array(5);
    for (let x = 0; x < 5; x++) c[x] = a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4];
    const d: bigint[] = new Array(5);
    for (let x = 0; x < 5; x++) d[x] = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1n);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) a[x][y] ^= d[x];
    const b: bigint[][] = Array.from({ length: 5 }, () => new Array(5).fill(0n));
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y][(2 * x + 3 * y) % 5] = rotl(a[x][y], R[x][y]);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        a[x][y] = b[x][y] ^ (~b[(x + 1) % 5][y] & b[(x + 2) % 5][y]);
      }
    }
    a[0][0] ^= RC[round];
  }
}

const RATE = 136; // bytes, for 256-bit output

export function keccak256(input: Uint8Array): Uint8Array {
  // pad: Keccak (0x01 … 0x80)
  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE) * RATE);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  const a = Array.from({ length: 5 }, () => new Array(5).fill(0n));
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      a[i % 5][Math.floor(i / 5)] ^= lane;
    }
    keccakF(a);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = a[i % 5][Math.floor(i / 5)];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

export function keccak256Hex(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return [...keccak256(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
