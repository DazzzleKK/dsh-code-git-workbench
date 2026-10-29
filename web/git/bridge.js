/*
 * Bridge between the reused PyCharm-style Git UI (`main.js`) and the DSH host
 * API. It implements the small `acquireVsCodeApi()` surface the UI was written
 * against: postMessage/getState/setState. Every message the UI would have sent
 * to the VS Code extension is translated into a same-origin fetch.
 */
(function () {
  "use strict";

  const SESSION = new URLSearchParams(location.search).get("session") || "";
  const STORAGE_KEY = "dsh-code-git.ui." + SESSION;

  const ROOT_KEY = "dsh-code-git.root." + SESSION;

  let currentRef = null;
  let currentLabel = null;
  let currentRoot = localStorage.getItem(ROOT_KEY) || null;
  let currentWorkspaces = [];
  let limit = 500;
  let lastBranches = [];
  let lastCommits = new Map();
  let busyDepth = 0;

  function emit(message) {
    window.postMessage(message, "*");
  }

  function basename(path) {
    return String(path || "").split(/[\\/]/).filter(Boolean).pop() || String(path || "");
  }

  function shortHash(hash) {
    return String(hash || "").slice(0, 7);
  }

  function errorText(error) {
    return error && error.message ? error.message : String(error);
  }

  async function api(path, options, root) {
    const separator = path.includes("?") ? "&" : "?";
    let url = path + separator + "session=" + encodeURIComponent(SESSION);
    const requestedRoot = root === undefined ? currentRoot : root;
    if (requestedRoot) url += "&root=" + encodeURIComponent(requestedRoot);
    const response = await fetch(url, options);
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const message = data && (data.message || data.error) ? data.message || data.error : response.statusText;
      throw new Error(message || "request failed");
    }
    return data;
  }

  function startBusy(label) {
    busyDepth++;
    emit({ type: "busy", value: true, label: label || "Working…" });
  }

  function stopBusy() {
    busyDepth = Math.max(0, busyDepth - 1);
    if (busyDepth === 0) emit({ type: "busy", value: false });
  }

  function notice(kind, text) {
    emit({ type: "notice", kind, text });
  }

  async function loadContext(root) {
    const data = await api("/code-git/api/context", undefined, root || "");
    currentRoot = data.root;
    currentWorkspaces = data.workspaces || [];
    if (currentRoot) localStorage.setItem(ROOT_KEY, currentRoot);
    else localStorage.removeItem(ROOT_KEY);
    return data;
  }

  async function loadState(ref, options) {
    if (ref !== undefined) currentRef = ref;
    if (options && options.label !== undefined) currentLabel = options.label;
    emit({ type: "refreshing", value: true });
    try {
      const query =
        "/code-git/api/git/state?ref=" +
        encodeURIComponent(currentRef || "") +
        "&limit=" +
        encodeURIComponent(String(limit));
      const data = await api(query);
      if (!data.isRepo) {
        emit({
          type: "emptystate",
          text: "This workspace is not inside a Git repository.",
        });
        return;
      }
      lastBranches = data.branches;
      lastCommits = new Map(data.commits.map((commit) => [commit.hash, commit]));
      const root = data.root || currentRoot || data.repoRoot;
      const repos = currentWorkspaces
        .filter((workspace) => workspace.isRepo !== false || workspace.path === root)
        .map((workspace) => ({
          root: workspace.path,
          name: workspace.name,
          current: workspace.path === root ? data.current : null,
        }));
      if (!repos.some((repo) => repo.root === root)) {
        repos.unshift({ root, name: basename(root), current: data.current });
      }
      const state = {
        repos,
        repo: root,
        repoRoot: data.repoRoot,
        ref: data.ref,
        label: currentLabel || data.label,
        refKind: data.ref === "ALL" ? "all" : "branch",
        branches: data.branches,
        commits: data.commits,
        limit: data.limit,
        hasMore: data.hasMore,
        current: data.current,
        detached: data.detached,
        headSha: data.headSha,
        ahead: data.ahead,
        behind: data.behind,
        empty: data.empty,
        showGraph: true,
        dateStyle: "absolute",
      };
      emit({ type: "state", state });
    } catch (error) {
      emit({ type: "emptystate", text: "Git: " + errorText(error) });
    } finally {
      emit({ type: "refreshing", value: false });
    }
  }

  async function sendDetails(hash) {
    try {
      const data = await api("/code-git/api/git/commit?hash=" + encodeURIComponent(hash));
      const commit = lastCommits.get(hash) || {};
      emit({
        type: "details",
        hash,
        body: data.body,
        files: data.files,
        parents: data.parents,
        parent: data.parents[0] || null,
        subject: commit.subject || "",
        author: commit.author || "",
        email: commit.email || "",
        authorTime: commit.authorTime || 0,
        refs: commit.refs || [],
      });
    } catch (error) {
      notice("error", errorText(error));
    }
  }

  /* --------------------------------------------------------------- prompts */

  function openPrompt(options) {
    return new Promise((resolve) => {
      const layer = document.getElementById("prompt-layer");
      const title = document.getElementById("prompt-title");
      const text = document.getElementById("prompt-text");
      const input = document.getElementById("prompt-input");
      const actions = document.getElementById("prompt-actions");
      title.textContent = options.title || "";
      text.textContent = options.text || "";
      input.hidden = !options.input;
      input.value = options.value || "";
      actions.replaceChildren();

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        layer.hidden = true;
        document.removeEventListener("keydown", onKey, true);
        resolve(value);
      };
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        } else if (event.key === "Enter" && options.input) {
          finish(input.value.trim() || null);
        }
      };

      const buttons = options.buttons || [];
      for (const button of buttons) {
        const element = document.createElement("button");
        element.type = "button";
        element.className = "btn" + (button.primary ? " primary" : "") + (button.danger ? " danger" : "");
        element.textContent = button.label;
        element.addEventListener("click", () => {
          if (options.input && button.primary) {
            const value = input.value.trim();
            if (!value) {
              input.focus();
              return;
            }
            finish(value);
          } else {
            finish(button.value);
          }
        });
        actions.appendChild(element);
      }
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => finish(null));
      actions.appendChild(cancel);

      layer.hidden = false;
      document.addEventListener("keydown", onKey, true);
      if (options.input) {
        input.focus();
        input.select();
      }
    });
  }

  function askText(title, text, value) {
    return openPrompt({
      title,
      text,
      input: true,
      value: value || "",
      buttons: [{ label: "OK", primary: true }],
    });
  }

  function askChoice(title, text, options) {
    return openPrompt({
      title,
      text,
      input: false,
      buttons: options.map((option) => ({
        label: option.label,
        value: option.value,
        primary: option.primary,
        danger: option.danger,
      })),
    });
  }

  function confirm(title, text, label, danger) {
    return openPrompt({
      title,
      text,
      input: false,
      buttons: [{ label: label || "OK", value: true, primary: !danger, danger }],
    });
  }

  /* ------------------------------------------------------------------ diff */

  function diffRows(oldText, newText) {
    const a = oldText.split("\n");
    const b = newText.split("\n");
    const maxCells = 4000000;
    if (a.length * b.length > maxCells) {
      const rows = [];
      a.forEach((line, index) => rows.push({ oldNo: index + 1, newNo: null, old: line, next: null, kind: "del" }));
      b.forEach((line, index) => rows.push({ oldNo: null, newNo: index + 1, old: null, next: line, kind: "add" }));
      return rows;
    }
    const width = b.length + 1;
    const dp = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        dp[i * width + j] =
          a[i] === b[j]
            ? dp[(i + 1) * width + j + 1] + 1
            : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
      }
    }
    const rows = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        rows.push({ oldNo: i + 1, newNo: j + 1, old: a[i], next: b[j], kind: "equal" });
        i++;
        j++;
      } else if (j < b.length && (i >= a.length || dp[i * width + j + 1] >= dp[(i + 1) * width + j])) {
        rows.push({ oldNo: null, newNo: j + 1, old: null, next: b[j], kind: "add" });
        j++;
      } else {
        rows.push({ oldNo: i + 1, newNo: null, old: a[i], next: null, kind: "del" });
        i++;
      }
    }
    return rows;
  }

  function renderDiff(data) {
    const layer = document.getElementById("diff-layer");
    const body = document.getElementById("diff-body");
    const title = document.getElementById("diff-title");
    const stats = document.getElementById("diff-stats");
    title.textContent =
      data.path + (data.oldPath && data.oldPath !== data.path ? "  ← " + data.oldPath : "");
    body.replaceChildren();

    if (data.binary) {
      const note = document.createElement("div");
      note.className = "diff-note";
      note.textContent = "Binary file — no textual diff.";
      body.appendChild(note);
      layer.hidden = false;
      return;
    }

    const rows = diffRows(data.old || "", data.new || "");
    let adds = 0;
    let dels = 0;
    let shown = 0;
    const maxRows = 5000;
    for (const row of rows) {
      if (row.kind === "add") adds++;
      if (row.kind === "del") dels++;
      if (shown >= maxRows) continue;
      shown++;
      const element = document.createElement("div");
      element.className = "diff-row " + row.kind;
      const oldNo = document.createElement("span");
      oldNo.className = "n";
      oldNo.textContent = row.oldNo || "";
      const newNo = document.createElement("span");
      newNo.className = "n";
      newNo.textContent = row.newNo || "";
      const text = document.createElement("span");
      text.className = "t";
      const prefix = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
      text.textContent = prefix + (row.kind === "add" ? row.next : row.old !== null ? row.old : row.next);
      element.append(oldNo, newNo, text);
      body.appendChild(element);
    }
    if (rows.length > maxRows) {
      const note = document.createElement("div");
      note.className = "diff-note";
      note.textContent = "Diff truncated at " + maxRows + " lines (" + rows.length + " total).";
      body.appendChild(note);
    }
    stats.textContent = "+" + adds + "  −" + dels;
    layer.hidden = false;
  }

  async function showDiff(message) {
    try {
      if (message.workingTree) {
        const base = await api(
          "/code-git/api/git/diff?hash=" +
            encodeURIComponent(message.hash) +
            "&parent=" +
            encodeURIComponent(message.parent || "") +
            "&path=" +
            encodeURIComponent(message.path) +
            "&oldPath=" +
            encodeURIComponent(message.oldPath || message.path) +
            "&status=" +
            encodeURIComponent(message.status || "M"),
        );
        const working = await api("/code-git/api/file?path=" + encodeURIComponent(message.path));
        renderDiff({
          path: message.path,
          oldPath: message.oldPath || message.path,
          old: base.new || "",
          new: working.text || "",
          binary: base.binary || working.binary,
        });
        return;
      }
      const data = await api(
        "/code-git/api/git/diff?hash=" +
          encodeURIComponent(message.hash) +
          "&parent=" +
          encodeURIComponent(message.parent || "") +
          "&path=" +
          encodeURIComponent(message.path) +
          "&oldPath=" +
          encodeURIComponent(message.oldPath || message.path) +
          "&status=" +
          encodeURIComponent(message.status || "M"),
      );
      renderDiff(data);
    } catch (error) {
      notice("error", errorText(error));
    }
  }

  /* ---------------------------------------------------------------- actions */

  async function perform(payload, successText, options) {
    startBusy(options && options.label ? options.label : "Running git…");
    try {
      const data = await api("/code-git/api/git/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.assign({}, payload, { session: SESSION })),
      });
      notice("success", data.message || successText || "Done");
      if (options && options.refAfter !== undefined) {
        currentRef = options.refAfter;
        currentLabel = null;
      }
      await loadState();
      return true;
    } catch (error) {
      notice("error", errorText(error));
      return false;
    } finally {
      stopBusy();
    }
  }

  async function deleteBranch(ref) {
    if (!(await confirm("Delete branch?", "Delete branch '" + ref + "'?", "Delete", true))) return;
    startBusy("Deleting branch…");
    try {
      try {
        await api("/code-git/api/git/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "deleteBranch", ref, session: SESSION }),
        });
      } catch (error) {
        if (!/not fully merged/i.test(errorText(error))) throw error;
        const force = await confirm(
          "Branch is not fully merged",
          "Delete '" + ref + "' anyway? Commits that are not merged elsewhere will be lost.",
          "Force delete",
          true,
        );
        if (!force) return;
        await api("/code-git/api/git/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "deleteBranch", ref, force: true, session: SESSION }),
        });
      }
      notice("success", "Deleted branch " + ref);
      currentRef = null;
      currentLabel = null;
      await loadState();
    } catch (error) {
      notice("error", errorText(error));
    } finally {
      stopBusy();
    }
  }

  async function runAction(message) {
    const action = message.action;
    switch (action) {
      case "refresh":
        await loadState();
        return;
      case "fetch":
        await perform({ action: "fetch" }, "Fetched all remotes", { label: "Fetching…" });
        return;
      case "pull":
        await perform({ action: "pull" }, "Pulled", { label: "Pulling…" });
        return;
      case "push":
        await perform({ action: "push", ref: message.ref || "" }, "Pushed", { label: "Pushing…" });
        return;
      case "checkoutBranch":
        await perform(
          { action: "checkoutBranch", ref: message.ref, remote: !!message.remote },
          "Checked out " + message.ref,
          { label: "Checking out…", refAfter: null },
        );
        return;
      case "checkoutAndRebase": {
        const base = document.getElementById("current-branch-label").textContent.trim();
        startBusy("Checking out and rebasing…");
        try {
          await api("/code-git/api/git/action", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "checkoutBranch", ref: message.ref, session: SESSION }),
          });
          if (base && base !== "—" && base !== "HEAD detached") {
            await api("/code-git/api/git/action", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "rebase", ref: base, session: SESSION }),
            });
          }
          notice("success", "Checked out and rebased");
          currentRef = null;
          await loadState();
        } catch (error) {
          notice("error", errorText(error));
        } finally {
          stopBusy();
        }
        return;
      }
      case "checkoutRevision":
        await perform(
          { action: "checkoutRevision", hash: message.hash },
          "Checked out " + shortHash(message.hash),
          { label: "Checking out…", refAfter: null },
        );
        return;
      case "newBranch": {
        const from = message.ref || "";
        const name = await askText(
          "New branch",
          from ? "Create a branch from " + shortHash(from) + "." : "Create a branch from HEAD.",
          "",
        );
        if (!name) return;
        const payload = { action: "newBranch", name };
        if (/^[0-9a-f]{7,40}$/i.test(from)) payload.hash = from;
        else if (from) payload.ref = from;
        await perform(payload, "Created branch " + name, { label: "Creating branch…", refAfter: name });
        return;
      }
      case "merge":
        await perform(
          { action: "merge", ref: message.ref || "", hash: message.hash || "" },
          "Merged",
          { label: "Merging…" },
        );
        return;
      case "mergeCommit":
        await perform({ action: "merge", hash: message.hash }, "Merged commit", { label: "Merging…" });
        return;
      case "rebase":
        await perform({ action: "rebase", ref: message.ref || "" }, "Rebased", { label: "Rebasing…" });
        return;
      case "rebaseOntoCommit":
        await perform({ action: "rebase", hash: message.hash }, "Rebased", { label: "Rebasing…" });
        return;
      case "cherryPick":
        await perform({ action: "cherryPick", hash: message.hash }, "Cherry-picked", {
          label: "Cherry-picking…",
        });
        return;
      case "revert":
        await perform({ action: "revert", hash: message.hash }, "Reverted", { label: "Reverting…" });
        return;
      case "reset": {
        const mode = await askChoice(
          "Reset current branch",
          "Move the current branch to " + shortHash(message.hash) + ".",
          [
            { label: "Soft", value: "soft" },
            { label: "Mixed", value: "mixed" },
            { label: "Hard", value: "hard", danger: true },
          ],
        );
        if (!mode) return;
        if (mode === "hard") {
          const ok = await confirm(
            "Hard reset?",
            "All uncommitted changes will be lost. Continue?",
            "Reset --hard",
            true,
          );
          if (!ok) return;
        }
        await perform({ action: "reset", hash: message.hash, mode }, "Reset to " + shortHash(message.hash), {
          label: "Resetting…",
        });
        return;
      }
      case "createTag": {
        const name = await askText("Create tag", "Tag " + shortHash(message.hash) + ".", "");
        if (!name) return;
        await perform({ action: "createTag", name, hash: message.hash }, "Created tag " + name, {
          label: "Creating tag…",
        });
        return;
      }
      case "createTagFromBranch": {
        const branch = lastBranches.find((item) => item.name === message.ref);
        if (!branch) {
          notice("error", "Branch not found: " + message.ref);
          return;
        }
        const name = await askText("Create tag", "Tag " + message.ref + ".", "");
        if (!name) return;
        await perform({ action: "createTag", name, hash: branch.sha }, "Created tag " + name, {
          label: "Creating tag…",
        });
        return;
      }
      case "deleteBranch":
        await deleteBranch(message.ref);
        return;
      case "renameBranch": {
        const name = await askText("Rename branch", "Rename '" + message.ref + "' to:", message.ref);
        if (!name || name === message.ref) return;
        await perform({ action: "renameBranch", ref: message.ref, name }, "Renamed branch", {
          label: "Renaming…",
          refAfter: name,
        });
        return;
      }
      case "compare": {
        const current = document.getElementById("current-branch-label").textContent;
        if (!current || current === "—" || current === "HEAD detached") {
          notice("error", "Checkout a branch to compare against.");
          return;
        }
        currentRef = current + ".." + message.ref;
        currentLabel = message.ref + " ↔ " + current;
        await loadState();
        return;
      }
      default:
        return;
    }
  }

  async function copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(String(text));
    } catch {
      const area = document.createElement("textarea");
      area.value = String(text);
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
  }

  async function handle(message) {
    switch (message.type) {
      case "ready": {
        let context;
        try {
          context = await loadContext(currentRoot || "");
        } catch {
          context = await loadContext("");
        }
        if (!context.repoRoot) {
          const repo = currentWorkspaces.find((workspace) => workspace.isRepo);
          if (repo) {
            currentRoot = repo.path;
            localStorage.setItem(ROOT_KEY, currentRoot);
          }
        }
        await loadState();
        return;
      }
      case "refresh":
        await loadState();
        return;
      case "selectRef":
        currentRef = message.ref === "ALL" ? "ALL" : message.ref;
        currentLabel = null;
        await loadState();
        return;
      case "selectRepo":
        currentRoot = String(message.repo || "") || null;
        if (currentRoot) localStorage.setItem(ROOT_KEY, currentRoot);
        currentRef = null;
        currentLabel = null;
        limit = 500;
        await loadState();
        return;
      case "loadMore":
        limit += 500;
        await loadState();
        return;
      case "details":
        await sendDetails(message.hash);
        return;
      case "diff":
        await showDiff(message);
        return;
      case "action":
        await runAction(message);
        return;
      case "copy":
        await copyText(message.text);
        return;
      case "settings":
        await loadState();
        return;
      case "close":
        return;
      default:
        return;
    }
  }

  const bridge = {
    postMessage(message) {
      handle(message).catch((error) => notice("error", errorText(error)));
    },
    getState() {
      try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      } catch {
        return {};
      }
    },
    setState(value) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      } catch {
        // Storage can be unavailable in a sandboxed shell; layout just resets.
      }
    },
  };

  window.acquireVsCodeApi = function () {
    return bridge;
  };

  document.getElementById("diff-close").addEventListener("click", () => {
    document.getElementById("diff-layer").hidden = true;
  });
  document.getElementById("diff-layer").addEventListener("mousedown", (event) => {
    if (event.target === document.getElementById("diff-layer")) {
      document.getElementById("diff-layer").hidden = true;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const diff = document.getElementById("diff-layer");
    if (!diff.hidden) {
      diff.hidden = true;
      event.preventDefault();
    }
  });
})();
