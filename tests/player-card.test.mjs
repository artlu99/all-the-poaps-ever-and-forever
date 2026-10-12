// X's crawler does not run JavaScript. The shared /p/:owner response has to
// already contain player-card meta tags, and /play/:owner is the page X
// iframes — framable, useful with no login, and carrying the owner in the HTML.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'scripts/out'), { recursive: true });
buildSync({
  entryPoints: [join(root, 'src/app.ts')],
  bundle: true,
  format: 'esm',
  outfile: join(root, 'scripts/out/app.test-bundle.mjs'),
});
const { createApp } = await import('../scripts/out/app.test-bundle.mjs');

const store = {
  getCollection: async () => ({ rows: [], total: 0 }),
  getArtworkZip: async () => null,
  getSnapshotDate: async () => null,
};

const app = createApp({
  store,
  fetchRange: async () => new ArrayBuffer(0),
  rpcUrls: [],
  getShell: async () => readFileSync(join(root, 'public/index.html'), 'utf8'),
});

const FRAME_ANCESTORS = ['https://x.com', 'https://twitter.com', 'https://platform.twitter.com'];
const ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const ADDRESS_LOWER = ADDRESS.toLowerCase();

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function metaContent(html, name) {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const nameMatch = tag.match(/(?:^|\s)name\s*=\s*"([^"]*)"/i);
    const contentMatch = tag.match(/(?:^|\s)content\s*=\s*"([^"]*)"/i);
    if (nameMatch?.[1] === name) return contentMatch?.[1];
  }
  return undefined;
}

function assertFramable(res) {
  assert.equal(
    res.headers.get('x-frame-options'),
    null,
    'X-Frame-Options DENY or SAMEORIGIN would stop X from iframing the card',
  );
  const csp = res.headers.get('content-security-policy') ?? '';
  const directive = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => /^frame-ancestors\b/i.test(part));
  assert.ok(directive, `Content-Security-Policy frame-ancestors missing, got ${csp || '(none)'}`);
  const sources = directive.split(/\s+/).slice(1);
  for (const origin of FRAME_ANCESTORS) {
    assert.ok(sources.includes(origin), `frame-ancestors missing ${origin}: ${directive}`);
  }
}

function assertPlayerShell(html, owner) {
  assert.match(html, /<html[\s>]/i);
  const escaped = escapeHtml(owner);
  assert.ok(
    html.includes(`data-owner="${escaped}"`),
    `player HTML should expose ${owner} as an escaped data-owner attribute`,
  );
}

test('GET /p/:owner HTML already contains X player-card tags for an ENS name', async () => {
  const origin = 'http://cards.test';
  const res = await app.request(`${origin}/p/vitalik.eth`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/html\b/);
  const html = await res.text();

  assert.equal(metaContent(html, 'twitter:card'), 'player');
  assert.equal(metaContent(html, 'twitter:player'), `${origin}/play/vitalik.eth`);
  assert.equal(metaContent(html, 'twitter:player:width'), '480');
  assert.equal(metaContent(html, 'twitter:player:height'), '480');
  assert.equal(metaContent(html, 'twitter:image'), `${origin}/og.png`);
  assert.match(metaContent(html, 'twitter:title') ?? '', /vitalik\.eth/);

  const mixed = await app.request(`${origin}/p/Vitalik.ETH`);
  assert.equal(mixed.status, 200);
  const mixedHtml = await mixed.text();
  assert.equal(metaContent(mixedHtml, 'twitter:player'), `${origin}/play/vitalik.eth`);
  assert.match(metaContent(mixedHtml, 'twitter:title') ?? '', /vitalik\.eth/);
});

test('GET /p/:owner lowercases an address in the player URL', async () => {
  const origin = 'http://cards.test';
  const res = await app.request(`${origin}/p/${ADDRESS}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.equal(metaContent(html, 'twitter:card'), 'player');
  assert.equal(metaContent(html, 'twitter:player'), `${origin}/play/${ADDRESS_LOWER}`);
  assert.equal(metaContent(html, 'twitter:image'), `${origin}/og.png`);
  assert.match(metaContent(html, 'twitter:title') ?? '', new RegExp(ADDRESS_LOWER));
});

test('GET /play/:owner is framable HTML that exposes the owner without auth', async () => {
  const res = await app.request('http://cards.test/play/vitalik.eth');
  assert.equal(res.status, 200, 'player page should be useful without redirecting to a login');
  assert.equal(res.headers.get('location'), null);
  assert.match(res.headers.get('content-type') ?? '', /^text\/html\b/);
  assertFramable(res);
  assertPlayerShell(await res.text(), 'vitalik.eth');

  const mixed = await app.request('http://cards.test/play/Vitalik.ETH');
  assert.equal(mixed.status, 200);
  assertFramable(mixed);
  assertPlayerShell(await mixed.text(), 'vitalik.eth');

  const byAddress = await app.request(`http://cards.test/play/${ADDRESS}`);
  assert.equal(byAddress.status, 200);
  assertFramable(byAddress);
  assertPlayerShell(await byAddress.text(), ADDRESS_LOWER);
});

test('GET /play is framable HTML so the homepage can point a card at it', async () => {
  const res = await app.request('http://cards.test/play');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('location'), null);
  assert.match(res.headers.get('content-type') ?? '', /^text\/html\b/);
  const html = await res.text();
  assert.match(html, /<html[\s>]/i);
  assertFramable(res);
});

test('GET /play/not a name does not return a player shell', async () => {
  const res = await app.request(`http://cards.test/play/${encodeURIComponent('not a name')}`);
  assert.ok(
    res.status === 400 || res.status === 404,
    `invalid owner should be 400 or 404, got ${res.status}`,
  );
});
