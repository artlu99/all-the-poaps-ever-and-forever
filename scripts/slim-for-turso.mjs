// Build poap-slim.sqlite from the full archive DB:
//   drops       — unchanged schema (PK drop_id)
//   tokens      — drops source_uid (never needed for lookups)
//   artwork_zip — byte offsets of every artwork file inside archive.zip,
//                 so the server can extract artwork on demand via ranges
//   snapshot_metadata — unchanged
// The slim file is what gets imported into Turso (turso db create --from-file)
// and what the Bun self-host entry opens directly.

import Database from 'better-sqlite3';
import { readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const OUT = process.argv[2] || 'poap-slim.sqlite';
if (existsSync(OUT)) {
  console.error(`${OUT} already exists — delete it first if you want to rebuild.`);
  process.exit(1);
}
if (!existsSync('poap.sqlite')) {
  console.error('poap.sqlite not found — run `node scripts/fetch-sqlite.mjs` first.');
  process.exit(1);
}
console.log('reading poap.sqlite …');

const zipEntries = JSON.parse(readFileSync('scripts/out/zip-entries.json', 'utf8'));
const artworks = zipEntries.filter((e) => /^dist\/artwork\/(\d+)\.webp$/.test(e.name));
console.log(`artwork entries in zip index: ${artworks.length}`);

const dst = new Database(OUT);
dst.pragma('journal_mode = WAL');
dst.pragma('synchronous = OFF');

dst.exec(`
  CREATE TABLE drops (
    drop_id INTEGER PRIMARY KEY,
    fancy_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    city TEXT,
    country TEXT,
    event_url TEXT,
    year INTEGER NOT NULL,
    is_virtual INTEGER,
    is_private INTEGER NOT NULL,
    channel TEXT,
    platform TEXT,
    location_type TEXT,
    timezone TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE tokens (
    poap_id INTEGER NOT NULL,
    drop_id INTEGER,
    minted_on INTEGER,
    owner_address TEXT NOT NULL,
    network TEXT NOT NULL,
    transfer_count INTEGER NOT NULL DEFAULT 0
  );
  -- covering index: owner lookups sorted by mint date never touch the table
  CREATE INDEX idx_tokens_owner ON tokens(owner_address, minted_on DESC, poap_id, drop_id, network);
  CREATE TABLE artwork_zip (
    drop_id INTEGER PRIMARY KEY,
    hdr INTEGER NOT NULL,
    off INTEGER NOT NULL,
    size INTEGER NOT NULL,
    method INTEGER NOT NULL
  );
  CREATE TABLE snapshot_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- flat join view for REST querying (sqlite-rest exposes views like tables)
  CREATE VIEW collection AS
  SELECT t.owner_address, t.poap_id, t.drop_id, t.minted_on, t.network,
         d.title, d.start_date, d.city, d.country, d.fancy_id,
         d.description, d.event_url, d.is_virtual
  FROM tokens t JOIN drops d ON d.drop_id = t.drop_id;
`);

dst.exec('ATTACH DATABASE "poap.sqlite" AS src');
dst.exec('INSERT INTO drops SELECT drop_id, fancy_id, title, description, start_date, end_date, city, country, event_url, year, is_virtual, is_private, channel, platform, location_type, timezone, created_at FROM src.drops');
console.log('drops copied:', dst.prepare('SELECT COUNT(*) c FROM drops').get().c);

dst.exec('INSERT INTO tokens SELECT poap_id, drop_id, minted_on, owner_address, network, transfer_count FROM src.tokens');
console.log('tokens copied:', dst.prepare('SELECT COUNT(*) c FROM tokens').get().c);

dst.exec('INSERT INTO snapshot_metadata SELECT key, value FROM src.snapshot_metadata');

// artwork offsets: local extra length is 0 in this zip (validated against
// sampled local headers); data starts at hdr + 30 + nameLen.
const insertArt = dst.prepare('INSERT INTO artwork_zip VALUES (?, ?, ?, ?, ?)');
const insertMany = dst.transaction((rows) => {
  for (const r of rows) insertArt.run(...r);
});
const rows = artworks.map((e) => {
  const dropId = Number(/^dist\/artwork\/(\d+)\.webp$/.exec(e.name)[1]);
  const nameLen = Buffer.byteLength(e.name);
  return [dropId, e.offset, e.offset + 30 + nameLen, e.compSize, e.method];
});
insertMany(rows);
console.log('artwork_zip rows:', dst.prepare('SELECT COUNT(*) c FROM artwork_zip').get().c);

// sanity: local archive.zip present? validate a few offsets against it
if (existsSync('archive.zip')) {
  const fd = openSync('archive.zip', 'r');
  const check = dst.prepare('SELECT * FROM artwork_zip WHERE drop_id = ?');
  for (const id of [1, 2, 100, 229274]) {
    const r = check.get(id);
    if (!r) continue;
    const buf = Buffer.alloc(r.size);
    readSync(fd, buf, 0, r.size, r.off);
    const out = r.method === 0 ? buf : inflateRawSync(buf);
    const ok = out.subarray(0, 4).toString('ascii') === 'RIFF' && out.subarray(8, 12).toString('ascii') === 'WEBP';
    console.log(`local zip check drop ${id}:`, ok ? 'OK' : 'FAIL');
  }
  closeSync(fd);
}

dst.exec('DETACH DATABASE src');

console.log('vacuuming …');
dst.pragma('wal_checkpoint(TRUNCATE)');
dst.pragma('journal_mode = DELETE');
dst.exec('VACUUM');
dst.close();

console.log(`done → ${OUT} (${(statSync(OUT).size / 1e6).toFixed(0)} MB)`);
