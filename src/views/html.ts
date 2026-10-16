import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

/** HTML shell for a webview: strict CSP, one bundled script, one stylesheet. */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, opts: { script: string; style: string; title: string; mode?: string }): string {
  const nonce = randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', opts.script));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', opts.style));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style}">
<title>${opts.title}</title>
</head>
<body data-mode="${opts.mode ?? ''}">
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
