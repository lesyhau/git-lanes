import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AutoFetchPolicy, classifyFetchError, PolicyConfig } from '../src/fetch/policy';

const cfg: PolicyConfig = { enabled: true, intervalMs: 5 * 60_000, onWindowFocus: true, onLocalActivity: true };
const MIN = 60_000;

test('first trigger fetches; then each trigger waits for its staleness', () => {
  const p = new AutoFetchPolicy();
  const t0 = 10 * MIN;
  assert.ok(p.shouldFetch('visible', t0, cfg));
  p.started(t0);
  p.finished({ ok: true }, t0);
  assert.ok(!p.shouldFetch('activity', t0 + 20_000, cfg), 'min gap 30s');
  assert.ok(p.shouldFetch('activity', t0 + 31_000, cfg));
  assert.ok(!p.shouldFetch('visible', t0 + 50_000, cfg));
  assert.ok(p.shouldFetch('visible', t0 + 61_000, cfg));
  assert.ok(!p.shouldFetch('focus', t0 + 100_000, cfg));
  assert.ok(p.shouldFetch('focus', t0 + 2 * MIN + 1, cfg));
  assert.ok(!p.shouldFetch('interval', t0 + 4 * MIN, cfg));
  assert.ok(p.shouldFetch('interval', t0 + 5 * MIN, cfg));
});

test('settings switch triggers off', () => {
  const p = new AutoFetchPolicy();
  assert.ok(!p.shouldFetch('visible', MIN, { ...cfg, enabled: false }));
  assert.ok(!p.shouldFetch('focus', MIN, { ...cfg, onWindowFocus: false }));
  assert.ok(!p.shouldFetch('activity', MIN, { ...cfg, onLocalActivity: false }));
  assert.ok(p.shouldFetch('interval', 10 * MIN, { ...cfg, onWindowFocus: false, onLocalActivity: false }));
});

test('errors back off exponentially; success resets', () => {
  const p = new AutoFetchPolicy();
  let t = 100 * MIN;
  p.started(t);
  p.finished({ ok: false, problem: 'error' }, t);
  assert.equal(p.backoff(), MIN);
  p.finished({ ok: false, problem: 'error' }, t);
  p.finished({ ok: false, problem: 'error' }, t);
  assert.equal(p.backoff(), 4 * MIN);
  assert.ok(!p.shouldFetch('activity', t + 3 * MIN, cfg));
  assert.ok(p.shouldFetch('activity', t + 4 * MIN, cfg));
  for (let k = 0; k < 10; k++) p.finished({ ok: false, problem: 'error' }, t);
  assert.equal(p.backoff(), 30 * MIN);
  p.finished({ ok: true }, t);
  assert.equal(p.backoff(), 0);
});

test('sign-in problems pause auto fetch until a manual fetch succeeds; offline retries every 5 minutes', () => {
  const p = new AutoFetchPolicy();
  const t = 100 * MIN;
  p.started(t);
  p.finished({ ok: false, problem: 'auth' }, t);
  assert.ok(!p.shouldFetch('interval', t + 60 * MIN, cfg));
  p.finished({ ok: true }, t + 61 * MIN);
  assert.ok(p.shouldFetch('interval', t + 70 * MIN, cfg));

  const q = new AutoFetchPolicy();
  q.started(t);
  q.finished({ ok: false, problem: 'offline' }, t);
  assert.ok(!q.shouldFetch('focus', t + 4 * MIN, cfg));
  assert.ok(q.shouldFetch('focus', t + 5 * MIN, cfg));
});

test('classifies git fetch errors', () => {
  assert.equal(classifyFetchError("fatal: Authentication failed for 'https://github.com/a/b.git/'"), 'auth');
  assert.equal(classifyFetchError('git@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.'), 'auth');
  assert.equal(classifyFetchError("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), 'auth');
  assert.equal(classifyFetchError("fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com"), 'offline');
  assert.equal(classifyFetchError('ssh: connect to host github.com port 22: Network is unreachable'), 'offline');
  assert.equal(classifyFetchError("fatal: 'nope' does not appear to be a git repository"), 'error');
});
