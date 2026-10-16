import * as vscode from 'vscode';
import * as path from 'path';
import { API, Repository } from './git/api';
import { GitRunner } from './git/runner';
import { readSnapshot } from './git/reader';
import { buildModel, Filter } from './graph/model';
import { GraphModel, RepoSnapshot } from './graph/types';
import { AutoFetchPolicy, classifyFetchError, FetchOutcome, PolicyConfig, Trigger } from './fetch/policy';
import { FetchView, FromGraph, GraphState, ToGraph } from './shared/protocol';

/** A webview showing the graph (the Explorer view or the editor tab). */
export interface GraphHost {
  readonly visible: boolean;
  post(msg: ToGraph): void;
}

const LANES_KEY = 'gitLanes.lanes';
const FILTER_KEY = 'gitLanes.filter';
const TICK_MS = 30_000;
const ACTIVITY_DEBOUNCE_MS = 3_000;
const REFRESH_DEBOUNCE_MS = 300;

function config() {
  return vscode.workspace.getConfiguration('gitLanes');
}

function errorText(e: unknown): string {
  const any = e as { stderr?: string; message?: string; gitErrorCode?: string };
  return [any?.stderr, any?.message, any?.gitErrorCode].filter(Boolean).join('\n') || String(e);
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/).map((l) => l.replace(/^(fatal|error):\s*/i, '').trim()).find(Boolean);
  return line ?? s;
}

export class GraphController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private repoDisposables: vscode.Disposable[] = [];
  private readonly hosts = new Set<GraphHost>();
  private readonly policies = new Map<string, AutoFetchPolicy>();
  private readonly fetchViews = new Map<string, FetchView>();
  private readonly status: vscode.StatusBarItem;
  private readonly openItem: vscode.StatusBarItem;

  private repo?: Repository;
  private runner?: GitRunner;
  private pinnedRepo?: string;
  private snapshot?: RepoSnapshot;
  private model?: GraphModel;
  private loadError?: string;
  private loading = false;
  private loadQueued = false;
  private maxCommits: number;
  private filter: Filter;
  private headSig = '';
  private refreshTimer?: NodeJS.Timeout;
  private activityTimer?: NodeJS.Timeout;
  private readonly tickTimer: NodeJS.Timeout;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    readonly api: API,
  ) {
    this.maxCommits = config().get<number>('maxCommits', 400);
    this.filter = ctx.workspaceState.get<Filter>(FILTER_KEY, 'all');
    this.status = vscode.window.createStatusBarItem('gitLanes.fetch', vscode.StatusBarAlignment.Left, 50);
    this.status.name = 'Git Lanes Fetch';
    this.status.command = 'gitLanes.fetch';
    // In big repositories the sidebar is cramped: one click opens the full graph in the editor area.
    this.openItem = vscode.window.createStatusBarItem('gitLanes.open', vscode.StatusBarAlignment.Left, 51);
    this.openItem.name = 'Git Lanes';
    this.openItem.text = '$(git-merge) Git Lanes';
    this.openItem.tooltip = 'Open the Git Lanes graph in the editor';
    this.openItem.command = 'gitLanes.openInEditor';

    this.disposables.push(
      this.status,
      this.openItem,
      api.onDidOpenRepository(() => this.pickRepo()),
      api.onDidCloseRepository(() => this.pickRepo()),
      api.onDidChangeState(() => this.pickRepo()),
      vscode.window.onDidChangeActiveTextEditor(() => {
        if (this.api.repositories.length > 1) this.pickRepo();
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) this.trigger('focus');
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('gitLanes')) return;
        if (e.affectsConfiguration('gitLanes.maxCommits')) this.maxCommits = config().get<number>('maxCommits', 400);
        this.scheduleRefresh();
      }),
    );
    this.tickTimer = setInterval(() => {
      this.updateStatusBar();
      if (vscode.window.state.focused && this.anyVisible()) this.trigger('interval');
    }, TICK_MS);
    this.pickRepo();
  }

  dispose(): void {
    clearInterval(this.tickTimer);
    clearTimeout(this.refreshTimer);
    clearTimeout(this.activityTimer);
    this.repoDisposables.forEach((d) => d.dispose());
    this.disposables.forEach((d) => d.dispose());
  }

  // ---- hosts ----

  addHost(host: GraphHost): vscode.Disposable {
    this.hosts.add(host);
    return { dispose: () => this.hosts.delete(host) };
  }

  hostBecameVisible(host: GraphHost): void {
    host.post(this.state());
    this.trigger('visible');
  }

  /** For tests: webviews that loaded their script and reported ready. */
  readyCount = 0;

  get hostCount(): number {
    return this.hosts.size;
  }

  get fetchStatus(): FetchView {
    return this.fetchView();
  }

  handleMessage(host: GraphHost, msg: FromGraph): void {
    switch (msg.type) {
      case 'ready':
        this.readyCount++;
        host.post(this.state());
        if (host.visible) this.trigger('visible');
        break;
      case 'openCommit':
        void vscode.commands.executeCommand('gitLanes.openCommit', { hash: msg.hash });
        break;
      case 'setFilter':
        this.setFilter(msg.filter);
        break;
      case 'fetch':
        void this.fetch(true);
        break;
      case 'loadMore':
        this.maxCommits += config().get<number>('maxCommits', 400);
        void this.load();
        break;
    }
  }

  private anyVisible(): boolean {
    for (const h of this.hosts) if (h.visible) return true;
    return false;
  }

  private broadcast(msg: ToGraph): void {
    for (const h of this.hosts) h.post(msg);
  }

  private state(): GraphState {
    return {
      type: 'state',
      noRepo: !this.repo,
      repoName: this.repo ? path.basename(this.repo.rootUri.fsPath) : undefined,
      model: this.model,
      error: this.loadError,
      loading: this.loading && !this.model,
      filter: this.filter,
      fetch: this.fetchView(),
      autoFetch: config().get<boolean>('autoFetch.enabled', true),
      colors: config().get<string[]>('laneColors', []),
    };
  }

  // ---- repository selection ----

  get repository(): Repository | undefined {
    return this.repo;
  }

  get git(): GitRunner | undefined {
    return this.runner;
  }

  get currentModel(): GraphModel | undefined {
    return this.model;
  }

  get currentSnapshot(): RepoSnapshot | undefined {
    return this.snapshot;
  }

  async selectRepository(): Promise<void> {
    const repos = this.api.repositories;
    const pick = await vscode.window.showQuickPick(
      repos.map((r) => ({ label: path.basename(r.rootUri.fsPath), description: r.rootUri.fsPath, repo: r })),
      { placeHolder: 'Repository to show in Git Lanes' },
    );
    if (!pick) return;
    this.pinnedRepo = pick.repo.rootUri.fsPath;
    this.pickRepo();
  }

  private pickRepo(): void {
    const repos = this.api.repositories;
    void vscode.commands.executeCommand('setContext', 'gitLanes.multipleRepos', repos.length > 1);
    const editor = vscode.window.activeTextEditor?.document.uri;
    const next =
      repos.find((r) => r.rootUri.fsPath === this.pinnedRepo) ??
      (editor && editor.scheme === 'file' ? this.api.getRepository(editor) ?? undefined : undefined) ??
      repos.find((r) => r.ui.selected) ??
      repos[0];
    if (next === this.repo) return;
    this.setRepo(next);
  }

  private setRepo(repo: Repository | undefined): void {
    this.repoDisposables.forEach((d) => d.dispose());
    this.repoDisposables = [];
    this.repo = repo;
    this.runner = repo ? new GitRunner(this.api.git.path, repo.rootUri.fsPath) : undefined;
    this.snapshot = undefined;
    this.model = undefined;
    this.loadError = undefined;
    this.maxCommits = config().get<number>('maxCommits', 400);
    if (repo) {
      this.headSig = this.headSignature(repo);
      // Ref files tell local activity (HEAD, branches, tags) apart from fetches (remote refs, FETCH_HEAD).
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repo.rootUri, '.git/{HEAD,packed-refs,refs/**}'));
      const onRef = (uri: vscode.Uri) => {
        this.scheduleRefresh();
        const p = uri.path.replace(/\\/g, '/');
        if (!p.includes('/refs/remotes/') && !p.endsWith('/packed-refs')) this.localActivity();
      };
      this.repoDisposables.push(
        watcher,
        watcher.onDidChange(onRef),
        watcher.onDidCreate(onRef),
        watcher.onDidDelete(onRef),
        // Covers worktrees and submodules, where .git is a file and the watcher above sees nothing.
        repo.state.onDidChange(() => {
          const sig = this.headSignature(repo);
          if (sig === this.headSig) return;
          this.headSig = sig;
          this.scheduleRefresh();
          this.localActivity();
        }),
      );
    }
    this.updateStatusBar();
    this.broadcast(this.state());
    void this.load().then(() => {
      if (this.anyVisible()) this.trigger('visible');
    });
  }

  private headSignature(repo: Repository): string {
    const h = repo.state.HEAD;
    return `${h?.name ?? ''}@${h?.commit ?? ''}`;
  }

  // ---- loading ----

  setFilter(filter: Filter): void {
    if (filter === this.filter) return;
    this.filter = filter;
    void this.ctx.workspaceState.update(FILTER_KEY, filter);
    void this.load();
  }

  toggleFilter(): void {
    this.setFilter(this.filter === 'all' ? 'remote' : 'all');
  }

  scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.load(), REFRESH_DEBOUNCE_MS);
  }

  async load(): Promise<void> {
    if (this.loading) {
      this.loadQueued = true;
      return;
    }
    this.loading = true;
    try {
      do {
        this.loadQueued = false;
        await this.loadOnce();
      } while (this.loadQueued);
    } finally {
      this.loading = false;
    }
  }

  private async loadOnce(): Promise<void> {
    const repo = this.repo;
    const runner = this.runner;
    if (!repo || !runner) {
      this.broadcast(this.state());
      return;
    }
    try {
      const snap = await readSnapshot(runner, this.maxCommits);
      if (repo !== this.repo) return;
      const key = repo.rootUri.fsPath;
      const stored = this.ctx.workspaceState.get<Record<string, Record<string, number>>>(LANES_KEY, {});
      const prev = stored[key] ? new Map(Object.entries(stored[key])) : undefined;
      const { model, lanes } = buildModel(snap, {
        filter: this.filter,
        defaultBranch: config().get<string>('defaultBranch', '') || undefined,
        prevLanes: prev,
      });
      void this.ctx.workspaceState.update(LANES_KEY, { ...stored, [key]: Object.fromEntries(lanes) });
      this.snapshot = snap;
      this.model = model;
      this.loadError = undefined;
    } catch (e) {
      if (repo !== this.repo) return;
      this.loadError = firstLine(errorText(e));
    }
    this.updateStatusBar();
    this.broadcast(this.state());
  }

  // ---- fetching ----

  private policy(): AutoFetchPolicy | undefined {
    if (!this.repo) return undefined;
    const key = this.repo.rootUri.fsPath;
    let p = this.policies.get(key);
    if (!p) this.policies.set(key, (p = new AutoFetchPolicy()));
    return p;
  }

  private fetchView(): FetchView {
    return (this.repo && this.fetchViews.get(this.repo.rootUri.fsPath)) || { status: 'idle' };
  }

  private setFetchView(view: FetchView): void {
    if (!this.repo) return;
    this.fetchViews.set(this.repo.rootUri.fsPath, view);
    void vscode.commands.executeCommand('setContext', 'gitLanes.fetching', view.status === 'fetching');
    this.updateStatusBar();
    this.broadcast({ type: 'fetch', fetch: view });
  }

  private policyConfig(): PolicyConfig {
    const c = config();
    return {
      enabled: c.get<boolean>('autoFetch.enabled', true),
      intervalMs: Math.max(1, c.get<number>('autoFetch.intervalMinutes', 5)) * 60_000,
      onWindowFocus: c.get<boolean>('autoFetch.onWindowFocus', true),
      onLocalActivity: c.get<boolean>('autoFetch.onLocalActivity', true),
    };
  }

  private trigger(trigger: Trigger): void {
    const p = this.policy();
    if (!p || !this.snapshot?.remotes.length || this.fetchView().status === 'fetching') return;
    if (p.shouldFetch(trigger, Date.now(), this.policyConfig())) void this.fetch(false);
  }

  private localActivity(): void {
    clearTimeout(this.activityTimer);
    this.activityTimer = setTimeout(() => this.trigger('activity'), ACTIVITY_DEBOUNCE_MS);
  }

  /**
   * Fetches run git directly with prompts disabled, so an automatic fetch can never pop up a credential dialog.
   * A manual fetch that needs sign-in retries through the Git extension, whose prompts let the user sign in.
   */
  async fetch(manual: boolean): Promise<void> {
    const repo = this.repo;
    const runner = this.runner;
    const policy = this.policy();
    if (!repo || !runner || !policy || this.fetchView().status === 'fetching') return;
    if (manual && this.snapshot && !this.snapshot.remotes.length) {
      void vscode.window.showInformationMessage('This repository has no remotes to fetch from.');
      return;
    }
    const prune = config().get<boolean>('fetch.prune', true);
    const lastFetch = this.fetchView().lastFetch;
    const beforeTips = new Map((this.snapshot?.refs ?? []).filter((r) => r.kind === 'remote').map((r) => [r.full, r.hash]));
    const beforeCommits = new Set((this.snapshot?.commits ?? []).map((c) => c.hash));
    policy.started(Date.now());
    this.setFetchView({ status: 'fetching', lastFetch });

    let outcome: FetchOutcome;
    const fetchQuietly = () => runner.run(['-c', 'credential.interactive=never', 'fetch', '--all', ...(prune ? ['--prune'] : [])], { timeoutMs: 120_000 });
    try {
      try {
        await fetchQuietly();
      } catch (e) {
        if (!manual || classifyFetchError(errorText(e)) !== 'auth') throw e;
        await repo.fetch({ all: true, prune });
      }
      outcome = { ok: true };
    } catch (e) {
      const text = errorText(e);
      outcome = { ok: false, problem: classifyFetchError(text), message: firstLine(text) };
    }
    if (repo !== this.repo) return;
    policy.finished(outcome, Date.now());
    this.setFetchView(outcome.ok ? { status: 'idle', lastFetch: Date.now() } : { status: outcome.problem!, lastFetch, message: outcome.message });
    await this.load();
    if (manual && outcome.ok) this.broadcast({ type: 'notice', text: this.fetchSummary(beforeTips, beforeCommits) });
  }

  private fetchSummary(beforeTips: Map<string, string>, beforeCommits: Set<string>): string {
    const snap = this.snapshot;
    if (!snap) return 'Fetched';
    const changed = snap.refs.filter((r) => r.kind === 'remote' && beforeTips.get(r.full) !== r.hash).map((r) => `${r.remote}/${r.name}`);
    const added = snap.commits.filter((c) => !beforeCommits.has(c.hash)).length;
    if (!changed.length && !added) return 'Already up to date';
    const where = changed.length ? ` on ${changed.slice(0, 2).join(', ')}${changed.length > 2 ? ` and ${changed.length - 2} more` : ''}` : '';
    if (!added) return `Updated${where}`;
    return `${added} new commit${added === 1 ? '' : 's'}${where}`;
  }

  private updateStatusBar(): void {
    if (this.repo) this.openItem.show();
    else this.openItem.hide();
    if (!this.repo || !this.snapshot?.remotes.length) {
      this.status.hide();
      return;
    }
    const v = this.fetchView();
    const ago = v.lastFetch ? relativeTime(v.lastFetch) : undefined;
    switch (v.status) {
      case 'fetching':
        this.status.text = '$(sync~spin) Fetching…';
        break;
      case 'auth':
        this.status.text = '$(account) Sign in to fetch';
        break;
      case 'offline':
        this.status.text = '$(debug-disconnect) Offline';
        break;
      case 'error':
        this.status.text = '$(warning) Fetch failed';
        break;
      default:
        this.status.text = ago ? `$(cloud-download) ${ago}` : '$(cloud-download) Fetch';
    }
    const auto = config().get<boolean>('autoFetch.enabled', true);
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**Git Lanes** — ${v.message ? v.message : ago ? `last fetched ${ago}` : 'not fetched yet'}\n\n`);
    tip.appendMarkdown(auto ? 'Auto-fetch is on: when the graph is shown, on window focus, after local git activity, and on an interval.\n\n' : 'Auto-fetch is off.\n\n');
    tip.appendMarkdown('Click to fetch all remotes now.');
    this.status.tooltip = tip;
    this.status.show();
  }
}

export function relativeTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
