// Cloudflare Workers entrypoint. Data comes from a self-hosted sqlite-rest
// instance (primary) or Turso (alternative) — both serve the same
// poap-slim.sqlite. Artwork is extracted on demand from archive.zip via HTTP
// byte ranges, then cached at the edge.

import { createClient, type Client } from '@libsql/client';
import { Hono } from 'hono';
import { createApp } from './app';
import { injectOg } from './pages';
import { createSqliteRestStore } from './sqlite-rest-store';
import { COLLECTION_COUNT_SQL, COLLECTION_SQL, type ArtworkZipEntry, type POAPStore, type TokenRow } from './store';
import { makeRemoteRangeFetcher } from './zip';

interface Env {
  ASSETS: Fetcher; // Workers static assets binding
  SQLITE_REST_URL?: string; // e.g. https://sqlite-rest.example.com — primary
  SQLITE_REST_TOKEN?: string; // bearer JWT
  TURSO_DATABASE_URL?: string; // alternative store
  TURSO_AUTH_TOKEN?: string;
  ZIP_URL?: string;
  RPC_URLS?: string;
  // rate-limit bindings from wrangler.jsonc (optional so dev tooling can omit them)
  RATE_LIMIT_API?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  RATE_LIMIT_ART?: { limit(input: { key: string }): Promise<{ success: boolean }> };
}

/* ---------- Turso store (alternative) ---------- */

let tursoClient: Client | null = null;
let snapshotCache: string | null | undefined;

const tursoStore: POAPStore = {
  async getCollection(owner: string, limit: number) {
    const countRs = await tursoClient!.execute({ sql: COLLECTION_COUNT_SQL, args: [owner] });
    const total = Number(countRs.rows[0]?.total ?? 0);
    const rs = await tursoClient!.execute({ sql: COLLECTION_SQL, args: [owner, limit] });
    const rows: TokenRow[] = rs.rows.map((r) => ({
      poap_id: Number(r.poap_id),
      drop_id: Number(r.drop_id),
      minted_on: Number(r.minted_on),
      network: String(r.network),
      title: String(r.title),
      start_date: String(r.start_date),
      city: r.city == null ? null : String(r.city),
      country: r.country == null ? null : String(r.country),
      fancy_id: String(r.fancy_id),
      description: r.description == null ? null : String(r.description),
      event_url: r.event_url == null ? null : String(r.event_url),
      is_virtual: r.is_virtual == null ? null : Number(r.is_virtual),
    }));
    return { rows, total };
  },

  async getArtworkZip(dropId: number): Promise<ArtworkZipEntry | null> {
    const rs = await tursoClient!.execute({
      sql: 'SELECT hdr, off, size, method FROM artwork_zip WHERE drop_id = ?',
      args: [dropId],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return { hdr: Number(row.hdr), off: Number(row.off), size: Number(row.size), method: Number(row.method) };
  },

  async getSnapshotDate() {
    if (snapshotCache !== undefined) return snapshotCache;
    try {
      const rs = await tursoClient!.execute(
        "SELECT value FROM snapshot_metadata WHERE key = 'snapshot_at'",
      );
      snapshotCache = rs.rows[0] ? String(rs.rows[0].value) : null;
    } catch {
      snapshotCache = null;
    }
    return snapshotCache;
  },
};

/* ---------- worker wiring ---------- */

const ZIP_URL_DEFAULT = 'https://downloads.poaparchive.com/archive.zip';
const RPC_URLS_DEFAULT =
  'https://evm.stupidtech.net/v1/1,https://ethereum-rpc.publicnode.com,https://eth.llamarpc.com,https://eth.drpc.org';

let app: Hono | null = null;

/** 429 with Retry-After; JSON for API paths, plain text otherwise. */
function tooManyRequests(isApi: boolean): Response {
  return new Response(isApi ? '{"error":"rate-limited"}' : 'slow down a little', {
    status: 429,
    headers: {
      'content-type': isApi ? 'application/json' : 'text/plain; charset=utf-8',
      'retry-after': '60',
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!app) {
      let store: POAPStore;
      if (env.SQLITE_REST_URL) {
        store = createSqliteRestStore({ baseUrl: env.SQLITE_REST_URL, token: env.SQLITE_REST_TOKEN });
      } else if (env.TURSO_DATABASE_URL) {
        tursoClient = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
        store = tursoStore;
      } else {
        store = {
          getCollection: () => Promise.resolve({ rows: [], total: 0 }),
          getArtworkZip: () => Promise.resolve(null),
          getSnapshotDate: () => Promise.resolve(null),
        };
      }
      const zipUrl = env.ZIP_URL || ZIP_URL_DEFAULT;
      const rpcUrls = (env.RPC_URLS || RPC_URLS_DEFAULT).split(',').map((s) => s.trim()).filter(Boolean);

      // index.html via the assets binding (run_worker_first routes "/" and
      // "/p/*" here so OG placeholders can be injected with absolute URLs)
      let shellCache: string | null = null;
      const getShell = async (): Promise<string> => {
        if (shellCache === null) {
          const asset = await env.ASSETS.fetch(new Request(new URL(request.url).origin + '/index.html'));
          shellCache = await asset.text();
        }
        return shellCache;
      };

      app = createApp({
        store,
        rpcUrls,
        getShell,
        fetchRange: makeRemoteRangeFetcher(zipUrl, true),
        cache: {
          get: (req) => caches.default.match(req),
          put: (req, res) => caches.default.put(req, res),
        },
      });
      app.get('/', async (c) => c.html(injectOg(await getShell(), new URL(c.req.url).origin)));
    }

    // per-IP rate limiting (limits defined by the wrangler.jsonc bindings)
    const pathname = new URL(request.url).pathname;
    const isApi = pathname.startsWith('/api/');
    const limiter = isApi ? env.RATE_LIMIT_API : pathname.startsWith('/a/') ? env.RATE_LIMIT_ART : undefined;
    if (limiter) {
      const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
      // fail open: a limiter hiccup shouldn't take the site down
      const { success } = await limiter.limit({ key }).catch(() => ({ success: true }));
      if (!success) return tooManyRequests(isApi);
    }

    const honoResponse = await app.fetch(request, env, {
      waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p),
      passThroughOnException: () => {},
    } as ExecutionContext);

    // run_worker_first sends everything here; serve static assets the app
    // didn't handle (404 → try ASSETS → styled 404 if still nothing)
    if (honoResponse.status === 404 && request.method === 'GET' && !pathname.startsWith('/api/')) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }
    return honoResponse;
  },
};
