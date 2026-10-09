# poaps

Paste an Ethereum address or ENS name, see that wallet's POAPs as a beautiful
swipable grid — **↔ to page, ↕ to zoom, tap a badge for details**.
Mobile-first single page, styled 404/500 pages, zero frontend dependencies.

**POAP has shut down.** The official API is gone and nothing new will ever be
minted — which makes the [POAP Archive](https://poaparchive.com) snapshot the
complete, final record of the protocol:

| tokens | owners | drops | snapshot |
|---|---|---|---|
| 6,218,154 | 1,236,466 | 73,990 | Aug 20, 2026 |

This app is a viewer over that permanent record. It has **zero dependency on
any POAP infrastructure**: collection data comes from a slimmed copy of the
archive's SQLite, artwork is carved out of the archive ZIP with HTTP byte
ranges, and ENS names are resolved with raw `eth_call`s to public Ethereum
RPC gateways. Host it anywhere; it keeps working for as long as you care to.

## The app

- Swipe horizontally to page through the collection, vertically to zoom —
  six zoom levels from 1 to 8 badges across (double-tap cycles too; keyboard
  arrows and ctrl+wheel work on desktop).
- Tap a badge for a detail sheet: artwork, event date and place, chain,
  description, event link, POAP/drop IDs.
- Deterministic identicon per wallet, recent searches (localStorage),
  Web Share / copy-link via bot-friendly `/p/…` URLs, snapshot-date badge on
  the home screen.
- ENS input is resolved server-side; address input gets reverse-ENS'd for the
  header. Paste button, inline validation, friendly errors.

## Architecture

One runtime-agnostic Hono app (`src/app.ts`) — all routes, ENS, and ZIP
extraction logic — plus two entrypoints that differ only in how they feed it:

| | Entrypoint | Data | Artwork |
|---|---|---|---|
| **Cloudflare Workers** | `src/index.ts` | self-hosted sqlite-rest (primary; Turso optional) | ranged fetches from the archive ZIP + edge cache |
| **Bun self-host** | `src/bun.ts` | `poap-slim.sqlite` opened directly (native SQLite) | local `archive.zip` if present, else ranged fetches |

- **Data on the Workers path** comes from a [sqlite-rest](https://github.com/b4fun/sqlite-rest)
  instance serving `poap-slim.sqlite` — the tokens⋈drops join is pre-built as
  the `collection` VIEW, so a lookup is one REST call (`Prefer: count=exact`
  returns the total in `Content-Range`; the count itself hits the bare
  `tokens` table where the covering index answers it without reading rows —
  ~26× faster for whale wallets than counting through the join). A Turso
  store remains available if you prefer managed.
- **ENS** is resolved with direct `eth_call`s to the mainnet registry
  (`src/ens.ts`, own keccak-256 + namehash in `src/keccak.ts` — WebCrypto
  ships SHA3 but not Keccak — no API keys, no third-party services). Forward
  *and* reverse resolution, with failover across the RPC list.
- **Artwork** is extracted on demand from `archive.zip` (15.9 GB; 74,067
  webp files) using HTTP byte ranges — offsets are precomputed into the DB's
  `artwork_zip` table, so a badge costs one small ranged read plus inflate.
  The extractor validates the WebP magic and re-parses the local ZIP header
  once as a fallback; the ranged fetcher retries and cancels if the origin
  answers `200` with the whole 15.9 GB instead of `206`. 100 drops (0.14%)
  shipped without artwork in the archive and get a generated placeholder
  badge. Responses are `immutable` and edge-cached on Workers (an in-memory
  cache stands in on Bun).
- The snapshot's SQLite needed only slimming (`poap-slim.sqlite`, ~910 MB
  incl. a covering index and the `collection` view) — no transformation
  pipeline, nothing about it ever needs refreshing.

### Repository layout

```
src/
  app.ts                shared Hono app: routes, OG injection, ZIP extraction
  index.ts              Workers entry: store choice, edge cache, rate limits
  bun.ts                Bun entry: direct SQLite, static files, mem cache
  store.ts              POAPStore interface + shared SQL
  sqlite-rest-store.ts  REST client for the sqlite-rest instance
  ens.ts, keccak.ts     ENS via raw eth_call; dependency-free keccak-256
  zip.ts                ranged ZIP entry extraction + WebP validation
  pages.ts              styled 404/500 + OG placeholder injection
public/                 the SPA (index.html, app.js, app.css), 404/500, og.png
scripts/                archive tooling: zip-peek, fetch-sqlite, slim-for-turso
tests/                  known-vector tests for the ENS math
```

## Data files

The repo is small on purpose: every multi-GB artifact is gitignored (GitHub's
per-file push limit is 100 MB anyway) and reproducible from the POAP Archive
using the scripts in `scripts/`. Nothing here is a mystery backup — each file
has exactly one producer:

| File | Size | Produced by | What it is |
|---|---|---|---|
| `poap.sqlite` | ~1.5 GB | `npm run fetch:sqlite` | the archive's full snapshot DB, downloaded as just the `dist/poap.sqlite` ZIP member |
| `poap-slim.sqlite` | ~910 MB | `npm run build:db` | the serving DB — what Bun opens directly and what you import into Turso / serve with sqlite-rest |
| `scripts/out/zip-entries.json` | ~9 MB | `npm run fetch:sqlite` (first half) | the ZIP's parsed central directory; `build:db` reads it for the artwork byte offsets, so it must exist before slimming |
| `archive.zip` | 15.9 GB | direct download, optional | the full archive; needed only to serve artwork from local disk |

```
archive.zip  (downloads.poaparchive.com — override with ZIP_URL=…)
   │   ranged reads only, never a full download (needs curl)
   ├──▶ poap.sqlite                    ~609 MB compressed member → ~1.5 GB inflated
   └──▶ scripts/out/zip-entries.json   ZIP tail + central directory
poap.sqlite ──▶ poap-slim.sqlite       drops + tokens(+covering index) + artwork_zip
                                        + snapshot_metadata + `collection` VIEW
```

- `npm run fetch:sqlite` runs `scripts/zip-peek.mjs` then
  `scripts/fetch-sqlite.mjs`: zip-peek reads only the ZIP's last 64 KB and
  central directory over ranged requests to index every member;
  fetch-sqlite then downloads exactly the `dist/poap.sqlite` member and
  inflates it. Both shell out to `curl`.
- `npm run build:db` (`scripts/slim-for-turso.mjs`) refuses to overwrite an
  existing `poap-slim.sqlite` — delete the file to rebuild. If `archive.zip`
  sits next to it, the build self-checks sampled artwork offsets against the
  real ZIP.
- Already have `archive.zip` locally? Skip the 609 MB download:
  `unzip archive.zip dist/poap.sqlite`, then `node scripts/zip-peek.mjs`
  (cheap — central directory only) and `npm run build:db`.
- Disk usage: ~2.4 GB for the required path, +15.9 GB with the optional ZIP.

## Local development (Bun path)

```sh
npm install
npm run fetch:sqlite   # → poap.sqlite      (~609 MB download, ~1.5 GB file)
npm run build:db       # → poap-slim.sqlite (~910 MB)
bun run src/bun.ts     # http://localhost:8787
```

`npm run dev:bun` is a shortcut for the last step. See **Data files** above
for exactly what each command produces and where the bytes come from. Place
the full `archive.zip` (15.9 GB, optional) next to `poap-slim.sqlite` to
serve artwork from local disk — worth doing for long-term preservation,
since it removes even the dependency on `downloads.poaparchive.com` staying
up.

## Deploying to Cloudflare Workers

> wrangler's local dev runtime (workerd) needs macOS 13.5+ / Node 22 for
> wrangler 4 — this repo pins wrangler 3 so `wrangler deploy` works on older
> toolchains. Test locally via the Bun path above; `wrangler dev` is not
> required (if you do use it, copy `.dev.vars.example` to `.dev.vars`).

1. **Serve the DB with your sqlite-rest instance** (once):

   ```sh
   sqlite-rest serve --db-dsn poap-slim.sqlite \
     --auth-token-file /path/to/secret \
     --security-allow-table collection,artwork_zip,snapshot_metadata,tokens
   ```

   The allow-list exposes only what the Worker queries. Generate a bearer
   JWT signed with the same secret for the Worker.

2. **Configure the Worker secrets**:

   ```sh
   npx wrangler secret put SQLITE_REST_URL     # your instance's base URL
   npx wrangler secret put SQLITE_REST_TOKEN   # the bearer JWT
   ```

   Prefer Turso instead? `turso db create poaps --from-file poap-slim.sqlite`,
   then set `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` — the code picks
   whichever pair is present (sqlite-rest wins if both are set).

3. **Deploy**:

   ```sh
   npx wrangler deploy
   ```

## Configuration

| Var | Runtime | Default | What |
|---|---|---|---|
| `SQLITE_REST_URL` / `SQLITE_REST_TOKEN` | Workers (secret) | — | primary store; either pair selects the backend |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Workers (secret) | — | alternative store |
| `ZIP_URL` | both | `downloads.poaparchive.com/archive.zip` | where artwork byte ranges come from — point it at your own mirror (e.g. R2) for full independence |
| `RPC_URLS` | both | 4 public Ethereum RPCs | comma-separated endpoints for ENS |
| `DB_PATH` | Bun | `./poap-slim.sqlite` | which slim DB to open |
| `ZIP_PATH` | Bun | `./archive.zip` if it exists | local ZIP for artwork |
| `PORT` | Bun | `8787` | listen port |

## HTTP API

| Route | What |
|---|---|
| `/` | the app |
| `#/vitalik.eth` | deep-linkable collections (hash routing) |
| `GET /p/:owner` | same app, path-routed with per-wallet X/OG embed tags |
| `GET /api/collection/:owner` | tokens + drop metadata (owner = address or ENS) |
| `GET /a/:dropId.webp` | artwork, extracted from the ZIP, immutable cache |
| `GET /healthz` | snapshot date liveness probe |
| anything else | styled 404 (JSON under `/api/`), styled 500 on errors |

`/api/collection/vitalik.eth` (abridged; collections cap at 4,000 tokens —
the largest wallet in the snapshot holds 35,359, and such responses say
`truncated: true`):

```json
{
  "input": "vitalik.eth",
  "address": "0xd8da…6045",
  "ens": "vitalik.eth",
  "total": 152,
  "returned": 152,
  "truncated": false,
  "tokens": [
    {
      "id": 7566546,
      "d": 226135,
      "ts": 1771430406,
      "net": "celo",
      "title": "You've met 0xj4an.eth during ETHDenver 2026",
      "start": "2026-02-28T00:00:00.000Z",
      "city": "Denver",
      "country": "USA",
      "fancy": "16089c46-17bd-42e1-b46d-1a14ebd9a1aa",
      "desc": "Met 0xj4an.eth during ETHDenver 2026, a ReFi and Celo native…",
      "url": "https://ethdenver.com",
      "virt": false
    }
  ]
}
```

## Rate limiting

Two Cloudflare [rate-limit bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limiting/)
defined in `wrangler.jsonc`, enforced per IP (`CF-Connecting-IP`) in
`src/index.ts`:

| Binding | Path | Limit | Window |
|---|---|---|---|
| `RATE_LIMIT_API` | `/api/*` | 100 | 60 s |
| `RATE_LIMIT_ART` | `/a/*` | 600 | 60 s |

Over the limit → `429` with `Retry-After: 60`. The artwork budget is
deliberately generous: swiping through a whale collection lazy-loads dozens
of images per page, and artwork responses are immutable edge-cached anyway.
The limiter fails open (a Cloudflare hiccup can't take the site down). Tune
the numbers in `wrangler.jsonc` and redeploy.

> wrangler 3 needs these under `unsafe.bindings` (a pass-through escape
> hatch, mildly warning-flagged); on wrangler 4+ they can move to the
> top-level `bindings` array as-is.

If you'd rather block crawlers *before* they consume Worker invocations, the
dashboard alternative is one free-plan WAF Rate Limiting rule on
`path starts with /api/ or /a/` (e.g. 120 req/60 s per IP → block 10 min).
The built-in bindings above make that optional, not required.

## X / OpenGraph embeds

X's crawler **drops URL fragments**, so `#/vitalik.eth` links unfurl as the
generic homepage — shareable links use the path form instead:

- `GET /p/:owner` serves the SPA with per-wallet embed tags
  (`twitter:title` = "vitalik.eth on poaps"; the app boots from either form)
- the Share button emits `/p/…` URLs
- `og:image` / `twitter:image` point at `/og.png` (1200×600,
  `summary_large_image` card); `{{ORIGIN}}` placeholders in `index.html` are
  replaced with the request origin at serve time, so image URLs are always
  absolute as bots require
- on Workers, `assets.run_worker_first` routes everything through the Worker,
  which falls through to the ASSETS binding for static files

To regenerate the card after a design change: edit `public/og.html` (it pulls
real badge artwork from `/a/…`), open it at 1200×600, screenshot to
`public/og.png`. Validate live embeds after deploying by posting any `/p/…`
link in an X draft and checking the preview.

## Tests

```sh
npm test
```

Known-vector tests for the ENS math (`tests/ens.test.mjs`): keccak-256
against published digests, namehash against the ENSIP-1 reference vectors,
and the three `eth_call` selectors against the canonical signatures. If any
of these regress, every lookup would silently return null — the tests are
what make that loud.

## Notes & limits

- The archive is a static final snapshot — that's the point. Nothing about it
  needs refreshing.
- ENS label normalization is plain lowercase (ASCII); exotic unicode/emoji
  names may not resolve. ENS itself still lives on Ethereum, so name records
  can still change even though POAP can't.
- The API caps collections at 4,000 tokens per response; `truncated: true`
  says when. The UI shows the full total with a "showing first N" note.
- `package-lock.json` is gitignored; `npm install` resolves fresh.

## License

[MIT](LICENSE)
