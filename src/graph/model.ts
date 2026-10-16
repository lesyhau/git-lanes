import { assignChains, Seed } from './chains';
import { assignLanes, layoutEdges, LayoutCommit } from './layout';
import { Badge, GraphCommit, GraphModel, RawRef, RepoSnapshot } from './types';

export type Filter = 'all' | 'remote';

export interface BuildOptions {
  /** Branch to pin to lane 0; falls back to origin/HEAD, then main/master/trunk/develop. */
  defaultBranch?: string;
  filter: Filter;
  /** Lanes from the previous build of the same repo, keyed by chain. */
  prevLanes?: Map<string, number>;
  budgetMs?: number;
}

export interface BuildResult {
  model: GraphModel;
  lanes: Map<string, number>;
  /** Chain of each loaded commit (all rows, before filtering); for diagnostics. */
  chainOf: string[];
}

const MAIN = 'main';
const FALLBACK_DEFAULTS = ['main', 'master', 'trunk', 'develop'];
const BADGE_ORDER: Record<Badge['kind'], number> = { both: 0, remote: 1, local: 2, detached: 3, tag: 4 };

export function buildModel(snap: RepoSnapshot, opts: BuildOptions): BuildResult {
  const { commits, refs } = snap;
  const n = commits.length;
  const timeOf = new Map(commits.map((c) => [c.hash, c.time]));
  const rowOf = new Map(commits.map((c, i) => [c.hash, i]));
  const byFull = new Map(refs.map((r) => [r.full, r]));
  const primary = snap.remotes.includes('origin') ? 'origin' : snap.remotes[0];
  const remoteRefs = refs.filter((r) => r.kind === 'remote');
  const heads = refs.filter((r) => r.kind === 'head');
  const tags = refs.filter((r) => r.kind === 'tag');
  const hasRemotes = remoteRefs.length > 0;

  const def = resolveDefaultBranch(snap, opts.defaultBranch, primary, byFull);
  const defRemote = def && primary ? byFull.get(`refs/remotes/${primary}/${def}`) : undefined;
  const defLocal = def ? byFull.get(`refs/heads/${def}`) : undefined;

  // Seeds in priority order: the default branch, then remote branches (newest first), then local branches.
  // A local branch strictly ahead of its upstream extends the upstream's chain instead of starting its own.
  const newestFirst = (a: RawRef, b: RawRef) => (timeOf.get(b.hash) ?? 0) - (timeOf.get(a.hash) ?? 0);
  const remoteKey = (full: string) => (full === defRemote?.full ? MAIN : `remote:${full}`);
  const hasUpstream = (h: RawRef) => !!h.upstream && byFull.has(h.upstream);
  const seeds: Seed[] = [];
  if (defRemote) seeds.push({ key: MAIN, hash: defRemote.hash });
  if (defLocal) seeds.push(defRemote ? { key: `local:${defLocal.full}`, hash: defLocal.hash, joinKey: MAIN } : { key: MAIN, hash: defLocal.hash });
  for (const r of remoteRefs.filter((r) => r !== defRemote).sort(newestFirst)) seeds.push({ key: remoteKey(r.full), hash: r.hash });
  for (const h of heads.filter((h) => h !== defLocal && hasUpstream(h)).sort(newestFirst)) {
    seeds.push({ key: `local:${h.full}`, hash: h.hash, joinKey: remoteKey(h.upstream!) });
  }
  for (const h of heads.filter((h) => h !== defLocal && !hasUpstream(h)).sort(newestFirst)) seeds.push({ key: `local:${h.full}`, hash: h.hash });
  for (const t of tags.slice().sort(newestFirst)) seeds.push({ key: `tag:${t.full}`, hash: t.hash });
  if (snap.headHash) seeds.push({ key: 'head', hash: snap.headHash });

  const { chainOf, chains } = assignChains(commits, seeds);

  // A commit is local-only when no remote ref reaches it. Without remotes nothing is "local-only".
  const reached = new Uint8Array(n);
  const stack: number[] = [];
  for (const r of remoteRefs) {
    const row = rowOf.get(r.hash);
    if (row !== undefined) stack.push(row);
  }
  while (stack.length) {
    const r = stack.pop()!;
    if (reached[r]) continue;
    reached[r] = 1;
    for (const p of commits[r].parents) {
      const pr = rowOf.get(p);
      if (pr !== undefined && !reached[pr]) stack.push(pr);
    }
  }
  const isLocal = (row: number) => hasRemotes && !reached[row];

  const chainRemote = new Map<string, boolean>();
  for (const [key, chain] of chains) chainRemote.set(key, !hasRemotes || chain.rows.some((r) => !isLocal(r)));

  const mainKey = chains.has(MAIN)
    ? MAIN
    : (snap.headHash !== undefined && rowOf.has(snap.headHash) ? chainOf[rowOf.get(snap.headHash)!] : chainOf[0]) ?? MAIN;

  const layoutList: LayoutCommit[] = commits.map((c, i) => ({ hash: c.hash, parents: c.parents, chain: chainOf[i], local: isLocal(i) }));
  const lanes = assignLanes(layoutList, {
    mainKey,
    isRemote: (k) => k === mainKey || (chainRemote.get(k) ?? false),
    prev: opts.prevLanes,
    budgetMs: opts.budgetMs,
  });

  const remoteOnly = opts.filter === 'remote' && hasRemotes;
  const badges = buildBadges(snap, primary, byFull, remoteOnly);
  const rows = commits.map((_, i) => i).filter((i) => !remoteOnly || !isLocal(i));
  const visible: GraphCommit[] = rows.map((i) => {
    const c = commits[i];
    return {
      hash: c.hash,
      parents: c.parents,
      author: c.author,
      email: c.email,
      time: c.time,
      subject: c.subject,
      lane: lanes.get(chainOf[i]) ?? 0,
      local: isLocal(i),
      head: c.hash === snap.headHash,
      badges: badges.get(c.hash) ?? [],
    };
  });
  const edges = layoutEdges(
    rows.map((i) => layoutList[i]),
    lanes,
  );
  let maxLane = 0;
  for (const c of visible) maxLane = Math.max(maxLane, c.lane);
  for (const e of edges) maxLane = Math.max(maxLane, e.from, e.to);

  return {
    model: { commits: visible, edges, maxLane, truncated: snap.truncated, hasRemotes, defaultBranch: def },
    lanes,
    chainOf,
  };
}

function resolveDefaultBranch(snap: RepoSnapshot, configured: string | undefined, primary: string | undefined, byFull: Map<string, RawRef>): string | undefined {
  const exists = (b: string) => (!!primary && byFull.has(`refs/remotes/${primary}/${b}`)) || byFull.has(`refs/heads/${b}`);
  if (configured && exists(configured)) return configured;
  if (snap.originHead && exists(snap.originHead)) return snap.originHead;
  for (const b of FALLBACK_DEFAULTS) if (exists(b)) return b;
  return snap.headRef?.replace(/^refs\/heads\//, '');
}

function buildBadges(snap: RepoSnapshot, primary: string | undefined, byFull: Map<string, RawRef>, remoteOnly: boolean): Map<string, Badge[]> {
  const out = new Map<string, Badge[]>();
  const add = (hash: string, b: Badge) => {
    const list = out.get(hash);
    if (list) list.push(b);
    else out.set(hash, [b]);
  };
  const remoteLabel = (r: RawRef) => (r.remote === primary ? r.name : `${r.remote}/${r.name}`);
  const consumed = new Set<string>();

  if (!remoteOnly) {
    for (const h of snap.refs) {
      if (h.kind !== 'head') continue;
      const head = h.full === snap.headRef;
      // Without a configured upstream, a same-named branch on the primary remote stands in for it.
      const up = h.upstream ? byFull.get(h.upstream) : primary ? byFull.get(`refs/remotes/${primary}/${h.name}`) : undefined;
      if (up && up.hash === h.hash) {
        consumed.add(up.full);
        add(h.hash, { kind: 'both', name: h.name, ref: h.full, head, title: `${h.name} — local and ${up.remote}/${up.name} are in sync` });
        continue;
      }
      let title: string;
      if (up) {
        const parts: string[] = [];
        if (h.ahead) parts.push(`${h.ahead} ahead`);
        if (h.behind) parts.push(`${h.behind} behind`);
        title = `Local branch ${h.name} — ${parts.join(', ') || 'differs from'} ${up.remote}/${up.name}`;
      } else if (h.gone) {
        title = `Local branch ${h.name} — its upstream no longer exists`;
      } else {
        title = `Local branch ${h.name} — not pushed (no upstream)`;
      }
      add(h.hash, { kind: 'local', name: h.name, ref: h.full, head, ahead: up ? h.ahead : undefined, behind: up ? h.behind : undefined, title });
    }
  }
  for (const r of snap.refs) {
    if (r.kind !== 'remote' || consumed.has(r.full)) continue;
    add(r.hash, { kind: 'remote', name: remoteLabel(r), ref: r.full, title: `Remote branch ${r.remote}/${r.name}` });
  }
  for (const t of snap.refs) {
    if (t.kind === 'tag') add(t.hash, { kind: 'tag', name: t.name, ref: t.full, title: `Tag ${t.name}` });
  }
  if (!snap.headRef && snap.headHash) add(snap.headHash, { kind: 'detached', name: 'HEAD', ref: 'HEAD', head: true, title: 'Detached HEAD' });

  for (const list of out.values()) {
    list.sort((a, b) => Number(!!b.head) - Number(!!a.head) || BADGE_ORDER[a.kind] - BADGE_ORDER[b.kind] || a.name.localeCompare(b.name));
  }
  return out;
}
