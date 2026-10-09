// Fetch only dist/poap.sqlite from the remote archive.zip using ranged requests,
// parse its local file header, stream-inflate the deflate data to poap.sqlite.
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const URL_ = process.env.ZIP_URL || 'https://downloads.poaparchive.com/archive.zip';
const entries = JSON.parse((await import('node:fs')).readFileSync('scripts/out/zip-entries.json', 'utf8'));
const sq = entries.find(e => e.name === 'dist/poap.sqlite');
console.log('entry:', JSON.stringify(sq));

// local header: 30 bytes fixed + name + extra (extra may differ from central dir)
const head = Buffer.from(execFileSync('curl', ['-sS', '--fail', '--max-time', '60', '-r', `${sq.offset}-${sq.offset + 99}`, URL_]));
if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('local header sig mismatch');
const nameLen = head.readUInt16LE(26), extraLen = head.readUInt16LE(28);
const dataStart = sq.offset + 30 + nameLen + extraLen;
const dataEnd = dataStart + sq.compSize - 1;
console.log(`data range: ${dataStart}-${dataEnd} (${(sq.compSize / 1e6).toFixed(0)} MB compressed)`);

console.log('downloading + inflating...');
const t0 = Date.now();
const curl = execFileSync('curl', ['-sS', '--fail', '--max-time', '3600', '-r', `${dataStart}-${dataEnd}`, URL_], {
  maxBuffer: 2 * 1024 * 1024 * 1024,
});
console.log(`downloaded ${curl.length} bytes in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (curl.length !== sq.compSize) throw new Error(`size mismatch: got ${curl.length}, want ${sq.compSize}`);

const inflated = zlib.inflateRawSync(curl);
console.log('inflated:', inflated.length, 'bytes (expected', sq.uncompSize + ')');
await pipeline(
  (async function* () { yield inflated; })(),
  createWriteStream('poap.sqlite'),
);
console.log('wrote poap.sqlite');
