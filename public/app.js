/* poaps — single-page app: paste an address, swipe through badges.
   ↔ pages, ↕ zoom, tap for details. Mobile first, zero dependencies. */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const home = $('home'), grid = $('grid'), pager = $('pager'), pagesEl = $('pages');
const els = {
  addr: $('addr'), paste: $('paste'), go: $('go'), homeError: $('home-error'),
  recentWrap: $('recent-wrap'), recent: $('recent'), snapshotDate: $('snapshot-date'),
  back: $('back'), share: $('share'), identicon: $('identicon'),
  whoName: $('who-name'), whoAddr: $('who-addr'),
  countBadge: $('count-badge'), zoomBadge: $('zoom-badge'),
  dots: $('dots'), hint: $('hint'), empty: $('empty'), loading: $('loading'), loadingText: $('loading-text'),
  sheet: $('sheet'), sheetBackdrop: $('sheet-backdrop'), sheetGrab: $('sheet-grab'),
  sheetImg: $('sheet-img'), sheetTitle: $('sheet-title'), sheetChips: $('sheet-chips'),
  sheetMeta: $('sheet-meta'), sheetDesc: $('sheet-desc'), sheetUrl: $('sheet-url'), sheetIds: $('sheet-ids'),
  toast: $('toast'),
};

const ZCOLS = [1, 2, 3, 4, 6, 8];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtDate = (ts) => new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fmtMonth = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short' }) : '';
const short = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';

const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a2f45"/><stop offset="1" stop-color="#171b2c"/></linearGradient></defs><circle cx="50" cy="50" r="49" fill="url(#g)"/><circle cx="50" cy="50" r="34" fill="none" stroke="#3b4266" stroke-width="2" stroke-dasharray="4 5"/></svg>`);

let zoom = innerWidth < 500 ? 2 : 4;
let tokens = [];
let layout = null;          // { cols, rows, cellH, perPage, pageCount }
let page = 0;
let collection = null;      // { address, ens, total, truncated }

/* ---------------- router ---------------- */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}
function route() {
  // two link forms: path (/p/vitalik.eth — shareable, bot-crawlable) and
  // hash (#/vitalik.eth — in-app navigation without reloads)
  const pm = /^\/p\/(.+)$/.exec(location.pathname);
  const h = safeDecode(location.hash.replace(/^#\/?/, ''));
  const input = (pm ? safeDecode(pm[1]) : '') || h;
  if (input) load(input.trim());
  else showHome();
}
addEventListener('hashchange', route);

function showHome() {
  grid.hidden = true; home.hidden = false;
  els.homeError.hidden = true;
  renderRecent();
}

/* ---------------- data ---------------- */
async function load(input) {
  home.hidden = true; grid.hidden = false;
  els.empty.hidden = true;
  els.loading.hidden = false;
  els.loadingText.textContent = input.includes('.') && !input.startsWith('0x')
    ? 'resolving name…' : 'fetching badges…';
  try {
    const res = await fetch(`/api/collection/${encodeURIComponent(input)}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (json.error === 'ens-not-found') throw new Error(`couldn’t resolve “${input}” — check the name?`);
      if (json.error === 'invalid-input') throw new Error('that doesn’t look like an address or ENS name');
      throw new Error(`lookup failed (${res.status})`);
    }
    collection = json;
    tokens = json.tokens || [];
    page = 0;
    drawHeader();
    els.loading.hidden = true;
    if (!tokens.length) { els.empty.hidden = false; pagesEl.innerHTML = ''; els.dots.innerHTML = ''; return; }
    computeLayout(); render(); updateDots(); snap(false);
    remember({ input, label: json.ens || short(json.address), count: json.total, first: tokens[0]?.d });
  } catch (err) {
    els.loading.hidden = true;
    toast(err.message || 'something went wrong');
    showHome();
    els.homeError.hidden = false;
    els.homeError.textContent = String(err.message || err);
  }
}

function drawHeader() {
  const inputName = collection.input && collection.input.includes('.') && !collection.input.startsWith('0x')
    ? collection.input.toLowerCase() : null;
  const name = collection.ens || inputName || short(collection.address);
  els.whoName.textContent = name;
  els.whoAddr.textContent = collection.ens || inputName ? short(collection.address) : 'copy address';
  els.countBadge.innerHTML = `<b>${collection.total.toLocaleString()}</b> POAP${collection.total === 1 ? '' : 's'}` +
    (collection.truncated ? ' · showing first ' + collection.returned.toLocaleString() : '');
  drawIdenticon(collection.address);
}

function drawIdenticon(addr) {
  const ctx = els.identicon.getContext('2d');
  const seed = addr.slice(2);
  const hue1 = parseInt(seed.slice(0, 4), 16) % 360;
  const hue2 = (hue1 + 100 + (parseInt(seed.slice(4, 8), 16) % 120)) % 360;
  ctx.fillStyle = `hsl(${hue2} 45% 16%)`;
  ctx.fillRect(0, 0, 72, 72);
  ctx.fillStyle = `hsl(${hue1} 72% 62%)`;
  const cell = 72 / 5;
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const on = parseInt(seed[10 + y * 3 + x] || '0', 16) % 2 === 1;
      if (on) {
        ctx.fillRect(Math.floor(x * cell), Math.floor(y * cell), Math.ceil(cell), Math.ceil(cell));
        ctx.fillRect(Math.floor((4 - x) * cell), Math.floor(y * cell), Math.ceil(cell), Math.ceil(cell));
      }
    }
  }
}

/* ---------------- layout & render ---------------- */
function pagePadX() { return clamp(innerWidth * 0.025, 10, 26); }
function gridGap() { return clamp(innerWidth * 0.016, 8, 18); }

function computeLayout() {
  const r = pager.getBoundingClientRect();
  const cols = ZCOLS[zoom];
  const gap = gridGap();
  const showTitles = cols <= 4;
  const cellW = (r.width - 2 * pagePadX() - gap * (cols - 1)) / cols;
  const titleH = showTitles ? (cols <= 2 ? 40 : 30) : 0;
  const cellH = cellW + titleH + (showTitles ? 7 : 0);
  const rows = Math.max(1, Math.floor((r.height - 20) / (cellH + gap)));
  const perPage = cols * rows;
  const focusIdx = page * (layout?.perPage || perPage);
  layout = { cols, rows, cellH, perPage, pageCount: Math.max(1, Math.ceil(tokens.length / perPage)) };
  page = clamp(Math.floor(focusIdx / perPage), 0, layout.pageCount - 1);
}

function render() {
  const { cols, rows, cellH, perPage, pageCount } = layout;
  const showTitles = cols <= 4;
  pagesEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let p = 0; p < pageCount; p++) {
    const div = document.createElement('div');
    div.className = 'page';
    div.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    div.style.gridTemplateRows = `repeat(${rows}, ${Math.floor(cellH)}px)`;
    const slice = tokens.slice(p * perPage, (p + 1) * perPage);
    for (let i = 0; i < slice.length; i++) {
      const t = slice[i];
      const idx = p * perPage + i;
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.idx = idx;
      const coin = document.createElement('div');
      coin.className = 'coin';
      const img = document.createElement('img');
      img.loading = 'lazy'; img.decoding = 'async'; img.alt = t.title;
      img.src = `/a/${t.d}.webp`;
      img.onload = () => img.classList.add('loaded');
      img.onerror = () => { img.onerror = null; img.src = PLACEHOLDER; img.classList.add('loaded'); };
      coin.appendChild(img);
      cell.appendChild(coin);
      if (showTitles) {
        const cap = document.createElement('div');
        cap.className = 't';
        cap.textContent = t.title;
        cell.appendChild(cap);
      }
      div.appendChild(cell);
    }
    frag.appendChild(div);
  }
  pagesEl.appendChild(frag);
  els.zoomBadge.textContent = `${ZCOLS[zoom]} across · zoom ${zoom + 1}/${ZCOLS.length}`;
}

function updateDots() {
  const n = layout.pageCount;
  const MAX = 14;
  const list = n <= MAX ? Array.from({ length: n }, (_, i) => i)
    : Array.from({ length: MAX }, (_, i) => Math.round(i * (n - 1) / (MAX - 1)));
  els.dots.innerHTML = '';
  const nearest = (i) => list.reduce((best, d) => Math.abs(d - i) < Math.abs(best - i) ? d : best, list[0]);
  for (const i of list) {
    const d = document.createElement('span');
    d.className = 'dot' + (i === nearest(page) ? ' on' : '');
    els.dots.appendChild(d);
  }
}

function snap(animate = true) {
  pagesEl.classList.toggle('anim', animate);
  pagesEl.style.transform = `translate3d(${-page * 100}%, 0, 0)`;
  updateDots();
}

function goPage(p, animate = true) {
  page = clamp(p, 0, layout.pageCount - 1);
  snap(animate);
}

function zoomTo(next) {
  next = clamp(next, 0, ZCOLS.length - 1);
  if (next === zoom) return;
  hideHint();
  const focusIdx = page * layout.perPage;
  zoom = next;
  pagesEl.classList.add('zoom-out-anim');
  setTimeout(() => {
    computeLayoutAt(focusIdx);
    render(); updateDots(); snap(false);
    pagesEl.classList.remove('zoom-out-anim');
    pagesEl.classList.add('zoom-in-anim');
    setTimeout(() => pagesEl.classList.remove('zoom-in-anim'), 260);
  }, 190);
}

function computeLayoutAt(focusIdx) {
  const saved = layout?.perPage;
  computeLayout();
  if (saved) page = clamp(Math.floor(focusIdx / layout.perPage), 0, layout.pageCount - 1);
}

/* ---------------- gestures ---------------- */
let ptr = null; // { id, x0, y0, t0, axis, base, moved, scale }
let lastTap = 0;

pager.addEventListener('pointerdown', (e) => {
  if ((e.button !== 0 && e.pointerType === 'mouse') || !e.isPrimary) return;
  if (ptr) return; // one gesture at a time; extra fingers are ignored
  try { pager.setPointerCapture(e.pointerId); } catch {}
  ptr = {
    id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(),
    axis: null, moved: false, base: -page * pager.clientWidth,
    target: e.target.closest?.('.cell') || null,
  };
  pagesEl.classList.remove('anim');
});

pager.addEventListener('pointermove', (e) => {
  if (!ptr || e.pointerId !== ptr.id || !layout) return;
  const dx = e.clientX - ptr.x0, dy = e.clientY - ptr.y0;
  if (!ptr.axis) {
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) ptr.axis = 'x';
    else if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) ptr.axis = 'y';
    else return;
  }
  if (Math.abs(dx) > 8 || Math.abs(dy) > 8) ptr.moved = true;
  if (ptr.axis === 'x') {
    let t = ptr.base + dx;
    const min = -(layout.pageCount - 1) * pager.clientWidth, max = 0;
    if (t > max) t = max + (t - max) * 0.35;
    if (t < min) t = min + (t - min) * 0.35;
    pagesEl.style.transform = `translate3d(${t}px, 0, 0)`;
  } else {
    const k = clamp(dy, -260, 260) / 260 * 0.17;
    pagesEl.style.transform = `translate3d(${ptr.base}px, 0, 0) scale(${1 + k})`;
  }
});

function endPointer(e) {
  if (!ptr || e.pointerId !== ptr.id) return;
  const dx = e.clientX - ptr.x0, dy = e.clientY - ptr.y0;
  const dt = performance.now() - ptr.t0;
  const info = ptr; ptr = null;

  if (!layout) { snap(true); return; }
  if (!info.moved) {
    const now = performance.now();
    if (now - lastTap < 320) { zoomTo(zoom + 1 <= ZCOLS.length - 1 ? zoom + 1 : 2); lastTap = 0; return; }
    lastTap = now;
    if (info.target) openSheet(tokens[Number(info.target.dataset.idx)]);
    snap(true);
    return;
  }
  hideHint();
  if (info.axis === 'x') {
    const v = dx / Math.max(dt, 1); // px per ms
    const want = (Math.abs(dx) > pager.clientWidth * 0.16 && Math.sign(dx) < 0 ? page + 1 :
                  Math.abs(dx) > pager.clientWidth * 0.16 && Math.sign(dx) > 0 ? page - 1 :
                  Math.abs(v) > 0.5 ? page - Math.sign(dx) : page);
    goPage(want);
  } else {
    if (Math.abs(dy) > 50) {
      zoomTo(zoom + (dy < 0 ? 1 : -1));
    } else {
      pagesEl.classList.add('anim');
      pagesEl.style.transform = `translate3d(${-page * 100}%, 0, 0) scale(1)`;
    }
  }
}
pager.addEventListener('pointerup', endPointer);
pager.addEventListener('pointercancel', (e) => { if (ptr && e.pointerId === ptr.id) { ptr = null; snap(true); } });

/* keyboard + wheel */
addEventListener('keydown', (e) => {
  if (sheetOpen) { if (e.key === 'Escape') closeSheet(); return; }
  if (grid.hidden || !layout) return;
  if (e.key === 'ArrowRight') goPage(page + 1);
  else if (e.key === 'ArrowLeft') goPage(page - 1);
  else if (e.key === 'ArrowUp') { e.preventDefault(); zoomTo(zoom + 1); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); zoomTo(zoom - 1); }
  else if (e.key === 'Escape') showHome(), history.replaceState(null, '', location.pathname);
});
let wheelCooldown = 0;
pager.addEventListener('wheel', (e) => {
  if (!layout) return;
  if (e.ctrlKey) { e.preventDefault(); zoomTo(zoom + (e.deltaY < 0 ? 1 : -1)); return; }
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    e.preventDefault();
    const now = performance.now();
    if (now - wheelCooldown < 420) return;
    wheelCooldown = now;
    goPage(page + Math.sign(e.deltaX));
  }
}, { passive: false });

addEventListener('resize', () => {
  if (grid.hidden || !tokens.length) return;
  const focusIdx = page * layout.perPage;
  computeLayoutAt(focusIdx); render(); updateDots(); snap(false);
});

/* ---------------- detail sheet ---------------- */
let sheetOpen = false;
function openSheet(t) {
  if (!t) return;
  els.sheetImg.src = `/a/${t.d}.webp`;
  els.sheetImg.alt = t.title;
  els.sheetImg.onerror = () => { els.sheetImg.onerror = null; els.sheetImg.src = PLACEHOLDER; };
  els.sheetTitle.textContent = t.title;
  els.sheetChips.innerHTML = '';
  const chips = [
    t.net && { label: netName(t.net) },
    t.virt === false && (t.city || t.country) && { label: [t.city, t.country].filter(Boolean).join(', ') },
    t.virt && { label: 'virtual event' },
  ].filter(Boolean);
  for (const c of chips) {
    const el = document.createElement('span');
    el.className = 'chip'; el.textContent = c.label;
    els.sheetChips.appendChild(el);
  }
  const rows = [
    ['minted', fmtDate(t.ts)],
    t.start && ['event', fmtMonth(t.start)],
  ].filter(Boolean);
  els.sheetMeta.innerHTML = '';
  for (const [k, v] of rows) {
    const row = document.createElement('div'); row.className = 'row';
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    row.append(dt, dd); els.sheetMeta.appendChild(row);
  }
  els.sheetDesc.textContent = t.desc || '';
  els.sheetDesc.hidden = !t.desc;
  els.sheetUrl.hidden = !t.url;
  if (t.url) { els.sheetUrl.href = t.url; }
  els.sheetIds.textContent = `POAP #${t.id} · drop #${t.d}${t.fancy ? ' · ' + t.fancy : ''}`;
  els.sheet.hidden = false; els.sheetBackdrop.hidden = false;
  sheetOpen = true;
  els.sheet.scrollTop = 0;
}
function closeSheet() {
  els.sheet.hidden = true; els.sheetBackdrop.hidden = true;
  sheetOpen = false;
}
els.sheetBackdrop.addEventListener('click', closeSheet);
els.sheetGrab.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const y0 = e.clientY; let moved = false;
  const move = (ev) => {
    const dy = ev.clientY - y0;
    if (dy > 4) { moved = true; els.sheet.style.transform = `translateY(${dy * 0.9}px)`; els.sheet.style.transition = 'none'; }
  };
  const up = (ev) => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    els.sheet.style.transition = ''; els.sheet.style.transform = '';
    if (moved && ev.clientY - y0 > 90) closeSheet();
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
});

const NET = { xdai: 'gnosis', mainnet: 'ethereum', matic: 'polygon', 'arbitrum-one': 'arbitrum', 'apechain-mainnet': 'apechain' };
const netName = (n) => NET[n] || n;

/* ---------------- misc ui ---------------- */
let toastTimer;
function toast(msg) {
  if (!msg) return;
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 2400);
}
function hideHint() {
  els.hint.classList.add('hide');
  try { localStorage.setItem('poaps-hinted', '1'); } catch {}
}
if (typeof localStorage !== 'undefined' && localStorage.getItem('poaps-hinted')) els.hint.classList.add('hide');

$('lookup').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = els.addr.value.trim();
  if (!v) { els.addr.focus(); return; }
  els.homeError.hidden = true;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v) && !/^[a-zA-Z0-9-\u00a1-\uFFFF]{1,63}(\.[a-zA-Z0-9-\u00a1-\uFFFF]{1,63})+$/.test(v)) {
    els.homeError.hidden = false;
    els.homeError.textContent = 'that doesn’t look like an address or ENS name';
    return;
  }
  location.hash = `/${encodeURIComponent(v)}`;
});
els.paste.addEventListener('click', async () => {
  try {
    const text = (await navigator.clipboard.readText() || '').trim();
    if (!text) throw new Error('empty');
    els.addr.value = text;
    $('lookup').requestSubmit();
  } catch {
    els.addr.focus();
    toast('clipboard unavailable — paste manually');
  }
});
els.back.addEventListener('click', () => { history.length > 1 ? history.back() : (location.hash = ''); });
els.whoAddr.addEventListener('click', async () => {
  if (!collection) return;
  try { await navigator.clipboard.writeText(collection.address); toast('address copied'); }
  catch { toast(collection.address); }
});
els.share.addEventListener('click', async () => {
  if (!collection) return;
  // path form (/p/…) — X and other bots drop #hash fragments, so shares
  // must carry the wallet in the path for embeds to work
  const url = `${location.origin}/p/${encodeURIComponent(collection.ens || collection.address)}`;
  const name = collection.ens || short(collection.address);
  if (navigator.share) { try { await navigator.share({ title: `${name}'s POAPs`, text: `${collection.total} POAPs held by ${name}`, url }); } catch {} }
  else { try { await navigator.clipboard.writeText(url); toast('link copied'); } catch { toast(url); } }
});

/* recent searches */
function remember(entry) {
  try {
    let list = JSON.parse(localStorage.getItem('poaps-recent') || '[]');
    list = [entry, ...list.filter((x) => x.input.toLowerCase() !== entry.input.toLowerCase())].slice(0, 6);
    localStorage.setItem('poaps-recent', JSON.stringify(list));
  } catch {}
}
function renderRecent() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem('poaps-recent') || '[]'); } catch {}
  els.recentWrap.hidden = !list.length;
  els.recent.innerHTML = '';
  for (const r of list) {
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'chip';
    if (r.first) {
      const img = document.createElement('img');
      img.className = 'mini'; img.loading = 'lazy'; img.alt = '';
      img.src = `/a/${r.first}.webp`; img.onerror = () => (img.style.display = 'none');
      chip.appendChild(img);
    }
    const label = document.createElement('span');
    label.textContent = r.label;
    const n = document.createElement('span');
    n.className = 'n'; n.textContent = r.count;
    chip.append(label, n);
    chip.addEventListener('click', () => (location.hash = `/${encodeURIComponent(r.input)}`));
    els.recent.appendChild(chip);
  }
}

/* starfield */
(() => {
  const stars = $('stars');
  let html = '';
  for (let i = 0; i < 70; i++) {
    const s = 0.6 + Math.random() * 1.6;
    html += `<i style="position:absolute;left:${(Math.random() * 100).toFixed(2)}%;top:${(Math.random() * 100).toFixed(2)}%;width:${s.toFixed(1)}px;height:${s.toFixed(1)}px;border-radius:50%;background:rgba(237,239,247,${(0.14 + Math.random() * 0.5).toFixed(2)});animation:tw ${(2 + Math.random() * 5).toFixed(1)}s ease-in-out ${(Math.random() * 5).toFixed(1)}s infinite alternate"></i>`;
  }
  stars.innerHTML = html;
  const style = document.createElement('style');
  style.textContent = '@keyframes tw{from{opacity:.25}to{opacity:1}}';
  document.head.appendChild(style);
})();

/* snapshot date badge on home */
(async () => {
  try {
    const res = await fetch('/healthz');
    const j = await res.json();
    if (j.snapshot) {
      const d = new Date(j.snapshot);
      els.snapshotDate.textContent = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
    }
  } catch {}
})();

route();
})();
