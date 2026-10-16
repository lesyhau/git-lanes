import * as vscode from 'vscode';
import { GraphController } from './controller';

/** Argument passed by webview context-menu commands (from the row's data-vscode-context). */
export interface CommitContext {
  hash?: string;
}

export function hashFrom(arg: unknown): string | undefined {
  const h = (arg as CommitContext | undefined)?.hash;
  return typeof h === 'string' && /^[0-9a-f]{4,64}$/i.test(h) ? h : undefined;
}

export async function checkoutCommit(controller: GraphController, hash: string): Promise<void> {
  const repo = controller.repository;
  const git = controller.git;
  const snap = controller.currentSnapshot;
  if (!repo || !git || !snap) return;
  type Item = vscode.QuickPickItem & { run: () => Promise<unknown> };
  const items: Item[] = [];
  const localNames = new Set(snap.refs.filter((r) => r.kind === 'head').map((r) => r.name));
  for (const r of snap.refs) {
    if (r.hash !== hash) continue;
    if (r.kind === 'head') {
      items.push({ label: `$(git-branch) ${r.name}`, description: 'local branch', run: () => repo.checkout(r.name) });
    } else if (r.kind === 'remote' && !localNames.has(r.name)) {
      items.push({
        label: `$(cloud) ${r.remote}/${r.name}`,
        description: `create local ${r.name} tracking it`,
        run: () => git.run(['checkout', '--track', `${r.remote}/${r.name}`]),
      });
    }
  }
  items.push({ label: `$(git-commit) ${hash.slice(0, 7)}`, description: 'detached HEAD', run: () => repo.checkout(hash) });
  const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { placeHolder: 'Checkout' });
  if (!pick) return;
  if (items.length === 1) {
    const ok = await vscode.window.showWarningMessage(`Check out ${hash.slice(0, 7)} as a detached HEAD?`, { modal: true }, 'Checkout');
    if (ok !== 'Checkout') return;
  }
  try {
    await pick.run();
    controller.scheduleRefresh();
  } catch (e) {
    void vscode.window.showErrorMessage(`Checkout failed: ${(e as Error).message}`);
  }
}

export async function createBranchAt(controller: GraphController, hash: string): Promise<void> {
  const repo = controller.repository;
  if (!repo) return;
  const name = await vscode.window.showInputBox({
    prompt: `New branch at ${hash.slice(0, 7)}`,
    placeHolder: 'Branch name',
    validateInput: (v) => (/^(?!\/|.*(\.\.|\/\/|@\{|\\))[^\s~^:?*[]+(?<![./])$/.test(v.trim()) ? undefined : 'Not a valid branch name'),
  });
  if (!name) return;
  try {
    await repo.createBranch(name.trim(), true, hash);
    controller.scheduleRefresh();
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not create branch: ${(e as Error).message}`);
  }
}
