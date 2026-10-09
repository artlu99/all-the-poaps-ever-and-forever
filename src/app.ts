// Runtime-agnostic Hono application. Both the Cloudflare Workers entry
// (src/index.ts, Turso-backed) and the Bun self-host entry (src/bun.ts,
// local SQLite-backed) build their Hono app from this factory.

import { Hono } from 'hono';
import { isAddress, isEnsName, resolveEns, reverseEns } from './ens';
import { injectOg, page404, page500 } from './pages';
import type { POAPStore } from './store';
import { extractZipEntry, isWebp, type Inflater, type RangeFetcher } from './zip';

export interface AppDeps {
  store: POAPStore;
  fetchRange: RangeFetcher; // byte-range reader for archive.zip
  inflate?: Inflater; // defaults to DecompressionStream
  rpcUrls: string[]; // Ethereum JSON-RPC endpoints for ENS
  cache?: { // optional edge/memory cache for artwork
    get(request: Request): Promise<Response | undefined>;
    put(request: Request, response: Response): Promise<void>;
  };
  snapshotDate?: string; // shown in /healthz without hitting the store
  /** index.html with OG placeholders — entries own how it's read */
  getShell: () => Promise<string>;
}

const MAX_TOKENS = 4000; // API cap per collection; whales get truncated
const svgPlaceholder = (dropId: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a2f45"/><stop offset="1" stop-color="#171b2c"/></linearGradient></defs><circle cx="100" cy="100" r="96" fill="url(#g)" stroke="#3b4266" stroke-width="2"/><text x="100" y="112" font-family="system-ui" font-size="30" fill="#5a6390" text-anchor="middle">#${dropId}</text></svg>`;

// Hono params arrive already decoded; decode again only if it round-trips
function softDecode(s: string): string {
  try {
    const decoded = decodeURIComponent(s);
    return encodeURIComponent(decoded) === s ? decoded : s;
  } catch {
    return s;
  }
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/healthz', async (c) => {
    const snapshot = deps.snapshotDate ?? (await deps.store.getSnapshotDate());
    return c.json({ ok: true, snapshot, tokens: 'see snapshot' });
  });

  // Per-wallet SPA shell with X/OG embed tags. Bots ignore #/ fragments, so
  // shareable links use this path form; the SPA boots from either.
  app.get('/p/:owner', async (c) => {
    const raw = softDecode(c.req.param('owner')).trim();
    const owner = isAddress(raw) ? raw.toLowerCase() : isEnsName(raw) ? raw.toLowerCase() : null;
    const html = injectOg(await deps.getShell(), new URL(c.req.url).origin, owner ?? undefined);
    return c.html(html, 200, owner ? { 'Cache-Control': 'public, max-age=600' } : {});
  });

  // Collection lookup: /api/collection/0xabc… or /api/collection/vitalik.eth
  app.get('/api/collection/:owner', async (c) => {
    const raw = softDecode(c.req.param('owner')).trim();
    let address: string;
    let inputWasAddress = false;

    if (isAddress(raw)) {
      address = raw.toLowerCase();
      inputWasAddress = true;
    } else if (isEnsName(raw)) {
      const resolved = await resolveEns(deps.rpcUrls, raw.toLowerCase());
      if (!resolved) {
        return c.json({ error: 'ens-not-found', input: raw }, 404);
      }
      address = resolved.toLowerCase();
    } else {
      return c.json({ error: 'invalid-input', input: raw }, 400);
    }

    const [collection, ens] = await Promise.all([
      deps.store.getCollection(address, MAX_TOKENS),
      inputWasAddress ? reverseEns(deps.rpcUrls, address) : Promise.resolve(null),
    ]);

    c.header('Cache-Control', 'public, max-age=300, s-maxage=3600');
    return c.json({
      input: raw,
      address,
      ens: ens && isEnsName(ens) ? ens : null,
      total: collection.total,
      returned: collection.rows.length,
      truncated: collection.total > collection.rows.length,
      tokens: collection.rows.map((t) => ({
        id: t.poap_id,
        d: t.drop_id,
        ts: t.minted_on,
        net: t.network,
        title: t.title,
        start: t.start_date,
        city: t.city,
        country: t.country,
        fancy: t.fancy_id,
        desc: t.description ? String(t.description).slice(0, 400) : null,
        url: t.event_url,
        virt: !!t.is_virtual,
      })),
    });
  });

  // Artwork: /a/12345.webp — extracted from archive.zip on demand.
  app.get('/a/:file', async (c) => {
    const file = c.req.param('file');
    const m = /^([0-9]+)\.webp$/.exec(file);
    if (!m) return c.text('not found', 404);
    const dropId = Number(m[1]);
    if (!Number.isInteger(dropId) || dropId <= 0 || dropId > 10_000_000) {
      return c.text('bad drop id', 400);
    }
    const cacheKey = new Request(`https://artwork.local/a/${dropId}.webp`);

    if (deps.cache) {
      const hit = await deps.cache.get(cacheKey);
      if (hit) return hit;
    }

    const loc = await deps.store.getArtworkZip(dropId);
    if (!loc) {
      return new Response(svgPlaceholder(dropId), {
        status: 404,
        headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' },
      });
    }

    let bytes: Uint8Array;
    try {
      bytes = await extractZipEntry(
        deps.fetchRange,
        { headerOffset: loc.hdr, dataOff: loc.off, size: loc.size, method: loc.method },
        deps.inflate,
      );
      if (!isWebp(bytes)) throw new Error('not webp');
    } catch (err) {
      console.error(`artwork ${dropId} extract failed`, String(err));
      return new Response(svgPlaceholder(dropId), {
        status: 502,
        headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=600' },
      });
    }

    const response = new Response(bytes as BodyInit, {
      headers: {
        'content-type': 'image/webp',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
    if (deps.cache) {
      c.executionCtx.waitUntil(deps.cache.put(cacheKey, response.clone()));
    }
    return response;
  });

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'not-found' }, 404);
    }
    return c.html(page404, 404);
  });

  app.onError((err, c) => {
    console.error('unhandled error', err);
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'internal' }, 500);
    }
    return c.html(page500, 500);
  });

  return app;
}
