# AGENTS.md — dsh-code-git-workbench

This file tells an AI coding agent how to work in this repository. Read it before
changing code.

## What this project is

A DeepSeek Harness (DSH) plugin that adds two right-sidebar pages, **Code** and
**Git**, and keeps running subagents above idle ones in the header catalog.

The plugin is a Cordis bundle:

- **host half** — `index.mjs`, an ESM module loaded by the DSH host;
- **client half** — `client.js`, bundled into the DSH Web UI;
- **static UI** — `web/code/` and `web/git/`, served by the host and loaded in
  iframes when a tab is opened.

There is no build step. Everything is plain JavaScript/HTML/CSS.

## Layout

```
index.mjs              host: routes, file API, Git API, auth fence
client.js              client: tab registration + subagent catalog sorting
cordis.patch.yml       inserts the bundle row into the DSH profile
package.json           DSH metadata, exports, bundle/client entries
web/code/index.html    Code tab shell
web/code/app.js        tree, tabs, dirty state, save/reload
web/code/app.css       Code tab styling and CodeMirror theme
web/code/vendor/       vendored CodeMirror 5 + modes/addons
web/git/index.html     Git tab shell
web/git/main.js        reused PyCharm-style Git UI
web/git/main.css       reused VS Code webview styles
web/git/graph.js       commit graph layout
web/git/bridge.js      acquireVsCodeApi shim -> /code-git/api/*
web/git/theme.js       maps DSH tokens to --vscode-* variables
web/git/git-extra.css  diff overlay + prompt styling
web/git/codicons/      VS Code codicon font
preview/               local screenshots; not part of the runtime
README.md              human install/use guide
```

## Runtime contract

### Host

`index.mjs` exports:

```js
export const name = "code-git";
export const inject = ["webServer", "connection", "sessions", "workspaceRegistry"];
export function apply(ctx) { ... }
```

Rules:

- Register one prefix route: `/code-git`. Do not shadow DSH client-module paths.
- Every request must pass `ctx.connection.requestRejection(req)`.
- Resolve the session with `ctx.sessions.get(sessionId)` and take
  `header.cwd`; resolve the selected workspace through
  `ctx.workspaceRegistry.list()` and reject anything not in that list.
- Never let a path escape the selected root. `safeResolve`/`inside` exist for
  this reason.
- Git always goes through `execFile("git", args, { cwd, ... })`, never a shell.
  Keep `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat` and bounded `maxBuffer`.
- Body size is capped; files over 2 MB are rejected.
- API routes are listed in README; keep the table and `web/git/bridge.js` in
  sync when adding one.
- `apiGitStatus` parses `git status --porcelain=v1 -z --untracked-files=all`
  into staged, unstaged and untracked lists. `apiGitWorktreeDiff` compares
  HEAD/index for staged files and index/working tree for unstaged files.
- `pullBranch` fetches the selected remote branch and merges `FETCH_HEAD` into
  the current branch; it does not check out the other branch.
- Destructive actions (reset hard, delete branch, push) must remain explicit
  user actions with the existing confirmation prompts in the UI.

### Client

`client.js` is loaded by the DSH Web UI. It exports `apply`/`inject` from the
module factory and registers:

- `ctx.sidebarRightTabs.register(def)` for `codeGit.code` and `codeGit.git`;
- `ctx.slots.register({ name: "sidebar.right.pane.tab", key: id }, Component)`
  for each tab body;
- guide entries with `commandId` `codeGit.code` and `codeGit.git`.

The tab body receives `sessionId` automatically. The iframe URL is
`/code-git/web/code/index.html?session=<id>` or
`/code-git/web/git/index.html?session=<id>`.

Do **not** register custom keyboard shortcuts. DSH Web supports only its fixed
shortcut catalog and rejects custom ids with `Unsupported Web shortcut`; doing it
at startup can break the client bundle. Opening is through the `+` guide.

`installSubagentSorting` is a DOM-only enhancement: it finds
`[role="tree"]` elements whose `aria-label` mentions subagents, reads row
activity from `aria-label` (`running` vs `not running`), and moves running rows
first. Avoid touching host state; keep the observer cheap and idempotent.

### Branch tree and favorites

The branch list is a tree built in `web/git/main.js` from slash-separated names:

- `buildBranchTree` splits `feat/123-login` into the `feat` folder plus a
  `123-login` leaf, separately for Local and Remote;
- for Remote, a single remote name is stripped from the path (Remote → `feat`),
  while multiple remotes become the first folder (Remote → `origin` → `feat`);
- `renderBranchNodes` renders favorite leaves first, then folders, then the rest;
  inside each folder the same favorites-first rule applies;
- `defaultOpenFolders` opens the ancestors of the current branch and of
  favorites; explicit expand/collapse is stored in
  `dsh-code-git.branch-folders.v1` (localStorage, per repository root);
- folder rows show a branch count and are keyboard-expandable;
- filter mode force-expands matching folders and does not persist that
  expansion.

Favorites are a DSH-only UI feature:

- storage key `dsh-code-git.favorites.v1` in `localStorage`, a map from the
  repository root (`state.repoRoot`, fallback `state.repo`) to an array of full
  branch refs;
- a star button in each branch row (visible on hover, always visible when
  favorited) and an Add/Remove from Favorites item at the top of the branch
  context menu;
- `toggleFavorite` expands the folder path of a newly favorited branch;
- stale refs are pruned in `applyState`;
- `bridge.js` forwards `repoRoot` in the state for the storage key.

When porting the Git UI to the VS Code extension, carry the tree, favorites and
CSS with it; they are not host-side features.

### Working tree changes and branch pull

- `main.js` keeps a `changesStatus` cache and posts `{ type: "status" }` after each
  `state`; `bridge.js` fetches `/api/git/status` and emits `{ type: "status" }`.
- The toolbar diff button opens `#changes-layer`; groups are Staged, Unstaged and
  Untracked. Each row posts a `diff` message with `changeDiff: true`, `staged`,
  `path`, `oldPath` and `status`.
- `bridge.js` renders those diffs through `/api/git/worktree-diff`; keep the
  `[staged]` / `[unstaged]` title suffix.
- The branch context menu adds a `Pull` item from `pullTarget`: the current
  branch uses the existing `pull` action, other branches call `pullBranch` with
  `remote` and `branch`. Do not check out the selected branch implicitly.
- `Working tree changes` is read-only; there is no staging/commit control in this
  panel yet.

### Git UI bridge

`web/git/bridge.js` implements the `acquireVsCodeApi()` contract:

- UI message `ready`/`refresh` → refresh state;
- `selectRef` → Git log for a ref;
- `selectRepo` → switch workspace root;
- `details` → commit details;
- `diff` → diff overlay;
- `action` → POST `/api/git/action`;
- `copy` → clipboard.

If you change a message shape, update both `main.js` and `bridge.js`, and test the
Git tab manually.

## Development setup

Link the repository into a disposable profile:

```powershell
$repo = (Resolve-Path .).Path
$cli = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $cli plugin --profile web add "link:$repo"
& $cli --profile web --port 3080 --no-open
```

On Linux/macOS use the app's `dsh` CLI with `--profile web`.

For the desktop profile use `--profile desktop` and restart the application.
Never restart the user's running Harness while a live session is in progress
unless they asked; prefer the web profile for tests.

## Testing

Minimum smoke test:

1. UI boots with no `Failed to load plugins`.
2. The right sidebar `+` guide lists Code and Git.
3. Code opens a real file; edit and Save; verify bytes on disk.
4. Switch workspace; tree/footer/crumbs update.
5. Git loads branches and commits; open details and a file diff.
6. Open Working tree changes with staged and unstaged edits; open both diffs and
   check the `[staged]` / `[unstaged]` titles.
7. Use Pull in a branch context menu; the menu label must name the branch and the
   current branch must remain checked out.
8. Remote group collapses when >40 remotes.
9. Slash branches render as folders, the current branch path is open by default,
   and folder expand/collapse survives an iframe reload.
10. Filtering a branch expands only matching folders (for example `3493`).
11. Star a local branch inside a folder and a remote branch inside a folder; both
    move to the top of their folder, and the state survives an iframe reload.
12. Subagent catalog opens; running rows are above idle rows.

Use a throwaway Git repository for actions. Do not run reset/merge/rebase/push
against a user's working repository in tests.

Host API quick checks (authenticated browser):

```text
/code-git/api/context?session=...
/code-git/api/tree?session=...&root=...
/code-git/api/git/state?session=...&root=...
```

## Code style

- Vanilla JS, `"use strict"`, two-space indentation.
- No new runtime dependencies. CodeMirror is vendored; do not add a bundler.
- Keep the host ESM and the browser IIFE separate; no Node APIs in `web/`.
- Use existing CSS variables (`--bg`, `--fg`, `--accent`, `--vscode-*`) instead of
  hard-coded colors where possible.
- Escape usernames/paths in the DOM by using `textContent`, not HTML strings.
- Update README and AGENTS.md when behavior or setup changes.
- Do not commit `node_modules`, screenshots containing a real project, tokens,
  or absolute personal paths.

## Git UI mirror

`web/git/` originates from the companion `pycharm-git-log` VS Code extension. The
DSH copy is intentional and standalone. If you fix a Git UI bug in one project,
port the same fix to the other and test both; do not introduce a runtime
dependency between the repositories.

## Release checklist

- `node --check index.mjs client.js web/code/app.js web/git/bridge.js`.
- Smoke test in a web profile.
- Bump `version` in `package.json`.
- Update README/AGENTS if the install or API changed.
- Commit with a clear message. No generated artifacts.
