import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildModel } from '../src/graph/model';
import { layoutProblems } from '../src/graph/layout';
import { assignChains } from '../src/graph/chains';
import { RawCommit, RawRef, RepoSnapshot } from '../src/graph/types';

let clock = 2_000_000_000;
function commit(hash: string, parents: string[], subject = hash): RawCommit {
  return { hash, parents, author: 'A', email: 'a@x', time: clock--, subject };
}
function ref(full: string, hash: string, extra: Partial<RawRef> = {}): RawRef {
  const m = /^refs\/(heads|remotes|tags)\/(.+)$/.exec(full)!;
  const kind = m[1] === 'heads' ? 'head' : m[1] === 'remotes' ? 'remote' : 'tag';
  let name = m[2];
  let remote: string | undefined;
  if (kind === 'remote') {
    remote = name.slice(0, name.indexOf('/'));
    name = name.slice(remote.length + 1);
  }
  return { full, hash, kind, remote, name, ahead: 0, behind: 0, gone: false, ...extra };
}

/** The history from the approved mock, after the fetch (newest first). */
function mockSnapshot(): RepoSnapshot {
  const commits = [
    commit('c20', ['c17']),
    commit('c19', ['c15']),
    commit('c15', ['c16']),
    commit('c17', ['c11']),
    commit('c18', ['c14']),
    commit('c14', ['c10']),
    commit('c16', ['c13', 'c12'], 'Merge pull request #141 from acme/fix/fetch-timeout'),
    commit('c13', ['c8']),
    commit('c12', ['c9']),
    commit('c11', ['c8']),
    commit('c9', ['c8']),
    commit('c10', ['c7']),
    commit('c7', ['c6']),
    commit('c8', ['cY']),
    commit('cY', ['cX']),
    commit('cX', ['c6']),
    commit('c6', ['c4', 'c5'], 'Merge pull request #138 from acme/feature/auth'),
    commit('c5', ['c3']),
    commit('c4', ['c2']),
    commit('c3', ['c2']),
    commit('c2', ['c1']),
    commit('c1', []),
  ];
  const refs = [
    ref('refs/remotes/origin/main', 'c16'),
    ref('refs/heads/main', 'c13', { upstream: 'refs/remotes/origin/main', behind: 3 }),
    ref('refs/remotes/origin/fix/fetch-timeout', 'c12'),
    ref('refs/heads/fix/fetch-timeout', 'c12', { upstream: 'refs/remotes/origin/fix/fetch-timeout' }),
    ref('refs/remotes/origin/feature/blame-hover', 'c20'),
    ref('refs/remotes/origin/feature/graph-view', 'c14'),
    ref('refs/heads/feature/graph-view', 'c18', { upstream: 'refs/remotes/origin/feature/graph-view', ahead: 1 }),
    ref('refs/heads/feature/settings-ui', 'c19'),
    ref('refs/tags/v0.4.0', 'c8'),
  ];
  return { commits, refs, remotes: ['origin'], headHash: 'c18', headRef: 'refs/heads/feature/graph-view', originHead: 'main', truncated: false };
}

const laneOf = (m: ReturnType<typeof buildModel>['model'], hash: string) => m.commits.find((c) => c.hash === hash)!.lane;

test('mock history: default branch left, nested branches inside, local branch fills a free lane, no crossings', () => {
  const { model } = buildModel(mockSnapshot(), { filter: 'all' });
  for (const h of ['c16', 'c13', 'c8', 'cY', 'cX', 'c6', 'c4', 'c2', 'c1']) assert.equal(laneOf(model, h), 0, `${h} on main`);
  assert.equal(laneOf(model, 'c12'), 1, 'fix/fetch-timeout');
  assert.equal(laneOf(model, 'c20'), 2, 'blame-hover outside fix');
  assert.equal(laneOf(model, 'c18'), 3, 'graph-view outermost');
  assert.equal(laneOf(model, 'c14'), 3, 'local commits ahead share the remote lane');
  assert.equal(laneOf(model, 'c19'), 1, 'settings-ui stays inside');
  assert.equal(laneOf(model, 'c5'), 1, 'merged branch reuses a lane');
  assert.equal(model.maxLane, 3);
});

test('mock history layout has no crossings and no curves through dots', () => {
  const snap = mockSnapshot();
  const { lanes } = buildModel(snap, { filter: 'all' });
  const { chainOf } = assignChains(snap.commits, [
    { key: 'main', hash: 'c16' },
    { key: 'remote:refs/remotes/origin/feature/blame-hover', hash: 'c20' },
    { key: 'remote:refs/remotes/origin/feature/graph-view', hash: 'c14' },
    { key: 'remote:refs/remotes/origin/fix/fetch-timeout', hash: 'c12' },
    { key: 'local:refs/heads/feature/graph-view', hash: 'c18', joinKey: 'remote:refs/remotes/origin/feature/graph-view' },
    { key: 'local:refs/heads/feature/settings-ui', hash: 'c19' },
  ]);
  const list = snap.commits.map((c, i) => ({ hash: c.hash, parents: c.parents, chain: chainOf[i], local: false }));
  assert.equal(layoutProblems(list, lanes).cross, 0);
});

/** Branch-offs always go right; merges always come in from the right (except the default branch merged into a branch). */
function assertDirections(model: ReturnType<typeof buildModel>['model']) {
  for (const e of model.edges) {
    if (e.kind === 'fork') assert.ok(e.from > e.to, `branch-off at row ${e.i} goes from lane ${e.to} to ${e.from}`);
    if (e.kind === 'merge' && e.to !== 0) assert.ok(e.to > e.from, `merge at row ${e.i} comes from lane ${e.to} into ${e.from}`);
  }
}

test('mock history: branches go right, merges come from the right', () => {
  assertDirections(buildModel(mockSnapshot(), { filter: 'all' }).model);
});

test('feature branches of a long-lived branch sit right of it and reuse one lane', () => {
  // main <- integration (long-lived) <- three features merged back in turn; another long-lived branch beside it.
  const commits = [
    commit('y4', ['ym3']),
    commit('c2', ['c1']),
    commit('ym3', ['ym2', 'f3b'], 'Merge feature 3'),
    commit('f3b', ['f3a']),
    commit('f3a', ['ym2']),
    commit('ym2', ['y3', 'f2b'], 'Merge feature 2'),
    commit('f2b', ['f2a']),
    commit('y3', ['ym1']),
    commit('f2a', ['ym1']),
    commit('ym1', ['y2', 'f1b'], 'Merge feature 1'),
    commit('f1b', ['f1a']),
    commit('f1a', ['y2']),
    commit('y2', ['y1']),
    commit('c1', ['m1']),
    commit('y1', ['m1']),
    commit('m1', []),
  ];
  const snap: RepoSnapshot = {
    commits,
    refs: [ref('refs/remotes/origin/main', 'm1'), ref('refs/remotes/origin/integration', 'y4'), ref('refs/remotes/origin/other', 'c2')],
    remotes: ['origin'],
    originHead: 'main',
    truncated: false,
  };
  const { model } = buildModel(snap, { filter: 'all' });
  assertDirections(model);
  const y = laneOf(model, 'y2');
  for (const f of ['f1a', 'f1b', 'f2a', 'f2b', 'f3a', 'f3b']) assert.equal(laneOf(model, f), y + 1, f);
  assert.equal(model.maxLane, 3);
  assert.equal(laneOf(model, 'm1'), 0);
});

test('large history: branches go right, merges come from the right', () => {
  const { model } = buildModel(largeSnapshot(), { filter: 'all', budgetMs: 300 });
  assertDirections(model);
});

test('local-only commits and badges', () => {
  const { model } = buildModel(mockSnapshot(), { filter: 'all' });
  const c = (h: string) => model.commits.find((x) => x.hash === h)!;
  assert.deepEqual(model.commits.filter((x) => x.local).map((x) => x.hash), ['c19', 'c15', 'c18']);
  assert.deepEqual(c('c13').badges.map((b) => [b.kind, b.name, b.behind]), [['local', 'main', 3]]);
  assert.deepEqual(c('c12').badges.map((b) => [b.kind, b.name]), [['both', 'fix/fetch-timeout']]);
  assert.deepEqual(c('c18').badges.map((b) => [b.kind, b.name, b.ahead, b.head]), [['local', 'feature/graph-view', 1, true]]);
  assert.deepEqual(c('c16').badges.map((b) => [b.kind, b.name]), [['remote', 'main']]);
  assert.deepEqual(c('c8').badges.map((b) => [b.kind, b.name]), [['tag', 'v0.4.0']]);
  assert.equal(model.defaultBranch, 'main');
});

test('remote filter hides local-only commits but keeps lanes', () => {
  const all = buildModel(mockSnapshot(), { filter: 'all' }).model;
  const remote = buildModel(mockSnapshot(), { filter: 'remote' }).model;
  assert.ok(remote.commits.every((c) => !c.local));
  assert.equal(remote.commits.length, all.commits.length - 3);
  for (const c of remote.commits) assert.equal(c.lane, all.commits.find((x) => x.hash === c.hash)!.lane);
  const fix = remote.commits.find((c) => c.hash === 'c12')!;
  assert.deepEqual(fix.badges.map((b) => [b.kind, b.name]), [['remote', 'fix/fetch-timeout']]);
  assert.ok(remote.commits.every((c) => c.badges.every((b) => b.kind !== 'local')));
});

test('lanes stay stable when new commits arrive', () => {
  const first = buildModel(mockSnapshot(), { filter: 'all' });
  const snap = mockSnapshot();
  snap.commits.unshift(commit('c21', ['c19']), commit('c22', ['c20']));
  snap.refs.find((r) => r.full === 'refs/heads/feature/settings-ui')!.hash = 'c21';
  snap.refs.find((r) => r.full === 'refs/remotes/origin/feature/blame-hover')!.hash = 'c22';
  const second = buildModel(snap, { filter: 'all', prevLanes: first.lanes });
  for (const c of first.model.commits) assert.equal(laneOf(second.model, c.hash), c.lane, c.hash);
  assert.equal(laneOf(second.model, 'c21'), laneOf(first.model, 'c19'));
});

test('a local branch without upstream at the same commit as the same-named remote branch shows one in-sync badge', () => {
  const commits = [commit('b', ['a']), commit('a', [])];
  const snap: RepoSnapshot = {
    commits,
    refs: [ref('refs/remotes/origin/main', 'b'), ref('refs/remotes/origin/fix/x', 'b'), ref('refs/heads/fix/x', 'b')],
    remotes: ['origin'],
    headHash: 'b',
    headRef: 'refs/heads/fix/x',
    truncated: false,
  };
  const { model } = buildModel(snap, { filter: 'all' });
  assert.deepEqual(model.commits[0].badges.map((b) => [b.kind, b.name]), [['both', 'fix/x'], ['remote', 'main']]);
});

test('diverged local default branch gets its own local lane', () => {
  const commits = [commit('r2', ['b']), commit('l1', ['b']), commit('b', ['a']), commit('a', [])];
  const snap: RepoSnapshot = {
    commits,
    refs: [ref('refs/remotes/origin/main', 'r2'), ref('refs/heads/main', 'l1', { upstream: 'refs/remotes/origin/main', ahead: 1, behind: 1 })],
    remotes: ['origin'],
    headHash: 'l1',
    headRef: 'refs/heads/main',
    truncated: false,
  };
  const { model } = buildModel(snap, { filter: 'all' });
  assert.equal(laneOf(model, 'r2'), 0);
  assert.equal(laneOf(model, 'b'), 0);
  assert.equal(laneOf(model, 'l1'), 1);
  assert.ok(model.commits.find((c) => c.hash === 'l1')!.local);
});

test('repo without remotes: nothing is local-only, history stays in one lane', () => {
  const commits = [commit('c', ['b']), commit('b', ['a']), commit('a', [])];
  const snap: RepoSnapshot = { commits, refs: [ref('refs/heads/master', 'c')], remotes: [], headHash: 'c', headRef: 'refs/heads/master', truncated: false };
  const { model } = buildModel(snap, { filter: 'all' });
  assert.ok(model.commits.every((c) => !c.local && c.lane === 0));
  assert.equal(model.defaultBranch, 'master');
  assert.equal(model.edges.length, 2);
});

test('truncated window: a parent past the end draws off the bottom', () => {
  const commits = [commit('c', ['b']), commit('b', ['a'])];
  const snap: RepoSnapshot = { commits, refs: [ref('refs/heads/main', 'c')], remotes: [], headHash: 'c', headRef: 'refs/heads/main', truncated: true };
  const { model } = buildModel(snap, { filter: 'all' });
  assert.deepEqual(model.edges.map((e) => [e.i, e.j]), [[0, 1], [1, 2]]);
});

function largeSnapshot(): RepoSnapshot {
  const commits: RawCommit[] = [];
  const refs: RawRef[] = [];
  // Main line of 400 commits; every 10 commits a branch forks off and (for most) merges back 6-25 commits later.
  const mainHashes = Array.from({ length: 400 }, (_, i) => `m${i}`);
  const pending: { at: number; tip: string }[] = [];
  const rows: RawCommit[] = [];
  for (let i = 399; i >= 0; i--) {
    const merged = pending.filter((p) => p.at === i);
    const parents = i < 399 ? [mainHashes[i + 1]] : [];
    for (const p of merged) parents.push(p.tip);
    rows.push(commit(mainHashes[i], parents));
    if (i % 10 === 5 && i > 30) {
      const len = 2 + (i % 4);
      let parent = mainHashes[i];
      for (let k = 0; k < len; k++) {
        const h = `b${i}_${k}`;
        rows.push(commit(h, [parent]));
        parent = h;
      }
      if (i % 30 === 5) refs.push(ref(`refs/remotes/origin/open${i}`, parent));
      else pending.push({ at: i - 6 - (i % 20), tip: parent });
    }
  }
  // rows were produced oldest-first per main step; order newest-first by time.
  rows.forEach((c, k) => (c.time = k));
  commits.push(...rows.sort((a, b) => b.time - a.time));
  refs.push(ref('refs/remotes/origin/main', 'm0'));
  return { commits, refs, remotes: ['origin'], headHash: 'm0', truncated: false };
}

test('large history solves within budget with bounded width', () => {
  const snap = largeSnapshot();
  const t0 = Date.now();
  const { model } = buildModel(snap, { filter: 'all', budgetMs: 300 });
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
  assert.equal(laneOf(model, 'm0'), 0);
  assert.ok(model.maxLane < 12, `maxLane ${model.maxLane}`);
});
