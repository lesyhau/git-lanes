import type { CommitState } from '../shared/protocol';
import { avatarColor, badgeEl, el, fullDate, icon, initials, palette } from './shared';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;
let state: CommitState | undefined;

const STATUS: Record<string, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed' };

function button(label: string, action: string, primary = false, iconName?: Parameters<typeof icon>[0]): HTMLButtonElement {
  const b = el('button', primary ? 'primary' : 'secondary');
  if (iconName) b.append(icon(iconName));
  b.append(label);
  b.dataset.action = action;
  return b;
}

function render() {
  if (!state) return;
  const page = el('div', 'page');
  const d = state.details;
  const color = palette(state.colors)[state.lane % palette(state.colors).length];

  const kicker = el('div', 'kicker');
  kicker.append(el('span', 'label', 'COMMIT'), el('code', 'hash', state.hash.slice(0, 10)));
  const copy = el('button', 'icon-btn');
  copy.title = 'Copy full hash';
  copy.setAttribute('aria-label', 'Copy full hash');
  copy.dataset.action = 'copy';
  copy.append(icon('copy'));
  kicker.append(copy);
  page.append(kicker);

  if (state.error) {
    page.append(el('p', 'error', state.error));
    app.replaceChildren(page);
    return;
  }
  if (!d) {
    page.append(el('p', 'muted', 'Loading…'));
    app.replaceChildren(page);
    return;
  }

  const [subject, ...bodyLines] = d.message.split('\n');
  page.append(el('h1', undefined, subject));
  const body = bodyLines.join('\n').trim();
  if (body) page.append(el('pre', 'body', body));

  const who = el('div', 'who');
  const av = el('span', 'avatar', initials(d.author));
  av.style.background = avatarColor(d.email || d.author);
  who.append(av, el('span', 'name', d.author), el('span', 'muted', `authored ${fullDate(d.authorTime)}`));
  if (d.committer !== d.author || Math.abs(d.commitTime - d.authorTime) > 60) who.append(el('span', 'muted', `· committed by ${d.committer} ${fullDate(d.commitTime)}`));
  page.append(who);

  if (state.hasRemotes) {
    const card = el('div', state.local ? 'card local' : 'card');
    card.style.borderColor = state.local ? color : '';
    const ic = icon(state.local ? 'laptop' : 'cloud');
    ic.style.color = color;
    const text = el('div', 'card-text');
    text.append(
      el('strong', undefined, state.local ? 'Local only' : 'On the remote'),
      el('span', 'muted', state.local ? 'Not pushed yet. Others cannot see this commit until you push.' : 'Shared with everyone who fetches from the remote.'),
    );
    card.append(ic, text);
    if (state.local) card.append(button('Push', 'push', true, 'push'));
    page.append(card);
  }

  const meta = el('div', 'meta');
  meta.append(el('span', 'muted', 'Refs'));
  const refs = el('div', 'refs');
  if (state.badges.length) for (const b of state.badges) refs.append(badgeEl(b, color));
  else refs.append(el('span', 'muted', '—'));
  meta.append(refs, el('span', 'muted', 'Parents'));
  const parents = el('div', 'refs');
  if (d.parents.length) {
    for (const p of d.parents) {
      const b = el('button', 'link hash', p.slice(0, 7));
      b.dataset.parent = p;
      b.title = `Open ${p}`;
      parents.append(b);
    }
  } else parents.append(el('span', 'muted', '— (root commit)'));
  meta.append(parents);
  page.append(meta);

  const files = el('section', 'files');
  const head = el('div', 'files-head');
  head.append(el('span', undefined, 'CHANGED FILES'), el('span', 'count', String(d.files.length)));
  if (d.parents.length > 1) head.append(el('span', 'muted', `compared with first parent ${d.parents[0].slice(0, 7)}`));
  files.append(head);
  d.files.forEach((f, i) => {
    const row = el('button', 'file');
    row.dataset.file = String(i);
    row.title = `${STATUS[f.status] ?? f.status}: ${f.oldPath ? `${f.oldPath} → ` : ''}${f.path}`;
    row.append(el('span', `st st-${f.status}`, f.status));
    const p = el('span', 'path');
    const slash = f.path.lastIndexOf('/');
    p.append(el('span', 'base', f.path.slice(slash + 1)));
    if (slash > 0) p.append(el('span', 'dir', f.path.slice(0, slash)));
    if (f.oldPath) p.append(el('span', 'dir', `from ${f.oldPath}`));
    row.append(p);
    if (f.added === null) row.append(el('span', 'muted', 'binary'));
    else row.append(el('span', 'add', `+${f.added}`), el('span', 'del', `−${f.deleted}`));
    files.append(row);
  });
  page.append(files);

  const actions = el('div', 'actions');
  actions.append(button('Checkout…', 'checkout'), button('Create Branch…', 'branch'), button('Copy Hash', 'copy'));
  page.append(actions);
  app.replaceChildren(page);
}

app.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const action = t.closest<HTMLElement>('[data-action]')?.dataset.action;
  if (action) return vscode.postMessage({ type: 'action', action });
  const parent = t.closest<HTMLElement>('[data-parent]')?.dataset.parent;
  if (parent) return vscode.postMessage({ type: 'openCommit', hash: parent });
  const file = t.closest<HTMLElement>('[data-file]')?.dataset.file;
  if (file !== undefined) vscode.postMessage({ type: 'openDiff', index: Number(file) });
});

window.addEventListener('message', (ev: MessageEvent<CommitState>) => {
  if (ev.data.type !== 'commit') return;
  state = ev.data;
  render();
  window.scrollTo(0, 0);
});
new MutationObserver(() => render()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
vscode.postMessage({ type: 'ready' });
