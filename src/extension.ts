import * as vscode from 'vscode';
import { GitExtension } from './git/api';
import { GraphController } from './controller';
import { GraphPanel, GraphViewProvider } from './views/graphViews';
import { CommitPanel } from './views/commitPanel';
import { checkoutCommit, createBranchAt, hashFrom } from './commands';

/** Returned from activate() for integration tests. */
export interface TestApi {
  controller: GraphController;
}

export async function activate(ctx: vscode.ExtensionContext): Promise<TestApi | undefined> {
  const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!gitExt) {
    void vscode.window.showErrorMessage('Git Lanes needs the built-in Git extension, which is not available.');
    return undefined;
  }
  const api = (await gitExt.activate()).getAPI(1);
  const controller = new GraphController(ctx, api);
  ctx.subscriptions.push(controller);

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(GraphViewProvider.id, new GraphViewProvider(ctx.extensionUri, controller)),
    vscode.commands.registerCommand('gitLanes.fetch', () => controller.fetch(true)),
    vscode.commands.registerCommand('gitLanes.fetching', () => undefined),
    vscode.commands.registerCommand('gitLanes.openInEditor', () => GraphPanel.show(ctx.extensionUri, controller)),
    vscode.commands.registerCommand('gitLanes.refresh', () => controller.load()),
    vscode.commands.registerCommand('gitLanes.toggleRemoteOnly', () => controller.toggleFilter()),
    vscode.commands.registerCommand('gitLanes.selectRepository', () => controller.selectRepository()),
    vscode.commands.registerCommand('gitLanes.toggleAutoFetch', async () => {
      const c = vscode.workspace.getConfiguration('gitLanes');
      const next = !c.get<boolean>('autoFetch.enabled', true);
      await c.update('autoFetch.enabled', next, vscode.ConfigurationTarget.Global);
      void vscode.window.setStatusBarMessage(`Git Lanes auto-fetch ${next ? 'on' : 'off'}`, 2500);
    }),
    vscode.commands.registerCommand('gitLanes.openCommit', (arg: unknown) => {
      const hash = hashFrom(arg);
      if (hash) CommitPanel.show(ctx.extensionUri, controller, hash);
    }),
    vscode.commands.registerCommand('gitLanes.copyHash', async (arg: unknown) => {
      const hash = hashFrom(arg);
      if (!hash) return;
      await vscode.env.clipboard.writeText(hash);
      void vscode.window.setStatusBarMessage(`Copied ${hash.slice(0, 7)}`, 2000);
    }),
    vscode.commands.registerCommand('gitLanes.checkout', async (arg: unknown) => {
      const hash = hashFrom(arg);
      if (hash) await checkoutCommit(controller, hash);
    }),
    vscode.commands.registerCommand('gitLanes.createBranch', async (arg: unknown) => {
      const hash = hashFrom(arg);
      if (hash) await createBranchAt(controller, hash);
    }),
  );
  return { controller };
}

export function deactivate(): void {}
