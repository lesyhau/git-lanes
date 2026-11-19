# Contributing to Git Lanes

## Development

Requires Node.js 22+ and git.

```sh
npm install
npm run build      # dist/extension.js + dist/webview/*.js
npm test           # layout engine, git reader (on a temp repo), fetch policy
npm run typecheck
npm run package    # git-lanes-<version>.vsix
```

Press **F5** in VS Code to open an Extension Development Host.

How it is organised:

- `src/git/reader.ts`: reads refs, remotes, HEAD and `git log --date-order`, and parses commit details.
- `src/graph/chains.ts`: splits history into first-parent chains (one per branch). Merged-and-deleted branches get their own chains.
- `src/graph/layout.ts`: the lane solver.
  - It derives the "right of" rules from branch-offs and merges.
  - It places chains in a priority order, each in the lowest lane allowed and free.
  - It scores each layout by crossings, width, jump length and moved branches.
  - With few branches it tries every valid order. With many, it repairs crossings one by one, then narrows the graph, within a time budget.
- `src/graph/model.ts`: builds badges, local-only flags and the default branch, and produces the drawable model.
- `src/fetch/policy.ts`: decides when to auto-fetch.
- `src/controller.ts`: repository selection, refresh on ref changes, fetching and the status bar button.
- `src/webview/*`: the graph renderer (sidebar and editor tab) and the commit details page.

## Releasing

Work branches (`feature/`, `bugfix/`, `chore/`, `docs/` and so on) come off `dev` and merge back into it. `main` changes only through a `dev` → `main` pull request.

1. On a `release/x.y.z` branch off `dev`, bump `version` in `package.json` and move the changelog's **Unreleased** entries under the new version. Merge it into `dev`.
2. Open the `dev` → `main` pull request and merge it with a merge commit.
3. Tag `main` and push the tag: `git tag vx.y.z && git push origin vx.y.z`.

The **Release** workflow then tests and packages the extension and attaches the `.vsix` to a GitHub Release. It also publishes it, but only when the repository has the tokens:
- to the VS Code Marketplace with a `VSCE_PAT` secret;
- to Open VSX (VSCodium, Cursor and other editors) with an `OVSX_PAT` secret.

Without them, upload the `.vsix` from the GitHub Release by hand.
