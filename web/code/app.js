(function () {
  "use strict";

  const session = new URLSearchParams(location.search).get("session") || "";
  const $ = (id) => document.getElementById(id);
  const app = $("app");

  const ROOT_KEY = "code-git.root." + session;

  const state = {
    context: null,
    root: null,
    workspaces: [],
    tabs: new Map(),
    active: null,
    tree: new Map(),
    expanded: new Set(),
    filter: "",
    treeWidth: Number(localStorage.getItem("code-git.tree-width")) || 240,
  };

  let cm = null;
  let suppress = false;
  let filterTimer = null;

  const MODE_BY_LANGUAGE = {
    javascript: "javascript",
    typescript: "text/typescript",
    python: "python",
    json: { name: "javascript", json: true },
    markdown: "gfm",
    html: "htmlmixed",
    css: "css",
    scss: "css",
    less: "css",
    yaml: "yaml",
    toml: "text/plain",
    ini: "text/plain",
    xml: "xml",
    sql: "sql",
    shell: "shell",
    powershell: "powershell",
    batch: "text/plain",
    c: "text/x-csrc",
    cpp: "text/x-c++src",
    csharp: "text/x-csharp",
    java: "text/x-java",
    kotlin: "text/x-java",
    go: "text/x-c++src",
    rust: "text/x-c++src",
    ruby: "text/x-c++src",
    php: "text/x-c++src",
    swift: "text/x-c++src",
    dockerfile: "text/plain",
  };

  function toast(kind, text) {
    const node = document.createElement("div");
    node.className = "toast " + (kind || "");
    node.textContent = text;
    $("toasts").appendChild(node);
    while ($("toasts").children.length > 3) $("toasts").firstChild.remove();
    setTimeout(() => {
      node.style.opacity = "0";
      node.style.transition = "opacity .2s";
      setTimeout(() => node.remove(), 220);
    }, 4200);
  }

  function api(path, options, root) {
    const separator = path.includes("?") ? "&" : "?";
    let url = path + separator + "session=" + encodeURIComponent(session);
    const requestedRoot = root === undefined ? state.root : root;
    if (requestedRoot) url += "&root=" + encodeURIComponent(requestedRoot);
    return fetch(url, options).then(async (response) => {
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
    });
  }

  function basename(path) {
    return String(path || "").split(/[\\/]/).filter(Boolean).pop() || path || "";
  }

  function modeFor(language) {
    if (MODE_BY_LANGUAGE[language]) return MODE_BY_LANGUAGE[language];
    return "text/plain";
  }

  function renderRootSelect() {
    const select = $("root-select");
    select.replaceChildren();
    for (const workspace of state.workspaces) {
      const option = document.createElement("option");
      option.value = workspace.path;
      option.textContent = workspace.name;
      option.title = workspace.path;
      select.appendChild(option);
    }
    if (state.root) select.value = state.root;
    select.title = state.root || "Project workspace";
  }

  async function loadContext(root) {
    const data = await api("/code-git/api/context", undefined, root || "");
    state.context = data;
    state.root = data.root;
    state.workspaces = data.workspaces || [];
    if (state.root) localStorage.setItem(ROOT_KEY, state.root);
    renderRootSelect();
    return data;
  }

  function resetEditor() {
    state.tabs.clear();
    state.active = null;
    state.tree.clear();
    state.expanded.clear();
    state.filter = "";
    $("tree-search").value = "";
    suppress = true;
    cm.swapDoc(CodeMirror.Doc("", "text/plain"));
    cm.setOption("lineWrapping", false);
    suppress = false;
    showEmpty(true);
    renderTabs();
    renderCrumbs();
    updateStatus();
    updateSaveButton();
  }

  async function switchRoot(root) {
    if (!root || root === state.root) return;
    const dirty = [...state.tabs.values()].filter((tab) => tab.dirty).length;
    if (dirty) {
      const ok = await ask(
        "Switch workspace?",
        "Unsaved changes in " + dirty + " tab(s) will be discarded.",
        "Switch",
        true,
      );
      if (!ok) {
        $("root-select").value = state.root;
        return;
      }
    }
    try {
      await loadContext(root);
      resetEditor();
      await loadRoot();
      toast("ok", "Workspace: " + basename(state.root));
    } catch (error) {
      $("root-select").value = state.root;
      toast("error", String(error.message || error));
    }
  }

  function ask(title, text, confirmLabel, danger) {
    return new Promise((resolve) => {
      const layer = $("modal-layer");
      $("modal-title").textContent = title;
      $("modal-text").textContent = text || "";
      const actions = $("modal-actions");
      actions.replaceChildren();
      const cancel = document.createElement("button");
      cancel.className = "btn";
      cancel.textContent = "Cancel";
      cancel.onclick = () => finish(false);
      const confirm = document.createElement("button");
      confirm.className = "btn primary";
      if (danger) confirm.style.color = "#f85149";
      confirm.textContent = confirmLabel || "OK";
      confirm.onclick = () => finish(true);
      actions.append(cancel, confirm);
      layer.hidden = false;
      confirm.focus();
      const onKey = (event) => {
        if (event.key === "Escape") finish(false);
        if (event.key === "Enter") finish(true);
      };
      document.addEventListener("keydown", onKey);
      function finish(value) {
        document.removeEventListener("keydown", onKey);
        layer.hidden = true;
        resolve(value);
      }
    });
  }

  function applyTreeWidth() {
    document.documentElement.style.setProperty("--tree-w", state.treeWidth + "px");
    localStorage.setItem("code-git.tree-width", String(state.treeWidth));
  }

  function adoptTheme() {
    let parentBody;
    let parentRoot;
    try {
      parentBody = window.parent.document.body;
      parentRoot = window.parent.document.documentElement;
      if (!parentBody) return;
    } catch {
      return;
    }
    const styles = getComputedStyle(parentBody);
    const read = (names) => {
      for (const name of names) {
        const value = styles.getPropertyValue(name).trim();
        if (value) return value;
      }
      const rootStyles = getComputedStyle(parentRoot);
      for (const name of names) {
        const value = rootStyles.getPropertyValue(name).trim();
        if (value) return value;
      }
      return "";
    };
    const dark =
      parentBody.hasAttribute("data-ds-dark-theme") ||
      (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";

    const background = read(["--dsw-alias-bg-base"]) || styles.backgroundColor || "";
    const elevated = read(["--dsw-alias-bg-layer-1", "--dsw-alias-bg-layer-2"]) || background;
    const foreground = read(["--dsw-alias-label-primary"]) || styles.color || "";
    const muted = read(["--dsw-alias-label-tertiary", "--dsw-alias-label-secondary"]) || "";
    const border = read(["--dsw-alias-border-l1", "--dsw-alias-separator-primary"]) || "";
    const accent = read(["--dsw-alias-accent-primary", "--dsw-brand-primary", "--dsw-alias-label-link"]) || "";
    const mono = read(["--dsw-font-family-mono", "--dsh-code-font-family"]) || "";

    const set = (name, value) => {
      if (value) document.documentElement.style.setProperty(name, value);
    };
    set("--bg", background);
    set("--elev", elevated);
    set("--fg", foreground);
    set("--muted", muted);
    set("--border", border);
    set("--accent", accent);
    set("--mono", mono);
    if (!dark && !background) {
      document.documentElement.style.setProperty("--bg", "#ffffff");
      document.documentElement.style.setProperty("--elev", "#f6f6f7");
      document.documentElement.style.setProperty("--fg", "#24292f");
    }
  }

  function initEditor() {
    const editor = $("editor");
    cm = CodeMirror(editor, {
      value: "",
      mode: "text/plain",
      theme: "dsh",
      lineNumbers: true,
      lineWrapping: false,
      indentUnit: 2,
      tabSize: 2,
      indentWithTabs: false,
      matchBrackets: true,
      autoCloseBrackets: true,
      styleActiveLine: true,
      extraKeys: {
        "Ctrl-S": save,
        "Cmd-S": save,
        "Ctrl-F": "findPersistent",
        "Cmd-F": "findPersistent",
      },
    });

    cm.on("change", () => {
      if (suppress || !state.active) return;
      const tab = state.tabs.get(state.active);
      if (!tab || tab.dirty) {
        updateStatus();
        return;
      }
      tab.dirty = true;
      renderTabs();
      updateStatus();
      updateSaveButton();
    });

    cm.on("cursorActivity", updateStatus);
    cm.on("scroll", () => {
      if (!state.active) return;
      const tab = state.tabs.get(state.active);
      if (tab) {
        const info = cm.getScrollInfo();
        tab.scroll = { left: info.left, top: info.top };
      }
    });
  }

  function updateSaveButton() {
    const tab = state.active ? state.tabs.get(state.active) : null;
    $("save").disabled = !tab || !tab.dirty;
    $("reload").disabled = !tab;
  }

  function renderCrumbs() {
    const crumbs = $("crumbs");
    crumbs.replaceChildren();
    if (!state.active) {
      const span = document.createElement("span");
      span.className = "muted";
      span.textContent = "No file selected";
      crumbs.appendChild(span);
      return;
    }
    const root = state.root ? basename(state.root) : state.context ? basename(state.context.cwd) : "";
    const parts = [root, ...state.active.split("/")];
    parts.forEach((part, index) => {
      if (index > 0) {
        const sep = document.createElement("span");
        sep.className = "muted";
        sep.textContent = "/";
        crumbs.appendChild(sep);
      }
      const span = document.createElement("span");
      span.textContent = part;
      if (index === parts.length - 1) span.className = "file";
      crumbs.appendChild(span);
    });
  }

  function renderTabs() {
    const container = $("tabs");
    container.replaceChildren();
    for (const [path, tab] of state.tabs) {
      const element = document.createElement("div");
      element.className = "tab" + (path === state.active ? " active" : "");
      element.setAttribute("role", "tab");
      element.title = path;
      const name = document.createElement("span");
      name.className = "tab-name";
      name.textContent = basename(path);
      element.appendChild(name);
      if (tab.dirty) {
        const dot = document.createElement("span");
        dot.className = "dirty";
        element.appendChild(dot);
      }
      const close = document.createElement("span");
      close.className = "close";
      close.textContent = "×";
      close.title = "Close";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        closeTab(path);
      });
      element.appendChild(close);
      element.addEventListener("click", () => activate(path));
      container.appendChild(element);
      tab.el = element;
    }
  }

  function updateStatus() {
    const status = $("status");
    status.replaceChildren();
    const tab = state.active ? state.tabs.get(state.active) : null;
    if (!tab) {
      status.textContent = "Ready";
      return;
    }
    const cursor = cm.getCursor();
    const add = (text, className) => {
      const span = document.createElement("span");
      span.textContent = text;
      if (className) span.className = className;
      status.appendChild(span);
    };
    add(tab.path);
    add("Ln " + (cursor.line + 1) + ", Col " + (cursor.ch + 1));
    add(tab.language || "text");
    add("UTF-8");
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    status.appendChild(spacer);
    if (tab.dirty) add("● Unsaved", "dirty-label");
  }

  function showEmpty(show) {
    $("empty").classList.toggle("hidden", !show);
  }

  function activate(path) {
    const tab = state.tabs.get(path);
    if (!tab) return;
    if (state.active === path) {
      cm.focus();
      return;
    }
    const previous = state.active ? state.tabs.get(state.active) : null;
    if (previous) {
      previous.cursor = cm.getCursor();
      previous.scroll = cm.getScrollInfo();
    }
    state.active = path;
    suppress = true;
    cm.swapDoc(tab.doc);
    cm.setOption("mode", tab.mode);
    cm.setOption("lineWrapping", tab.language === "markdown" || tab.language === "text");
    suppress = false;
    if (tab.cursor) cm.setCursor(tab.cursor);
    if (tab.scroll) cm.scrollTo(tab.scroll.left, tab.scroll.top);
    cm.focus();
    showEmpty(false);
    renderTabs();
    renderCrumbs();
    updateStatus();
    updateSaveButton();
    renderTreeActive();
  }

  async function openFile(path) {
    if (state.tabs.has(path)) {
      activate(path);
      return;
    }
    try {
      const data = await api("/code-git/api/file?path=" + encodeURIComponent(path));
      if (data.binary) {
        toast("error", "Binary file: " + path);
        return;
      }
      const mode = modeFor(data.language);
      const doc = CodeMirror.Doc(data.text, mode);
      state.tabs.set(path, {
        path,
        doc,
        mode,
        language: data.language,
        dirty: false,
        cursor: { line: 0, ch: 0 },
        scroll: { left: 0, top: 0 },
      });
      activate(path);
      if (document.body.clientWidth < 620) app.classList.add("tree-hidden");
    } catch (error) {
      toast("error", String(error.message || error));
    }
  }

  async function save() {
    const tab = state.active ? state.tabs.get(state.active) : null;
    if (!tab || !tab.dirty) return;
    try {
      await api("/code-git/api/file?path=" + encodeURIComponent(tab.path), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: cm.getValue() }),
      });
      tab.dirty = false;
      renderTabs();
      updateStatus();
      updateSaveButton();
      toast("ok", "Saved " + basename(tab.path));
    } catch (error) {
      toast("error", String(error.message || error));
    }
  }

  async function reloadActive() {
    const tab = state.active ? state.tabs.get(state.active) : null;
    if (!tab) return;
    if (tab.dirty) {
      const ok = await ask("Discard changes?", "The file has unsaved changes. Reload from disk anyway?", "Reload", true);
      if (!ok) return;
    }
    try {
      const data = await api("/code-git/api/file?path=" + encodeURIComponent(tab.path));
      if (data.binary) {
        toast("error", "Binary file cannot be shown");
        return;
      }
      const cursor = cm.getCursor();
      suppress = true;
      tab.doc.setValue(data.text);
      suppress = false;
      tab.dirty = false;
      tab.mode = modeFor(data.language);
      tab.language = data.language;
      cm.setOption("mode", tab.mode);
      cm.setOption("lineWrapping", tab.language === "markdown" || tab.language === "text");
      cm.setCursor(cursor);
      renderTabs();
      updateStatus();
      updateSaveButton();
      toast("ok", "Reloaded " + basename(tab.path));
    } catch (error) {
      toast("error", String(error.message || error));
    }
  }

  async function closeTab(path) {
    const tab = state.tabs.get(path);
    if (!tab) return;
    if (tab.dirty) {
      const ok = await ask("Discard changes?", "Close " + basename(path) + " and lose its unsaved changes?", "Discard", true);
      if (!ok) return;
    }
    state.tabs.delete(path);
    if (state.active === path) {
      const next = [...state.tabs.keys()].pop();
      if (next) {
        state.active = null;
        const nextTab = state.tabs.get(next);
        state.active = next;
        suppress = true;
        cm.swapDoc(nextTab.doc);
        cm.setOption("mode", nextTab.mode);
        suppress = false;
        cm.focus();
        renderTabs();
        renderCrumbs();
        updateStatus();
        updateSaveButton();
      } else {
        state.active = null;
        suppress = true;
        cm.swapDoc(CodeMirror.Doc("", "text/plain"));
        suppress = false;
        showEmpty(true);
        renderTabs();
        renderCrumbs();
        updateStatus();
        updateSaveButton();
      }
    } else {
      renderTabs();
    }
  }

  function entryPath(parent, name) {
    return parent ? parent + "/" + name : name;
  }

  function matchesFilter(path, name, depth) {
    if (!state.filter) return true;
    if (name.toLowerCase().includes(state.filter)) return true;
    const entries = state.tree.get(path);
    if (!entries) return false;
    if (depth > 4) return false;
    return entries.some((entry) => {
      if (entry.type !== "directory") return entry.name.toLowerCase().includes(state.filter);
      return matchesFilter(entryPath(path, entry.name), entry.name, depth + 1);
    });
  }

  function renderTree() {
    const container = $("tree");
    container.replaceChildren();
    const root = "";
    const entries = state.tree.get(root);
    if (!entries) {
      const loading = document.createElement("div");
      loading.className = "tree-empty";
      loading.textContent = "Loading files…";
      container.appendChild(loading);
      return;
    }
    if (entries.error) {
      const error = document.createElement("div");
      error.className = "tree-error";
      error.textContent = entries.error;
      container.appendChild(error);
      return;
    }
    renderLevel(container, root, 0);
    if (!container.children.length) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = state.filter ? "No files match the filter." : "This directory is empty.";
      container.appendChild(empty);
    }
    const count = [...state.tree.values()].filter(Array.isArray).reduce((sum, list) => sum + list.length, 0);
    $("tree-foot").textContent = count + " entries loaded · " + (state.root || "");
  }

  function renderLevel(container, parent, depth) {
    const entries = state.tree.get(parent);
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const path = entryPath(parent, entry.name);
      if (!matchesFilter(path, entry.name.toLowerCase(), depth)) continue;
      const isDir = entry.type === "directory";
      const row = document.createElement("div");
      row.className = "tree-row" + (isDir ? " dir" : "") + (entry.type === "other" ? " dim" : "");
      if (state.active === path) row.classList.add("active");
      row.style.paddingLeft = 6 + depth * 12 + "px";
      row.dataset.path = path;
      row.title = path;
      row.setAttribute("role", "treeitem");

      const chev = document.createElement("span");
      chev.className = "chev" + (state.expanded.has(path) ? " open" : "");
      chev.textContent = isDir ? "▶" : "";
      row.appendChild(chev);

      const glyph = document.createElement("span");
      glyph.className = "glyph";
      glyph.textContent = isDir ? "▤" : "·";
      row.appendChild(glyph);

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = entry.name;
      row.appendChild(name);

      if (entry.type === "other") {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "link";
        row.appendChild(badge);
      }

      row.addEventListener("click", (event) => {
        event.stopPropagation();
        if (isDir) {
          toggleDir(path);
        } else if (entry.type === "file") {
          openFile(path);
        }
      });
      container.appendChild(row);

      if (isDir && state.expanded.has(path)) {
        renderLevel(container, path, depth + 1);
      }
    }
  }

  function renderTreeActive() {
    for (const row of $("tree").querySelectorAll(".tree-row.active")) row.classList.remove("active");
    if (!state.active) return;
    const row = $("tree").querySelector('.tree-row[data-path="' + CSS.escape(state.active) + '"]');
    if (row) row.classList.add("active");
  }

  async function toggleDir(path) {
    if (state.expanded.has(path)) {
      state.expanded.delete(path);
      renderTree();
      return;
    }
    state.expanded.add(path);
    if (!state.tree.has(path)) {
      $("tree-foot").textContent = "Loading " + path + "…";
      try {
        const data = await api("/code-git/api/tree?path=" + encodeURIComponent(path));
        state.tree.set(path, data.entries);
      } catch (error) {
        state.tree.set(path, { error: String(error.message || error) });
      }
    }
    renderTree();
  }

  async function loadRoot() {
    const requestedRoot = state.root;
    try {
      const data = await api("/code-git/api/tree?path=", undefined, requestedRoot || "");
      if (requestedRoot !== state.root) return;
      state.tree.set("", data.entries);
      $("tree-foot").textContent = data.entries.length + " entries · " + (requestedRoot || "");
      renderTree();
    } catch (error) {
      if (requestedRoot !== state.root) return;
      state.tree.set("", { error: String(error.message || error) });
      renderTree();
    }
  }

  async function refreshTree() {
    const expanded = new Set(state.expanded);
    state.tree.clear();
    state.expanded = expanded;
    await loadRoot();
  }

  function setupSplitter() {
    const splitter = $("splitter");
    splitter.addEventListener("mousedown", (event) => {
      event.preventDefault();
      document.body.classList.add("resizing");
      const startX = event.clientX;
      const startWidth = state.treeWidth;
      const move = (moveEvent) => {
        const width = Math.max(160, Math.min(520, startWidth + moveEvent.clientX - startX));
        state.treeWidth = width;
        applyTreeWidth();
        cm.refresh();
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.classList.remove("resizing");
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  function bindToolbar() {
    $("save").addEventListener("click", save);
    $("reload").addEventListener("click", reloadActive);
    $("toggle-tree").addEventListener("click", () => {
      app.classList.toggle("tree-hidden");
      cm.refresh();
    });
    $("refresh-tree").addEventListener("click", refreshTree);
    $("root-select").addEventListener("change", (event) => {
      switchRoot(String(event.target.value || ""));
    });
    $("tree-search").addEventListener("input", (event) => {
      state.filter = String(event.target.value || "").trim().toLowerCase();
      clearTimeout(filterTimer);
      filterTimer = setTimeout(renderTree, 100);
    });
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") {
        event.preventDefault();
        reloadActive();
      }
    });
  }

  async function init() {
    applyTreeWidth();
    adoptTheme();
    initEditor();
    bindToolbar();
    setupSplitter();
    showEmpty(true);
    renderCrumbs();
    updateStatus();
    updateSaveButton();

    try {
      const parentBody = window.parent.document.body;
      const observer = new MutationObserver(() => adoptTheme());
      observer.observe(parentBody, { attributes: true, attributeFilter: ["data-ds-dark-theme", "class", "style"] });
      observer.observe(window.parent.document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "class", "style"],
      });
    } catch {
      // The parent may be cross-origin in a standalone browser tab.
    }

    try {
      const stored = localStorage.getItem(ROOT_KEY) || "";
      let context;
      try {
        context = await loadContext(stored);
      } catch (error) {
        if (!stored) throw error;
        context = await loadContext("");
      }
      if (!stored && context && !context.repoRoot) {
        const repo = (context.workspaces || []).find((workspace) => workspace.isRepo);
        if (repo) context = await loadContext(repo.path);
      }
      await loadRoot();
    } catch (error) {
      toast("error", String(error.message || error));
      state.tree.set("", { error: String(error.message || error) });
      renderTree();
    }

    if (window.innerWidth < 620) app.classList.add("tree-hidden");
    cm.focus();
  }

  init();
})();
