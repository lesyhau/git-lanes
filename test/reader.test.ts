import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitRunner } from '../src/git/runner';
import { readCommitDetails, readSnapshot } from '../src/git/reader';
import { buildModel } from '../src/graph/model';

function sh(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' },
  });
}

test('reads a real repository with remote, local-only and tracking branches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-lanes-'));
  try {
    const origin = join(dir, 'origin.git');
    const work = join(dir, 'work');
    sh(dir, 'init', '--bare', '-b', 'main', origin);
    sh(dir, 'clone', '-q', origin, work);
    const commit = (file: string, msg: string) => {
      writeFileSync(join(work, file), msg + '\n');
      sh(work, 'add', '-A');
      sh(work, 'commit', '-q', '-m', msg);
    };
    commit('a.txt', 'first');
    commit('b.txt', 'second');
    sh(work, 'push', '-q', '-u', 'origin', 'main');
    sh(work, 'checkout', '-q', '-b', 'feature/x');
    commit('my file.txt', 'feature work');
    sh(work, 'push', '-q', '-u', 'origin', 'feature/x');
    commit('c.txt', 'unpushed');
    sh(work, 'checkout', '-q', 'main');
    sh(work, 'merge', '-q', '--no-ff', '-m', "Merge branch 'feature/x'", 'origin/feature/x');
    sh(work, 'mv', 'a.txt', 'renamed.txt');
    sh(work, 'commit', '-q', '-m', 'rename');
    sh(work, 'push', '-q', 'origin', 'main');
    sh(work, 'tag', 'v1');
    sh(work, 'checkout', '-q', '-b', 'local-only');
    commit('d.txt', 'local only');
    sh(work, 'remote', 'set-head', 'origin', 'main');

    const git = new GitRunner('git', work);
    const snap = await readSnapshot(git, 100);
    assert.equal(snap.commits.length, 7);
    assert.equal(snap.originHead, 'main');
    assert.equal(snap.headRef, 'refs/heads/local-only');
    const fx = snap.refs.find((r) => r.full === 'refs/heads/feature/x')!;
    assert.equal(fx.upstream, 'refs/remotes/origin/feature/x');
    assert.equal(fx.ahead, 1);
    assert.ok(!snap.refs.some((r) => r.full === 'refs/remotes/origin/HEAD'));

    const { model } = buildModel(snap, { filter: 'all' });
    const by = (subject: string) => model.commits.find((c) => c.subject === subject)!;
    assert.equal(by('first').lane, 0);
    assert.equal(by('rename').lane, 0);
    assert.equal(by("Merge branch 'feature/x'").lane, 0);
    assert.ok(by('feature work').lane > 0);
    assert.equal(by('unpushed').lane, by('feature work').lane, 'ahead commits share the remote lane');
    assert.ok(by('unpushed').local);
    assert.ok(by('local only').local);
    assert.ok(!by('feature work').local);
    assert.deepEqual(by('rename').badges.map((b) => [b.kind, b.name]), [['both', 'main'], ['tag', 'v1']]);
    assert.deepEqual(by('local only').badges.map((b) => [b.kind, b.name, !!b.head]), [['local', 'local-only', true]]);
    assert.deepEqual(by('unpushed').badges.map((b) => [b.kind, b.name, b.ahead]), [['local', 'feature/x', 1]]);
    assert.deepEqual(by('feature work').badges.map((b) => [b.kind, b.name]), [['remote', 'feature/x']]);

    const rename = await readCommitDetails(git, by('rename').hash);
    assert.deepEqual(rename.files.map((f) => [f.status, f.oldPath, f.path]), [['R', 'a.txt', 'renamed.txt']]);
    const feature = await readCommitDetails(git, by('feature work').hash);
    assert.deepEqual(feature.files.map((f) => [f.status, f.path, f.added, f.deleted]), [['A', 'my file.txt', 1, 0]]);
    const root = await readCommitDetails(git, by('first').hash);
    assert.deepEqual(root.files.map((f) => f.path), ['a.txt']);
    assert.equal(root.parents.length, 0);

    const small = await readSnapshot(git, 3);
    assert.equal(small.commits.length, 3);
    assert.ok(small.truncated);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('empty repository reads without errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-lanes-'));
  try {
    sh(dir, 'init', '-q');
    const snap = await readSnapshot(new GitRunner('git', dir), 100);
    assert.equal(snap.commits.length, 0);
    assert.equal(snap.headHash, undefined);
    const { model } = buildModel(snap, { filter: 'all' });
    assert.equal(model.commits.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
