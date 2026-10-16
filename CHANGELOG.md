# Changelog

## 0.2.0

First public release.

- Git Lanes view in the Explorer, next to Outline and Timeline, and a full graph in an editor tab (status bar button or the view's "open in editor" action).
- Default branch always in the far-left lane. Each branch keeps its own lane, always to the right of the branch it starts from; merges come in from the right. Lanes are chosen for the fewest crossings, then the fewest lanes.
- Every branch-off and merge is the same one-row S-curve.
- Remote branches are solid badges and local branches outlined; local-only commits are hollow dots on dashed lines. Branch and tag names sit next to each branch's latest commit.
- Fetch from the view, the editor tab or the status bar. Automatic fetch when the graph is shown, on window focus, after local git activity and on an interval, with backoff and no credential prompts.
- Commit details with changed files and diffs, plus Checkout, Create Branch, Copy Hash and Push.
