// Bun self-host entrypoint: zero third parties. Reads poap-slim.sqlite
// directly (native Bun SQLite), serves public/ as static files, and extracts
// artwork from a local archive.zip if present — falling back to ranged
// fetches from downloads.poaparchive.com when it isn't.
//
//   bun run src/bun.ts            # http://localhost:8787
//
// Env: DB_PATH, ZIP_PATH (default: ./archive.zip if it exists), ZIP_URL, RPC_URLS, PORT

import { existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { Database } from 'bun:sqlite';
import { createApp } from './app';
import { injectOg } from './pages';
import { COLLECTION_COUNT_SQL, COLLECTION_SQL, type ArtworkZipEntry, type POAPStore, type TokenRow } from './store';
import { makeRemoteRangeFetcher } from './zip';

const ROOT = new URL('..', import.meta.url).pathname; // project root, cwd-independent

const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.DB_PATH || ROOT + 'poap-slim.sqlite';
const ZIP_URL = process.env.ZIP_URL || 'https://downloads.poaparchive.com/archive.zip';
const RPC_URLS = (process.env.RPC_URLS || 'https://evm.stupidtech.net/v1/1,https://ethereum-rpc.publicnode.com,https://eth.llamarpc.com,https://eth.drpc.org')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const db = new Database(DB_PATH, { readonly: true });
db.exec('PRAGMA cache_size = -131072'); // 128 MB page cache for self-host
const countStmt = db.prepare(COLLECTION_COUNT_SQL);
const collectionStmt = db.prepare(COLLECTION_SQL);
const artworkStmt = db.prepare('SELECT hdr, off, size, method FROM artwork_zip WHERE drop_id = ?');
const snapshotStmt = db.prepare("SELECT value FROM snapshot_metadata WHERE key = 'snapshot_at'");

let snapshotCache: string | null | undefined;

const store: POAPStore = {
  getCollection(owner: string, limit: number) {
    const total = Number((countStmt.get(owner) as { total: number }).total);
    const rows = collectionStmt.all(owner, limit) as unknown as TokenRow[];
    return Promise.resolve({ rows, total });
  },
  getArtworkZip(dropId: number) {
    const row = artworkStmt.get(dropId) as { hdr: number; off: number; size: number; method: number } | null;
    return Promise.resolve(row ?? null);
  },
  getSnapshotDate() {
    if (snapshotCache === undefined) {
      const row = snapshotStmt.get() as { value: string } | null;
      snapshotCache = row ? row.value : null;
    }
    return Promise.resolve(snapshotCache);
  },
};

const localZipPath = process.env.ZIP_PATH || ROOT + 'archive.zip';
const localZip = existsSync(localZipPath) ? Bun.file(localZipPath) : null;
if (localZip) console.log(`artwork: local ${localZip.name} (${(localZip.size / 1e9).toFixed(1)} GB)`);
else console.log(`artwork: ranged fetches from ${ZIP_URL} (place archive.zip locally to self-serve)`);

let shellCache: string | null = null;
const getShell = async (): Promise<string> => {
  shellCache ??= await Bun.file(`${ROOT}public/index.html`).text();
  return shellCache;
};

const app = createApp({
  store,
  rpcUrls: RPC_URLS,
  getShell,
  // Bun's native inflater — synchronous and fast
  inflate: (data) => Promise.resolve(new Uint8Array(inflateRawSync(Buffer.from(data)))),
  fetchRange: localZip
    ? (start, end) => localZip.slice(start, end + 1).arrayBuffer()
    : makeRemoteRangeFetcher(ZIP_URL),
});

// tiny in-memory artwork cache for self-host (edge cache stand-in)
const memCache = new Map<string, Response>();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);

    // static files from public/ (path traversal safe); dynamic prefixes go to Hono
    const isDynamic = url.pathname.startsWith('/api/') || url.pathname.startsWith('/a/') || url.pathname.startsWith('/p/') || url.pathname === '/healthz';
    if (req.method === 'GET' && !isDynamic) {
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      const safe = !path.split('/').some((seg) => seg === '..' || seg === '%2e%2e');
      const file = safe ? Bun.file(`${ROOT}public${path}`) : null;
      if (file && (await file.exists())) {
        const ext = path.slice(path.lastIndexOf('.'));
        // the shell gets OG placeholders swapped for absolute URLs at serve time
        if (path === '/index.html') {
          const html = injectOg(await file.text(), url.origin);
          return new Response(html, { headers: { 'content-type': MIME['.html'], 'cache-control': 'no-cache' } });
        }
        return new Response(file, {
          headers: { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' },
        });
      }
      const notFound = Bun.file(`${ROOT}public/404.html`);
      if (await notFound.exists()) {
        return new Response(notFound, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
    }

    const res = await app.fetch(req);
    // memoize artwork in-process (edge cache stand-in)
    if (res.ok && url.pathname.startsWith('/a/')) {
      const cached = memCache.get(url.pathname);
      if (cached) return cached;
      if (memCache.size > 400) memCache.clear();
      memCache.set(url.pathname, res.clone());
    }
    return res;
  },
});

console.log(`poaps (bun self-host) listening on http://localhost:${PORT}`);
console.log(`db: ${DB_PATH} · snapshot ${snapshotCache ?? (await store.getSnapshotDate())}`);
