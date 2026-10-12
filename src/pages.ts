// Shared styled error pages (used by Hono handlers; standalone copies live in public/).

const shell = (title: string, emoji: string, body: string) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} · poaps</title>
<link rel="stylesheet" href="/app.css">
</head>
<body class="error-page">
<div id="bg" aria-hidden="true"></div>
<main class="error-card">
  <div class="error-coin">${emoji}</div>
  <h1>${title}</h1>
  ${body}
  <p><a class="btn" href="/">Take me home</a></p>
</main>
</body></html>`;

export const page404 = shell(
  '404 — nothing minted here',
  '🛸',
  '<p>This page doesn’t exist — like a POAP for an event that never happened.</p>',
);

export const page500 = shell(
  '500 — something broke',
  '💥',
  '<p>An unexpected error occurred on our side. It has been logged. Try again in a moment.</p>',
);

// ---------- OG / X card injection ----------

const DEFAULT_OG = { title: 'poaps', desc: 'The archival POAP explorer — paste any address or ENS name and swipe through its badges.' };

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Replace the {{ORIGIN}} / {{PLAYER_URL}} / {{TWITTER_TITLE}} / {{TWITTER_DESC}}
 * placeholders in public/index.html. Bots (X above all) require absolute
 * image URLs and ignore URL fragments, so per-wallet embeds need the
 * /p/:owner path form. The player iframe is /play or /play/:owner.
 * `owner` is already lowercased by callers.
 */
export function injectOg(html: string, origin: string, owner?: string): string {
  const og = owner
    ? { title: `${owner} on poaps`, desc: `Explore ${owner}'s POAP collection — the archival explorer for the final POAP snapshot.` }
    : DEFAULT_OG;
  const playerUrl = owner ? `${origin}/play/${owner}` : `${origin}/play`;
  return html
    .replaceAll('{{ORIGIN}}', origin)
    .replaceAll('{{PLAYER_URL}}', playerUrl)
    .replaceAll('{{TWITTER_TITLE}}', og.title)
    .replaceAll('{{TWITTER_DESC}}', og.desc)
    .replaceAll('<title>poaps</title>', `<title>${og.title}</title>`);
}

/** Framable player document. X iframes this; the module fills #player. */
export function playerShell(owner?: string): string {
  const ownerAttr = owner === undefined ? '' : ` data-owner="${escapeHtml(owner)}"`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>poaps</title>
<link rel="stylesheet" href="/play.css">
</head>
<body>
<div id="player"${ownerAttr}></div>
<script type="module" src="/play.js"></script>
</body>
</html>`;
}
