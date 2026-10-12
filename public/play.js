// Player card. Renders inside an X iframe (~440×480), the native X viewer,
// or a normal browser. The collection is public, so this view never signs in
// and never touches storage — sandboxed cards often throw on sessionStorage.

const root = document.getElementById('player');
const owner = (root?.dataset.owner || '').trim();

const inIframe = window.self !== window.top;
const storageOk = (() => {
  try {
    sessionStorage.setItem('__probe', '1');
    sessionStorage.removeItem('__probe');
    return true;
  } catch {
    return false;
  }
})();
void storageOk;

const COLS = 3;

if (!root) {
  // nothing to mount
} else if (!owner) {
  renderLookup();
} else {
  load(owner);
}

function renderLookup() {
  root.innerHTML = '';
  const wrap = el('div', 'lookup');
  wrap.append(el('h1', null, 'poaps'));
  wrap.append(el('p', null, 'Paste an address or ENS name to swipe its badges.'));
  const form = document.createElement('form');
  const input = document.createElement('input');
  input.name = 'owner';
  input.placeholder = 'vitalik.eth';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Ethereum address or ENS name');
  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = 'Explore';
  const err = el('p', 'err');
  form.append(input, button, err);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!isOwner(value)) {
      err.textContent = 'that doesn’t look like an address or ENS name';
      return;
    }
    // Stay inside the card. A full navigation keeps the iframe on /play/:owner.
    location.assign(`/play/${encodeURIComponent(value)}`);
  });
  wrap.append(form);
  root.append(wrap);
}

async function load(input) {
  root.replaceChildren(status('Fetching badges…'));
  try {
    const res = await fetch(`/api/collection/${encodeURIComponent(input)}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json.error === 'ens-not-found'
        ? `couldn’t resolve “${input}”`
        : `lookup failed (${res.status})`;
      root.replaceChildren(status(msg, true));
      return;
    }
    renderCollection(json);
  } catch {
    root.replaceChildren(status('couldn’t reach the archive', true));
  }
}

function renderCollection(json) {
  const tokens = json.tokens || [];
  const name = json.ens || short(json.address || owner);
  root.replaceChildren();

  const header = document.createElement('header');
  const who = el('div', 'who');
  who.append(el('div', 'name', name));
  const count = json.total ?? tokens.length;
  const shown = tokens.length < count ? ` · showing ${tokens.length.toLocaleString()}` : '';
  who.append(el('div', 'count', `${Number(count).toLocaleString()} POAPs${shown}`));
  const open = document.createElement('a');
  open.className = 'open';
  open.href = `/p/${encodeURIComponent(json.ens || json.address || owner)}`;
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = 'Open';
  header.append(who, open);

  if (!tokens.length) {
    const empty = status('No POAPs for this address in the snapshot.');
    root.append(header, empty);
    return;
  }

  const stage = el('div');
  stage.id = 'stage';
  const pages = el('div');
  pages.id = 'pages';
  stage.append(pages);

  const footer = document.createElement('footer');
  const dots = el('div');
  dots.id = 'dots';
  footer.append(dots, el('span', null, inIframe ? 'swipe' : 'swipe or arrows'));

  root.append(header, stage, footer);

  let page = 0;
  let perPage = COLS * 2;

  function layout() {
    const width = stage.clientWidth || 440;
    const height = stage.clientHeight || 360;
    const gap = 8;
    const pad = 20;
    const cell = (width - pad - gap * (COLS - 1)) / COLS;
    const rows = Math.max(1, Math.floor((height - 10) / (cell + gap)));
    perPage = COLS * rows;
    const pageCount = Math.max(1, Math.ceil(tokens.length / perPage));
    page = Math.min(page, pageCount - 1);
    pages.replaceChildren();
    for (let p = 0; p < pageCount; p++) {
      const grid = el('div', 'page');
      grid.style.gridTemplateColumns = `repeat(${COLS}, 1fr)`;
      const slice = tokens.slice(p * perPage, (p + 1) * perPage);
      for (const token of slice) {
        const cellEl = el('button', 'cell');
        cellEl.type = 'button';
        cellEl.dataset.id = String(token.id);
        const img = document.createElement('img');
        img.alt = token.title || 'POAP';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = `/a/${token.d}.webp`;
        img.addEventListener('error', () => {
          const ph = el('div', 'ph', '#' + token.d);
          img.replaceWith(ph);
        }, { once: true });
        cellEl.append(img);
        cellEl.addEventListener('click', () => {
          if (swiped) return;
          openSheet(token);
        });
        grid.append(cellEl);
      }
      pages.append(grid);
    }
    paint();
  }

  function paint() {
    const pageCount = Math.max(1, Math.ceil(tokens.length / perPage));
    pages.style.transform = `translate3d(${-page * 100}%, 0, 0)`;
    dots.replaceChildren();
    const n = Math.min(pageCount, 12);
    for (let i = 0; i < n; i++) {
      const mark = pageCount <= 12 ? i : Math.round(i * (pageCount - 1) / (n - 1));
      const dot = el('span', 'dot' + (mark === page ? ' on' : ''));
      dots.append(dot);
    }
  }

  function go(next) {
    const pageCount = Math.max(1, Math.ceil(tokens.length / perPage));
    page = Math.max(0, Math.min(pageCount - 1, next));
    paint();
  }

  let startX = 0;
  let startY = 0;
  let dx = 0;
  let active = false;
  let swiped = false;
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    active = true;
    swiped = false;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!active) return;
    dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 6) {
      pages.classList.add('drag');
      pages.style.transform = `translate3d(calc(${-page * 100}% + ${dx}px), 0, 0)`;
    }
  });
  function endSwipe() {
    if (!active) return;
    active = false;
    pages.classList.remove('drag');
    swiped = Math.abs(dx) > 8;
    if (dx > 48) go(page - 1);
    else if (dx < -48) go(page + 1);
    else paint();
    dx = 0;
  }
  stage.addEventListener('pointerup', endSwipe);
  stage.addEventListener('pointercancel', endSwipe);

  layout();
  removeEventListener('resize', root._onResize);
  root._onResize = layout;
  addEventListener('resize', layout);
  removeEventListener('keydown', root._onKey);
  root._onKey = (e) => {
    if (document.getElementById('sheet')) return;
    if (e.key === 'ArrowRight') go(page + 1);
    if (e.key === 'ArrowLeft') go(page - 1);
  };
  addEventListener('keydown', root._onKey);
}

function openSheet(token) {
  document.getElementById('sheet')?.remove();
  const sheet = el('div');
  sheet.id = 'sheet';
  const img = document.createElement('img');
  img.alt = '';
  img.src = `/a/${token.d}.webp`;
  const title = el('h2', null, token.title || 'POAP');
  const when = [token.start ? token.start.slice(0, 10) : '', token.city, token.country]
    .filter(Boolean)
    .join(' · ');
  const meta = el('p', 'meta', when);
  const desc = el('p', 'desc', token.desc || '');
  const close = document.createElement('button');
  close.className = 'close';
  close.type = 'button';
  close.textContent = 'Close';
  close.addEventListener('click', () => sheet.remove());
  sheet.append(img, title, meta, desc, close);
  root.append(sheet);
}

function status(text, retry) {
  const node = el('div', 'status');
  node.append(el('p', null, text));
  if (retry && owner) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Try again';
    button.addEventListener('click', () => load(owner));
    node.append(button);
  }
  return node;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function short(addr) {
  if (!addr || addr.length < 12) return addr || '';
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function isOwner(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(value)
    || /^[a-zA-Z0-9-\u00a1-\uFFFF]{1,63}(\.[a-zA-Z0-9-\u00a1-\uFFFF]{1,63})+$/.test(value);
}
