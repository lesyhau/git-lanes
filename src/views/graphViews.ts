import * as vscode from 'vscode';
import { GraphController, GraphHost } from '../controller';
import { FromGraph, ToGraph } from '../shared/protocol';
import { webviewHtml } from './html';

function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
  };
}

/** The "Git Lanes" view at the bottom of the Explorer, next to Outline and Timeline. */
export class GraphViewProvider implements vscode.WebviewViewProvider {
  static readonly id = 'gitLanes.view';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: GraphController,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = webviewOptions(this.extensionUri);
    view.webview.html = webviewHtml(view.webview, this.extensionUri, { script: 'graph.js', style: 'graph.css', title: 'Git Lanes', mode: 'side' });
    const host: GraphHost = {
      get visible() {
        return view.visible;
      },
      post: (msg: ToGraph) => void view.webview.postMessage(msg),
    };
    const registration = this.controller.addHost(host);
    const subs = [
      view.webview.onDidReceiveMessage((m: FromGraph) => this.controller.handleMessage(host, m)),
      view.onDidChangeVisibility(() => {
        if (view.visible) this.controller.hostBecameVisible(host);
      }),
    ];
    view.onDidDispose(() => {
      registration.dispose();
      subs.forEach((s) => s.dispose());
    });
  }
}

/** The full-width graph in an editor tab. */
export class GraphPanel {
  private static current?: GraphPanel;

  static show(extensionUri: vscode.Uri, controller: GraphController): void {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      return;
    }
    GraphPanel.current = new GraphPanel(extensionUri, controller);
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(extensionUri: vscode.Uri, controller: GraphController) {
    this.panel = vscode.window.createWebviewPanel('gitLanes.panel', 'Git Lanes', vscode.ViewColumn.Active, webviewOptions(extensionUri));
    this.panel.iconPath = new vscode.ThemeIcon('git-merge');
    this.panel.webview.html = webviewHtml(this.panel.webview, extensionUri, { script: 'graph.js', style: 'graph.css', title: 'Git Lanes', mode: 'wide' });
    const panel = this.panel;
    const host: GraphHost = {
      get visible() {
        return panel.visible;
      },
      post: (msg: ToGraph) => void panel.webview.postMessage(msg),
    };
    const registration = controller.addHost(host);
    const subs = [
      panel.webview.onDidReceiveMessage((m: FromGraph) => controller.handleMessage(host, m)),
      panel.onDidChangeViewState(() => {
        if (panel.visible) controller.hostBecameVisible(host);
      }),
    ];
    panel.onDidDispose(() => {
      registration.dispose();
      subs.forEach((s) => s.dispose());
      GraphPanel.current = undefined;
    });
  }
}
