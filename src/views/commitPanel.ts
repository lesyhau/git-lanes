import * as vscode from 'vscode';
import * as path from 'path';
import { GraphController } from '../controller';
import { CommitDetails, EMPTY_TREE, readCommitDetails } from '../git/reader';
import { CommitState, FromCommit } from '../shared/protocol';
import { webviewHtml } from './html';
import { checkoutCommit, createBranchAt } from '../commands';

/** Commit details in an editor tab. One tab is reused, like a preview. */
export class CommitPanel {
  private static current?: CommitPanel;

  static show(extensionUri: vscode.Uri, controller: GraphController, hash: string): void {
    if (!CommitPanel.current) CommitPanel.current = new CommitPanel(extensionUri, controller);
    void CommitPanel.current.load(hash);
  }

  private readonly panel: vscode.WebviewPanel;
  private hash = '';
  private details?: CommitDetails;
  private ready = false;
  private pending?: CommitState;

  private constructor(
    extensionUri: vscode.Uri,
    private readonly controller: GraphController,
  ) {
    this.panel = vscode.window.createWebviewPanel('gitLanes.commit', 'Commit', { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
    });
    this.panel.iconPath = new vscode.ThemeIcon('git-commit');
    this.panel.webview.html = webviewHtml(this.panel.webview, extensionUri, { script: 'commit.js', style: 'commit.css', title: 'Commit' });
    this.panel.webview.onDidReceiveMessage((m: FromCommit) => void this.onMessage(m));
    this.panel.onDidDispose(() => (CommitPanel.current = undefined));
  }

  private async load(hash: string): Promise<void> {
    this.hash = hash;
    this.panel.title = `Commit ${hash.slice(0, 7)}`;
    this.panel.reveal(undefined, true);
    const git = this.controller.git;
    const base = this.baseState(hash);
    if (!git) return this.post({ ...base, error: 'No repository' });
    if (this.details?.hash !== hash) this.post(base);
    try {
      const details = await readCommitDetails(git, hash);
      if (hash !== this.hash) return;
      this.details = details;
      this.post({ ...base, details });
    } catch (e) {
      this.post({ ...base, error: (e as Error).message });
    }
  }

  private baseState(hash: string): CommitState {
    const model = this.controller.currentModel;
    const c = model?.commits.find((x) => x.hash === hash);
    return {
      type: 'commit',
      hash,
      badges: c?.badges ?? [],
      local: c?.local ?? false,
      hasRemotes: model?.hasRemotes ?? false,
      lane: c?.lane ?? 0,
      colors: vscode.workspace.getConfiguration('gitLanes').get<string[]>('laneColors', []),
    };
  }

  private post(state: CommitState): void {
    if (this.ready) void this.panel.webview.postMessage(state);
    else this.pending = state;
  }

  private async onMessage(m: FromCommit): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        if (this.pending) void this.panel.webview.postMessage(this.pending);
        this.pending = undefined;
        return;
      case 'openCommit':
        return this.load(m.hash);
      case 'openDiff':
        return this.openDiff(m.index);
      case 'action':
        if (m.action === 'copy') {
          await vscode.env.clipboard.writeText(this.hash);
          void vscode.window.setStatusBarMessage(`Copied ${this.hash.slice(0, 7)}`, 2000);
        } else if (m.action === 'checkout') {
          await checkoutCommit(this.controller, this.hash);
        } else if (m.action === 'branch') {
          await createBranchAt(this.controller, this.hash);
        } else if (m.action === 'push') {
          await this.push();
        }
    }
  }

  private async openDiff(index: number): Promise<void> {
    const repo = this.controller.repository;
    const file = this.details?.files[index];
    if (!repo || !file || !this.details) return;
    const api = this.controller.api;
    const parent = this.details.parents[0] ?? EMPTY_TREE;
    const short = this.hash.slice(0, 7);
    const right = api.toGitUri(vscode.Uri.joinPath(repo.rootUri, file.path), this.hash);
    const left = api.toGitUri(vscode.Uri.joinPath(repo.rootUri, file.oldPath ?? file.path), parent);
    const title = `${path.basename(file.path)} (${short}^ ↔ ${short})`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  /** Pushes the local branch that points at this commit, or the checked-out branch. */
  private async push(): Promise<void> {
    const repo = this.controller.repository;
    const snap = this.controller.currentSnapshot;
    if (!repo || !snap) return;
    const here = snap.refs.find((r) => r.kind === 'head' && r.hash === this.hash);
    const branch = here ?? snap.refs.find((r) => r.full === snap.headRef);
    if (!branch) {
      void vscode.window.showWarningMessage('No local branch points at this commit. Create a branch first, then push it.');
      return;
    }
    const upstream = branch.upstream ? snap.refs.find((r) => r.full === branch.upstream) : undefined;
    const remote = upstream?.remote ?? (snap.remotes.includes('origin') ? 'origin' : snap.remotes[0]);
    if (!remote) {
      void vscode.window.showWarningMessage('This repository has no remote to push to.');
      return;
    }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pushing ${branch.name} to ${remote}…` }, () =>
        repo.push(remote, branch.name, !upstream),
      );
      this.controller.scheduleRefresh();
      void this.load(this.hash);
    } catch (e) {
      void vscode.window.showErrorMessage(`Push failed: ${(e as Error).message}`);
    }
  }
}
