import type { Badge } from '../graph/types';

/** Inline stroke icons (constant markup, never built from data). */
export const ICON = {
  cloud: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 12.5h6.8a2.9 2.9 0 0 0 .5-5.76 3.9 3.9 0 0 0-7.55.9A2.45 2.45 0 0 0 4.6 12.5z"/></svg>',
  laptop: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3.5" width="10" height="7" rx="1"/><path d="M1.5 12.5h13"/></svg>',
  tag: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h5.2l5.8 5.8-5.2 5.2-5.8-5.8z"/><circle cx="5.5" cy="5.5" r="1"/></svg>',
  commit: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.5"/><path d="M1.5 8h4M10.5 8h4"/></svg>',
  fetch: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 11.2A2.5 2.5 0 0 1 4.6 6.3 3.9 3.9 0 0 1 12 6a2.7 2.7 0 0 1 .4 5.2"/><path d="M8 7.5v6M5.9 11.4 8 13.5l2.1-2.1"/></svg>',
  spinner: '<svg class="i spin" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5"/></svg>',
  down: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10"/></svg>',
  close: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
  search: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.5 13.5"/></svg>',
  warn: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.3v.2"/></svg>',
  copy: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M3.5 10.5h-1v-8h8v1"/></svg>',
  push: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13.5V5M4.5 8.5 8 5l3.5 3.5M3 2.5h10"/></svg>',
};

// Eight lane colours, ordered so neighbouring lanes differ in hue and lightness.
const DARK = ['#b18cff', '#2ed3a0', '#ff6b8b', '#ffc145', '#4cc9f0', '#ff9f5a', '#9ee35d', '#f78fd1'];
const LIGHT = ['#7c4ddb', '#0a8a64', '#d1335b', '#a86f00', '#0a7fb0', '#c45a00', '#4c8a12', '#c2348f'];

export function palette(custom: string[]): string[] {
  if (custom.length) return custom;
  const c = document.body.classList;
  return c.contains('vscode-light') || c.contains('vscode-high-contrast-light') ? LIGHT : DARK;
}

const textCache = new Map<string, string>();
/** Readable text colour on a solid badge of `color`. */
export function solidText(color: string): string {
  let t = textCache.get(color);
  if (t) return t;
  const probe = document.createElement('span');
  probe.style.color = color;
  document.body.append(probe);
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color);
  probe.remove();
  const lum = m ? (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255 : 1;
  t = lum > 0.5 ? '#141414' : '#ffffff';
  textCache.set(color, t);
  return t;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function icon(name: keyof typeof ICON): HTMLSpanElement {
  const s = el('span', 'ic');
  s.innerHTML = ICON[name];
  return s;
}

/** A ref badge: solid = remote, outlined = local only, both icons = local and remote in sync. */
export function badgeEl(b: Badge, color: string): HTMLSpanElement {
  const s = el('span', `pill pill-${b.kind}`);
  s.title = b.title;
  if (b.kind === 'remote' || b.kind === 'both') {
    s.style.background = color;
    s.style.borderColor = color;
    s.style.color = solidText(color);
  } else if (b.kind === 'local') {
    s.style.borderColor = color;
    s.style.color = color;
  }
  if (b.head) s.append(el('span', 'hd', 'HEAD'));
  if (b.kind === 'remote' || b.kind === 'both') s.append(icon('cloud'));
  if (b.kind === 'local' || b.kind === 'both') s.append(icon('laptop'));
  if (b.kind === 'tag') s.append(icon('tag'));
  if (b.kind === 'detached') s.append(icon('commit'));
  if (b.kind !== 'detached') s.append(el('span', 'nm', b.name));
  const counts = [b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].filter(Boolean).join(' ');
  if (counts) s.append(el('span', 'cnt', counts));
  return s;
}

export function relativeShort(sec: number): string {
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  if (s < 35 * 86400) return `${Math.floor(s / (7 * 86400))}w`;
  const d = new Date(sec * 1000);
  return d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' });
}

export function fullDate(sec: number): string {
  return new Date(sec * 1000).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Stable avatar colour from an email. */
export function avatarColor(seed: string): string {
  let h = 0;
  for (let k = 0; k < seed.length; k++) h = (h * 31 + seed.charCodeAt(k)) >>> 0;
  return `hsl(${h % 360} 40% 42%)`;
}
