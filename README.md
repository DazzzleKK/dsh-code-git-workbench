# dsh-code-git-workbench

A Code and Git workbench for the **DeepSeek Harness Web UI**. It adds two pages
to the right Sidebar:

- **Code** — a lazy file tree for a Harness workspace, file tabs, a CodeMirror
  editor, syntax highlighting, search, reload and save.
- **Git** — a PyCharm-style log: local/remote branches, a commit graph, commit
  details, file diffs, checkout, merge, rebase, cherry-pick, reset, revert, tags
  and fetch/pull/push.

It also keeps running subagents above idle ones in the header's subagent catalog
popup.

The plugin is host + client code for DeepSeek Harness. It has no build step and
no dependency on VS Code. The PyCharm-style Git UI is shared in source form with
the companion VS Code extension
[pycharm-git-log](https://github.com/DazzzleKK/pycharm-git-log); the two
repositories remain independent at runtime.

## Requirements

- DeepSeek Harness with the bundled plugin CLI (tested on the 0.2.1-rc.2 /
  DSH 44.x desktop build).
- A local Git repository for the Git page.
- Node.js is **not** required to install or run the plugin.

## Install

Clone this repository somewhere permanent, then register the folder as a local
plugin in the `desktop` profile.

### Windows

```powershell
$repo = "C:\path\to\dsh-code-git-workbench"
$cli = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $cli plugin --profile desktop add "link:$repo"
```

### macOS / Linux

Use the `dsh` CLI that ships with the application. Its exact path depends on the
install layout; with the CLI already on `PATH`:

```bash
dsh plugin --profile desktop add link:/absolute/path/to/dsh-code-git-workbench
```

Fully quit and reopen DeepSeek Harness. A window reload is not enough: the host
half is loaded at process start.

To use it in the browser profile instead:

```bash
dsh --profile web
```

and install with `--profile web`.

### Update

```bash
git pull
```

Then restart DeepSeek Harness. There is nothing to compile.

### Uninstall

```powershell
& $cli plugin --profile desktop remove dsh-code-git-workbench
```

Restart the application afterwards.

## Use

1. Open a session. The pages start from the session's workspace; Code can switch
   to any Harness workspace, Git to any workspace that is a Git repository.
2. Open the right Sidebar (`Ctrl+Alt+B` on the desktop build, or the sidebar
   button).
3. Click `+` → **Code** or **Git**. The guide also lists both pages.
4. For more room, use the panel's fullscreen control.

### Code

- Lazy directory tree; `.git` is hidden.
- The workspace selector in the tree header lists every Harness workspace. When
  the session directory is not a repository, Code starts in the first workspace
  that is one. The choice is remembered per session.
- Tabs keep their own document, cursor, scroll position and dirty state.
- `Ctrl+S` saves; `Ctrl+R` reloads the active file. The toolbar has the same
  actions.
- CodeMirror offers line numbers, bracket matching, auto-close, incremental
  search (`Ctrl+F`) and modes for JS/TS, Python, JSON, Markdown, HTML/CSS, YAML,
  SQL, shell, PowerShell and C-like languages.
- Closing a tab with unsaved changes asks for confirmation.
- Files are read and written as UTF-8. Files larger than 2 MB and binary files
  are rejected for display.

### Git

- Repository selector for every workspace that is a Git repository.
- Branch tree with local/remote groups, filter, current branch, ahead/behind,
  checkout, checkout + rebase, merge, rebase, compare, push, rename, delete and
  tag actions.
- Branches can be starred from the row or from the context menu. Favorites float
  to the top of their own group (Local or Remote); the choice is stored per Git
  repository in the browser profile and survives tab/page reloads.
- Commit log for the selected branch (or all branches) with the colored graph,
  ref badges, author and date; filter and “load more”.
- Commit details with the full message, parents, files and `+/-`, plus checkout,
  branch, cherry-pick, merge, rebase, reset (soft/mixed/hard), revert and tag.
- File rows open a built-in diff overlay. “Compare with working tree” is in the
  file context menu.
- Fetch all, pull and push. Push falls back to `--set-upstream origin` when a
  branch has no upstream.
- Remote branches collapse automatically when there are more than 40 of them.

### Subagent order

The header's descendant-count button opens the subagent catalog. Running rows
are moved above idle rows after every render, per tree level. The sort is a DOM
enhancement because the shipped catalog has no slot for ordering; host state is
not modified.

## Architecture

```
index.mjs         host half: /code-git static UI + JSON API
client.js         client half: Sidebar tab types + subagent catalog sort
web/code/         vanilla JS + CodeMirror 5 (vendored)
web/git/          PyCharm-style Git UI
cordis.patch.yml  inserts the bundle row into the profile
```

The host API applies `ctx.connection.requestRejection(req)` to every request, so
it inherits the Harness Host/Origin fence and browser authentication. All routes
are same-origin:

- the desktop shell forwards `dsh-app://app/code-git/...` to the local host with
  the host cookie;
- a browser talks to the same listener directly.

API surface:

| Route | Purpose |
| --- | --- |
| `GET /code-git/api/context` | session cwd, selected root, workspaces, repo status |
| `GET /code-git/api/tree` | one directory level |
| `GET/PUT /code-git/api/file` | read/write one file |
| `GET /code-git/api/git/state` | branches, commits, refs, ahead/behind |
| `GET /code-git/api/git/commit` | commit message, parents, file stats |
| `GET /code-git/api/git/diff` | old/new file contents |
| `POST /code-git/api/git/action` | checkout, merge, rebase, reset, fetch, push, … |

Every request is checked against the session's registered workspaces; paths are
resolved and confined to the selected root. Git runs through `execFile` without
a shell, with `GIT_TERMINAL_PROMPT=0`.

The Git UI is the same HTML/CSS/JS as the companion VS Code extension's panel.
`web/git/bridge.js` implements the small `acquireVsCodeApi()` surface the UI was
written against and maps its messages to the JSON API. No VS Code runtime is
involved.

## Development

There is no build step:

- host: edit `index.mjs`, restart the host;
- client: edit `client.js`, restart the host (or use a web profile with live
  patch reload);
- Code UI: edit `web/code/`;
- Git UI: edit `web/git/`.

For a disposable test instance:

```powershell
$cli = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $cli --profile web --port 3080 --no-open
```

Open the printed token URL and use the normal UI.

Test checklist before a release:

- the Web UI boots without a plugin-load error;
- `+` lists Code and Git;
- the tree opens, a file opens, edit + save writes to disk;
- workspace switching updates tree/footer;
- Git shows branches and commits, details and diff;
- remote branches collapse when there are more than 40;
- subagent catalog still opens and running rows sort first.

Do not test destructive Git operations on a real working tree; use a throwaway
repository.

See [AGENTS.md](AGENTS.md) for the agent-oriented guide.

## Limits

- No LSP, quick-open or file watchers; use the toolbar refresh.
- Custom keyboard shortcuts are not used: the DSH Web shortcut adapter accepts
  only its built-in catalog (`Unsupported Web shortcut` otherwise), so the pages
  are opened from the `+` guide.
- Edits are saved as-is; no format-on-save and no external-change merge.
- Only workspaces registered in Harness can be selected; arbitrary directories
  are rejected by the host.
- Reset/delete/push happen after their confirmation prompts; there is no undo
  inside the panel.
- Subagent sorting is a DOM enhancement, not a host catalog change.

## Third-party code

- CodeMirror 5 — MIT, Marijn Haverbeke and contributors.
- VS Code Codicons — MIT, Microsoft.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT. See [LICENSE](LICENSE).
