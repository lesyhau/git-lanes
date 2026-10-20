import type { FetchView, GraphState, ToGraph } from '../shared/protocol';
import { curvePoints } from '../graph/curve';
import type { GraphEdge, GraphModel } from '../graph/types';
import { avatarColor, badgeEl, el, fullDate, ICON, initials, palette, relativeShort } from './shared';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();

const wide = document.body.dataset.mode === 'wide';
/** Row height, lane width, first lane x, dot sizes, and where badges start after a dot. */
const G = wide ? { H: 34, LW: 30, X0: 20, DOT: 9, HEAD: 11, AFTER: 8, TEXT: 26 } : { H: 28, LW: 22, X0: 14, DOT: 8, HEAD: 10, AFTER: 7, TEXT: 17 };
const laneX = (l: number) => G.X0 + l * G.LW;

interface Saved {
  selected?: string;
  search?: string;
}
const saved = (vscode.getState() as Saved | undefined) ?? {};
let state: GraphState | undefined;
let selected = saved.selected;
let search = saved.search ?? '';
let seen: Set<string> | undefined;
let seenRepo: string | undefined;
let noticeTimer: number | undefined;
let rowEls: HTMLElement[] = [];
let bgEls: HTMLElement[] = [];
let dotEls: HTMLElement[] = [];
let hovered = -1;

const AUTO_ON = 'Auto-fetch is on: when the graph is shown, when the window regains focus, a few seconds after local git activity, and on an interval while the window is focused.';
const FILTER = '<div class="seg" role="group" aria-label="Show branches"><button data-filter="all">All</button><button data-filter="remote">Remote</button></div>';
/** The fetch control: the cloud icon and the fetch status are one button. */
const FETCH = '<button class="fetch-btn"><span class="fetch-btn-icon"></span><span class="fetch-text"></span></button>';
const NOTICE = `<div class="notice" hidden><span class="ic">${ICON.down}</span><span class="notice-text"></span><button class="icon-btn notice-close" aria-label="Dismiss">${ICON.close}</button></div>`;
const GRAPH = '<div class="graph" role="listbox" aria-label="Commits" tabindex="0"><div class="bgs"></div><svg class="lines" aria-hidden="true"></svg><div class="dots" aria-hidden="true"></div><div class="rows"></div></div><div class="more" hidden><button class="secondary">Load more commits</button></div>';

const app = document.getElementById('app')!;
app.innerHTML = wide
  ? `<div class="toolbar">${FILTER}<label class="search"><span class="ic">${ICON.search}</span><input type="text" placeholder="Search message, author or hash" aria-label="Search commits"></label><span class="spacer"></span>${FETCH}</div>${NOTICE}<div class="message" hidden></div><div class="scroller"><div class="header" aria-hidden="true"><span class="h-graph">Graph</span><span class="h-desc">Description</span><span class="author">Author</span><span class="date">Date</span><span class="hash h-hash">Commit</span></div>${GRAPH}</div>`
  : `<div class="strip">${FETCH}<span class="spacer"></span>${FILTER}</div>${NOTICE}<div class="message" hidden></div><div class="scroller">${GRAPH}</div>`;

const $ = <T extends Element = HTMLElement>(sel: string) => app.querySelector(sel) as T;
const graph = $('.graph');
const bgs = $('.bgs');
const svg = $<SVGSVGElement>('.lines');
const dots = $('.dots');
const rows = $('.rows');
const more = $('.more');
const message = $('.message');
const scroller = $('.scroller');
const notice = $('.notice');
const searchInput = wide ? $<HTMLInputElement>('.search input') : undefined;
graph.style.setProperty('--row-h', `${G.H}px`);

function save() {
  vscode.setState({ selected, search } satisfies Saved);
}

// ---- fetch status ----

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function renderFetch() {
  if (!state) return;
  const f: FetchView = state.fetch;
  const btn = $<HTMLButtonElement>('.fetch-btn');
  const hasRemotes = !!state.model?.hasRemotes;
  const fetching = f.status === 'fetching';
  const warn = f.status === 'auth' || f.status === 'error';
  let label: string;
  let hint = 'Click to fetch all remotes';
  switch (f.status) {
    case 'fetching':
      label = 'Fetching…';
      hint = 'Fetching all remotes';
      break;
    case 'auth':
      label = 'Sign in to fetch';
      hint = 'Click to sign in and fetch';
      break;
    case 'offline':
      label = 'Offline';
      hint = 'Auto-fetch is paused while offline. Click to try again';
      break;
    case 'error':
      label = 'Fetch failed';
      hint = 'Click to try again';
      break;
    default:
      label = !hasRemotes ? 'No remotes' : f.lastFetch ? `Fetched ${ago(f.lastFetch)}` : 'Not fetched yet';
  }
  $('.fetch-btn-icon').innerHTML = fetching ? ICON.spinner : warn ? ICON.warn : ICON.fetch;
  $('.fetch-text').textContent = label;
  btn.classList.toggle('busy', fetching);
  btn.classList.toggle('warn', warn);
  btn.disabled = !hasRemotes;
  btn.title = hasRemotes ? [f.message, hint, state.autoFetch ? AUTO_ON : 'Auto-fetch is off.'].filter(Boolean).join('\n') : 'This repository has no remotes';
  btn.setAttribute('aria-label', `${label}. ${hint}`);
  app.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.filter === state!.filter));
    b.disabled = !hasRemotes;
  });
}

function showNotice(text: string) {
  $('.notice-text').textContent = text;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => (notice.hidden = true), 8000);
}

// ---- graph ----

const r2 = (v: number) => Math.round(v * 100) / 100;

function edgePath(e: GraphEdge, n: number): string {
  const yi = (e.i + 0.5) * G.H;
  const yj = e.j >= n ? n * G.H + G.H : (e.j + 0.5) * G.H;
  const x1 = laneX(e.from);
  const x2 = laneX(e.to);
  if (e.from === e.to) return `M${x1} ${r2(yi)}L${x1} ${r2(yj)}`;
  // Forks run down their lane and curve into the parent's dot; merges leave the child's dot and curve into
  // their lane. The curve's shape lives in graph/curve.ts, where the layout checks it for crossings too.
  const pts = curvePoints(e, G.LW, G.H).map(([x, y]) => `${r2(x + G.X0)} ${r2(y)}`);
  const top = e.kind === 'merge' ? yi : yj - e.span * G.H;
  const bottom = e.kind === 'merge' ? yi + e.span * G.H : yj;
  return `M${x1} ${r2(yi)}${top > yi ? `L${pts[0]}` : ''}C${pts[1]} ${pts[2]} ${pts[3]}${yj > bottom ? `L${x2} ${r2(yj)}` : ''}`;
}

function renderMessage(): boolean {
  if (!state) return true;
  let text = '';
  if (state.noRepo) text = 'No Git repository found in this workspace.';
  else if (state.error) text = `Could not read the repository: ${state.error}`;
  else if (!state.model) text = 'Loading…';
  else if (!state.model.commits.length) text = 'No commits yet.';
  message.textContent = text;
  message.hidden = !text;
  scroller.hidden = !!text;
  return !text;
}

function renderGraph(model: GraphModel) {
  const pal = palette(state!.colors);
  const color = (lane: number) => pal[lane % pal.length];
  const n = model.commits.length;
  // Each row's text starts right after the rightmost line passing through that row (curves reserve both rows
  // they join), so a few wide stretches of history don't push every message to the right.
  const rowMax = new Array<number>(n).fill(0);
  const mark = (r: number, lane: number) => {
    if (r >= 0 && r < n && lane > rowMax[r]) rowMax[r] = lane;
  };
  for (const e of model.edges) {
    const end = Math.min(e.j, n - 1);
    if (e.from === e.to) {
      for (let r = e.i; r <= end; r++) mark(r, e.from);
      continue;
    }
    // A curve may be several rows tall; every row it passes through is held to its outer lane.
    const hi = Math.max(e.from, e.to);
    if (e.kind === 'fork') {
      for (let r = e.i; r < end; r++) mark(r, e.from);
      for (let r = Math.max(e.i, Math.floor(e.j - e.span)); r <= end; r++) mark(r, hi);
    } else {
      for (let r = e.i; r <= Math.min(end, Math.ceil(e.i + e.span)); r++) mark(r, hi);
      for (let r = e.i + 1; r <= end; r++) mark(r, e.to);
    }
  }
  model.commits.forEach((c, i) => mark(i, c.lane));
  const textAt = (i: number) => laneX(rowMax[i]) + G.TEXT;
  const freshCheck = seen && seenRepo === state!.repoName ? seen : undefined;
  if (seenRepo !== state!.repoName) seen = new Set();
  seenRepo = state!.repoName;

  graph.style.height = `${n * G.H}px`;
  if (wide) $('.h-graph').style.width = `${Math.max(...rowMax.slice(0, 30).map((_, i) => textAt(i)))}px`;

  // Lines, grouped by colour and dash so the SVG stays small.
  const groups = new Map<string, string>();
  for (const e of model.edges) {
    const key = `${e.color % pal.length}${e.local ? 'd' : 's'}`;
    groups.set(key, (groups.get(key) ?? '') + edgePath(e, n));
  }
  svg.setAttribute('width', String(laneX(model.maxLane) + G.LW));
  svg.setAttribute('height', String(n * G.H));
  svg.replaceChildren();
  for (const [key, d] of groups) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    p.setAttribute('stroke', pal[Number(key.slice(0, -1))]);
    if (key.endsWith('d')) p.setAttribute('class', 'dash');
    svg.append(p);
  }

  const bgFrag = document.createDocumentFragment();
  const dotFrag = document.createDocumentFragment();
  const rowFrag = document.createDocumentFragment();
  bgEls = [];
  dotEls = [];
  rowEls = [];
  model.commits.forEach((c, i) => {
    const col = color(c.lane);
    const bg = el('div', 'bg');
    if (freshCheck && !freshCheck.has(c.hash)) bg.classList.add('fresh');
    seen!.add(c.hash);
    bgEls.push(bg);
    bgFrag.append(bg);

    const size = c.head ? G.HEAD : G.DOT;
    const dot = el('div', c.local ? 'dot hollow' : 'dot');
    dot.style.left = `${laneX(c.lane) - size / 2}px`;
    dot.style.top = `${(i + 0.5) * G.H - size / 2}px`;
    dot.style.width = dot.style.height = `${size}px`;
    dot.style.borderColor = col;
    if (!c.local) dot.style.background = col;
    if (c.head) dot.style.boxShadow = `0 0 0 1.5px var(--gg-bg), 0 0 0 3px ${col}`;
    dotEls.push(dot);
    dotFrag.append(dot);

    const row = el('div', 'row');
    row.id = `r${i}`;
    row.setAttribute('role', 'option');
    row.dataset.i = String(i);
    row.dataset.vscodeContext = JSON.stringify({ webviewSection: 'commit', hash: c.hash, preventDefaultContextMenuItems: true });
    row.title = `${c.hash.slice(0, 7)} · ${c.author} · ${fullDate(c.time)}${c.local ? ' · local only' : ''}\n${c.subject}`;
    const desc = el('div', 'desc');
    // Badges sit right after the branch tip's dot; the message starts after the row's rightmost line.
    const textX = textAt(i);
    const pad = c.badges.length ? laneX(c.lane) + (c.head ? G.AFTER + 2 : G.AFTER) : textX;
    desc.style.paddingLeft = `${pad}px`;
    if (c.badges.length) {
      const refs = el('span', 'refs');
      refs.style.minWidth = `${Math.max(0, textX - pad - 6)}px`;
      for (const b of c.badges) refs.append(badgeEl(b, col));
      desc.append(refs);
    }
    desc.append(el('span', 'msg', c.subject));
    row.append(desc);
    if (wide) {
      const author = el('span', 'author');
      const av = el('span', 'avatar', initials(c.author));
      av.style.background = avatarColor(c.email || c.author);
      author.append(av, el('span', 'author-name', c.author));
      row.append(author, el('span', 'date', fullDate(c.time)), el('span', 'hash', c.hash.slice(0, 7)));
    } else {
      row.append(el('span', 'when', relativeShort(c.time)));
    }
    rowEls.push(row);
    rowFrag.append(row);
  });
  bgs.replaceChildren(bgFrag);
  dots.replaceChildren(dotFrag);
  rows.replaceChildren(rowFrag);
  hovered = -1;
  more.hidden = !model.truncated;
  applySelection(false);
  applySearch();
}

function render() {
  renderFetch();
  if (!renderMessage() || !state?.model) return;
  renderGraph(state.model);
}

// ---- selection, hover, search ----

function indexOf(hash: string | undefined): number {
  if (!hash || !state?.model) return -1;
  return state.model.commits.findIndex((c) => c.hash === hash);
}

function applySelection(scroll: boolean) {
  const i = indexOf(selected);
  rowEls.forEach((r, k) => {
    const on = k === i;
    r.classList.toggle('sel', on);
    r.setAttribute('aria-selected', String(on));
    bgEls[k].classList.toggle('sel', on);
  });
  if (i >= 0) {
    graph.setAttribute('aria-activedescendant', `r${i}`);
    if (scroll) rowEls[i].scrollIntoView({ block: 'nearest' });
  } else graph.removeAttribute('aria-activedescendant');
}

function select(i: number, open: boolean) {
  const c = state?.model?.commits[i];
  if (!c) return;
  selected = c.hash;
  save();
  applySelection(true);
  if (open) vscode.postMessage({ type: 'openCommit', hash: c.hash });
}

function matches(i: number): boolean {
  const c = state!.model!.commits[i];
  const q = search.trim().toLowerCase();
  return !q || c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.hash.startsWith(q) || c.badges.some((b) => b.name.toLowerCase().includes(q));
}

function applySearch() {
  if (!wide || !state?.model) return;
  rowEls.forEach((r, i) => {
    const dim = !matches(i);
    r.classList.toggle('dim', dim);
    dotEls[i].classList.toggle('dim', dim);
  });
}

rows.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
  if (row) select(Number(row.dataset.i), true);
});
rows.addEventListener('mousemove', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
  const i = row ? Number(row.dataset.i) : -1;
  if (i === hovered) return;
  bgEls[hovered]?.classList.remove('hover');
  hovered = i;
  bgEls[i]?.classList.add('hover');
});
rows.addEventListener('mouseleave', () => {
  bgEls[hovered]?.classList.remove('hover');
  hovered = -1;
});
graph.addEventListener('keydown', (e) => {
  const n = rowEls.length;
  if (!n) return;
  const cur = Math.max(0, indexOf(selected));
  const page = Math.max(1, Math.floor(scroller.clientHeight / G.H) - 1);
  const next: Record<string, number> = { ArrowDown: cur + 1, ArrowUp: cur - 1, PageDown: cur + page, PageUp: cur - page, Home: 0, End: n - 1 };
  if (e.key in next) {
    e.preventDefault();
    select(Math.min(n - 1, Math.max(0, indexOf(selected) < 0 ? 0 : next[e.key])), false);
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    select(cur, true);
  }
});

app.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const seg = t.closest<HTMLButtonElement>('.seg button');
  if (seg) vscode.postMessage({ type: 'setFilter', filter: seg.dataset.filter });
  if (t.closest('.fetch-btn') && state?.fetch.status !== 'fetching') vscode.postMessage({ type: 'fetch' });
  if (t.closest('.notice-close')) notice.hidden = true;
  if (t.closest('.more button')) vscode.postMessage({ type: 'loadMore' });
});

if (searchInput) {
  searchInput.value = search;
  searchInput.addEventListener('input', () => {
    search = searchInput.value;
    save();
    applySearch();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !state?.model) return;
    const n = rowEls.length;
    const start = indexOf(selected);
    for (let k = 1; k <= n; k++) {
      const i = (start + k + n) % n;
      if (matches(i)) {
        select(i, false);
        break;
      }
    }
  });
}

window.addEventListener('message', (ev: MessageEvent<ToGraph>) => {
  const m = ev.data;
  if (m.type === 'state') {
    state = m;
    render();
  } else if (m.type === 'fetch') {
    if (!state) return;
    state.fetch = m.fetch;
    renderFetch();
  } else if (m.type === 'notice') {
    showNotice(m.text);
  }
});

// Theme switches change the default palette.
new MutationObserver(() => state && render()).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// Keep "Fetched 2 min ago" and relative commit times current.
setInterval(() => {
  renderFetch();
  if (!wide && state?.model) {
    const commits = state.model.commits;
    rowEls.forEach((r, i) => {
      const w = r.querySelector('.when');
      if (w) w.textContent = relativeShort(commits[i].time);
    });
  }
}, 30_000);

vscode.postMessage({ type: 'ready' });
