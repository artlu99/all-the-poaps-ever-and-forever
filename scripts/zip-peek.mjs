// Ranged-read peek at the remote archive.zip using curl for fetches.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL_ = process.env.ZIP_URL || 'https://downloads.poaparchive.com/archive.zip';

function rangedFetch(start, end) {
  // -sS silent, --max-time, ranged; returns Buffer
  const buf = execFileSync('curl', ['-sS', '--fail', '--max-time', '300', '-r', `${start}-${end}`, URL_], { maxBuffer: 1024 * 1024 * 1024 });
  return Buffer.from(buf);
}
function headLen() {
  const out = execFileSync('curl', ['-sSI', '--max-time', '60', URL_]).toString();
  return Number(/content-length:\s*(\d+)/i.exec(out)[1]);
}

const total = headLen();
console.log('zip size:', total, `(${(total / 1e9).toFixed(2)} GB)`);

function u16(b, o) { return b.readUInt16LE(o); }
function u32(b, o) { return b.readUInt32LE(o); }
function u64(b, o) { return Number(b.readBigUInt64LE(o)); }

const SIG_EOCD = 0x06054b50, SIG_EOCD64 = 0x06064b50, SIG_LOC64 = 0x07064b50;

const tailStart = total - 65536;
const tail = rangedFetch(tailStart, total - 1);
console.log('tail fetched:', tail.length);

let eocd = -1;
for (let i = tail.length - 22; i >= 0; i--) { if (u32(tail, i) === SIG_EOCD) { eocd = i; break; } }
if (eocd < 0) throw new Error('EOCD not found');
let entryCount = u16(tail, eocd + 10);
let cdSize = u32(tail, eocd + 12);
let cdOffset = u32(tail, eocd + 16);
console.log('EOCD entries:', entryCount, 'cdSize:', cdSize, 'cdOffset:', cdOffset);

const loc64 = tail.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07])); // PK\x06\x07
if (entryCount === 0xffff || cdOffset === 0xffffffff || loc64 !== -1) {
  console.log('ZIP64 detected, locator at tail offset', loc64);
  const eocd64Off = u64(tail, loc64 + 8);
  let rec;
  if (eocd64Off >= tailStart && eocd64Off + 128 <= total) {
    rec = tail.subarray(eocd64Off - tailStart);
  } else {
    rec = rangedFetch(eocd64Off, Math.min(eocd64Off + 256, total) - 1);
  }
  if (u32(rec, 0) !== SIG_EOCD64) throw new Error('ZIP64 EOCD sig mismatch');
  entryCount = u64(rec, 32); cdSize = u64(rec, 40); cdOffset = u64(rec, 48);
  console.log('ZIP64 entries:', entryCount, 'cdSize:', cdSize, 'cdOffset:', cdOffset);
}

console.log('fetching central dir...');
const cd = rangedFetch(cdOffset, cdOffset + cdSize - 1);
console.log('central dir fetched:', cd.length);

const SIG_CDH = 0x02014b50;
const entries = [];
let o = 0;
while (o + 46 <= cd.length) {
  if (u32(cd, o) !== SIG_CDH) throw new Error(`central dir header mismatch at ${o}`);
  const method = u16(cd, o + 10);
  const uncompSize = u32(cd, o + 24);
  const compSize = u32(cd, o + 20);
  const nameLen = u16(cd, o + 28);
  const extraLen = u16(cd, o + 30);
  const commentLen = u16(cd, o + 32);
  const lho = u32(cd, o + 42);
  const name = cd.subarray(o + 46, o + 46 + nameLen).toString('utf8');
  // ZIP64 extra field
  let uncompSize2 = uncompSize, compSize2 = compSize, lho2 = lho;
  let e = o + 46 + nameLen;
  const eEnd = e + extraLen;
  while (e + 4 <= eEnd) {
    const id = u16(cd, e), sz = u16(cd, e + 2);
    if (id === 0x0001) {
      let p = e + 4; const fields = [];
      if (uncompSize === 0xffffffff) { fields.push('uncomp'); }
      if (compSize === 0xffffffff) { fields.push('comp'); }
      if (lho === 0xffffffff) { fields.push('lho'); }
      // ZIP64 extra order: uncomp, comp, lho — only present fields are included
      let idx = 0;
      if (fields[idx] === 'uncomp') { uncompSize2 = u64(cd, p); p += 8; idx++; }
      if (fields[idx] === 'comp') { compSize2 = u64(cd, p); p += 8; idx++; }
      if (fields[idx] === 'lho') { lho2 = u64(cd, p); p += 8; idx++; }
    }
    e += 4 + sz;
  }
  const nameLenC = nameLen, extraLenC = extraLen;
  entries.push({ name, method, uncompSize: uncompSize2, compSize: compSize2, offset: lho2, nameLen: nameLenC, extraLen: extraLenC });
  o += 46 + nameLen + extraLen + commentLen;
}
console.log('parsed entries:', entries.length, '(expected', entryCount + ')');

const byTop = {};
for (const en of entries) {
  const top = en.name.includes('/') ? en.name.split('/')[0] + '/' : en.name;
  byTop[top] = byTop[top] || { count: 0, compBytes: 0, uncompBytes: 0 };
  byTop[top].count++; byTop[top].compBytes += en.compSize; byTop[top].uncompBytes += en.uncompSize;
}
for (const [k, v] of Object.entries(byTop)) {
  console.log(`  ${k}: ${v.count} files, comp ${(v.compBytes / 1e9).toFixed(2)} GB, uncomp ${(v.uncompBytes / 1e9).toFixed(2)} GB`);
}
const stored = entries.filter(e => e.method === 0).length;
console.log(`stored(method 0): ${stored}, deflate(method 8): ${entries.length - stored}`);
const sqlite = entries.filter(e => e.name.endsWith('.sqlite') || e.name.endsWith('.db'));
for (const s of sqlite) console.log('sqlite entry:', JSON.stringify(s));

mkdirSync('scripts/out', { recursive: true });
writeFileSync('scripts/out/zip-entries.json', JSON.stringify(entries));
console.log('wrote scripts/out/zip-entries.json');
