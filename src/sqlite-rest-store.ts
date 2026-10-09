// POAPStore backed by a self-hosted sqlite-rest instance
// (github.com/b4fun/sqlite-rest) serving poap-slim.sqlite. The tokens⋈drops
// join is exposed as the `collection` VIEW (views appear as queryable
// tables), so a collection lookup is a single REST call whose exact total
// arrives in the Content-Range header via `Prefer: count=exact`.

import type { ArtworkZipEntry, POAPStore, TokenRow } from './store';

export interface SqliteRestOptions {
  baseUrl: string; // e.g. https://sqlite-rest.example.com
  token?: string; // bearer JWT (server refuses requests without auth)
}

const COLLECTION_SELECT =
  'poap_id,drop_id,minted_on,network,title,start_date,city,country,fancy_id,description,event_url,is_virtual';

const asRow = (r: Record<string, unknown>): TokenRow => ({
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
});

export function createSqliteRestStore({ baseUrl, token }: SqliteRestOptions): POAPStore {
  const base = baseUrl.replace(/\/+$/, '');

  async function restGet<T>(
    table: string,
    params: Record<string, string>,
    exactCount = false,
  ): Promise<{ rows: T[]; total: number | null }> {
    const u = new URL(`${base}/${table}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const res = await fetch(u.toString(), {
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(exactCount ? { prefer: 'count=exact' } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`sqlite-rest ${table}: ${res.status}`);
    const rows = (await res.json()) as T[];
    // Content-Range: "0-3999/35359" — total after the slash
    const total = Number(res.headers.get('content-range')?.split('/')[1]);
    return { rows, total: Number.isFinite(total) ? total : null };
  }

  return {
    async getCollection(owner: string, limit: number) {
      // rows come from the joined view; the count hits the bare tokens table,
      // which the covering index answers without touching rows (~26x faster
      // for whale wallets than counting through the join)
      const [rowsRes, countRes] = await Promise.all([
        restGet<Record<string, unknown>>(
          'collection',
          {
            owner_address: `eq.${owner}`,
            order: 'minted_on.desc',
            limit: String(Math.min(limit, 4000)),
            select: COLLECTION_SELECT,
          },
          true,
        ),
        restGet<unknown>(
          'tokens',
          { owner_address: `eq.${owner}`, select: 'poap_id', limit: '1' },
          true,
        ),
      ]);
      return { rows: rowsRes.rows.map(asRow), total: countRes.total ?? rowsRes.total ?? rowsRes.rows.length };
    },

    async getArtworkZip(dropId: number): Promise<ArtworkZipEntry | null> {
      const { rows } = await restGet<Record<string, unknown>>('artwork_zip', {
        drop_id: `eq.${dropId}`,
        select: 'hdr,off,size,method',
        limit: '1',
      });
      const r = rows[0];
      if (!r) return null;
      return { hdr: Number(r.hdr), off: Number(r.off), size: Number(r.size), method: Number(r.method) };
    },

    async getSnapshotDate() {
      const { rows } = await restGet<{ value: string }>('snapshot_metadata', {
        key: 'eq.snapshot_at',
        select: 'value',
        limit: '1',
      });
      return rows[0]?.value ?? null;
    },
  };
}
