// dsh-code-git — host half.
//
// Serves the workbench UI and a same-origin JSON API for project files and
// git. Every route goes through the composition's `connection` fence, so it is
// reachable only from the authenticated Web UI: the desktop shell forwards
// `dsh-app://app/...` requests to this listener with the host cookie, while a
// browser talks to the same origin directly.

import { execFile } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "web");
const BASE = "/code-git";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const execFileAsync = promisify(execFile);

export const name = "code-git";
export const inject = ["webServer", "connection", "sessions", "workspaceRegistry"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const LANGUAGE = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".swift": "swift",
  ".json": "json",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".ini": "ini",
  ".cfg": "ini",
  ".md": "markdown",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".xml": "xml",
  ".sql": "sql",
  ".sh": "shell",
  ".ps1": "powershell",
  ".bat": "batch",
  ".dockerfile": "dockerfile",
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error("request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error("request body is not valid JSON");
    error.status = 400;
    throw error;
  }
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function comparablePath(value) {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function listWorkspaces(ctx) {
  try {
    const entries = ctx.workspaceRegistry?.list?.() ?? [];
    return entries
      .filter((entry) => entry && typeof entry.path === "string" && isAbsolute(entry.path))
      .map((entry) => ({
        id: entry.id ?? entry.path,
        name: entry.title ?? entry.name ?? basename(entry.path),
        path: entry.path,
      }));
  } catch {
    return [];
  }
}

function safeResolve(root, requested) {
  const absolute = resolve(root, requested || ".");
  if (!inside(root, absolute)) {
    const error = new Error("path is outside the workspace");
    error.status = 403;
    throw error;
  }
  return absolute;
}

function languageFor(filePath) {
  return LANGUAGE[extname(filePath).toLowerCase()] ?? "text";
}

function isProbablyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(8000, buffer.length));
  return sample.includes(0);
}

async function git(cwd, args, options = {}) {
  const result = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout === 0 ? 0 : options.timeout ?? 120000,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      LC_ALL: "C",
      LANGUAGE: "en",
    },
  });
  return result.stdout;
}

async function gitBuffer(cwd, args, options = {}) {
  const result = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 120000,
    encoding: "buffer",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      LC_ALL: "C",
      LANGUAGE: "en",
    },
  });
  return result.stdout;
}

function parseTrack(track) {
  if (!track) return { ahead: 0, behind: 0, gone: false };
  if (track === "gone") return { ahead: 0, behind: 0, gone: true };
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: false,
  };
}

function parseBranches(out) {
  const branches = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ref, short, sha, head, upstream, track, date, subject] = line.split("\u0000");
    if (!ref || !ref.startsWith("refs/") || ref.endsWith("/HEAD")) continue;
    const isRemote = ref.startsWith("refs/remotes/");
    const name = short;
    const parsed = parseTrack(track ?? "");
    branches.push({
      ref,
      name,
      isRemote,
      remote: isRemote ? name.split("/")[0] : null,
      current: head === "*",
      sha,
      upstream: upstream || null,
      ahead: parsed.ahead,
      behind: parsed.behind,
      gone: parsed.gone,
      subject: subject ?? "",
      date: Number(date) || 0,
    });
  }
  branches.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return branches;
}

function parseLog(out) {
  const commits = [];
  for (const chunk of out.split("\u001e")) {
    const record = chunk.replace(/^[\r\n]+/, "");
    if (!record) continue;
    const fields = record.split("\u001f");
    if (fields.length < 8) continue;
    const [hash, short, parents, author, email, authorTime, commitTime, subject] = fields;
    commits.push({
      hash,
      short,
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      author,
      email,
      authorTime: Number(authorTime) || 0,
      commitTime: Number(commitTime) || 0,
      subject: subject ?? "",
      refs: [],
    });
  }
  return commits;
}

function parseNameStatusZ(out) {
  const parts = out.split("\u0000");
  const files = [];
  for (let index = 0; index < parts.length; index++) {
    const token = parts[index];
    if (!token) continue;
    const status = token[0];
    if (status === "R" || status === "C") {
      const oldPath = parts[++index];
      const newPath = parts[++index];
      if (newPath) files.push({ status, path: newPath, oldPath: oldPath || undefined });
    } else {
      const filePath = parts[++index];
      if (filePath) files.push({ status, path: filePath });
    }
  }
  return files;
}

function parseNumstatZ(out) {
  const result = new Map();
  const parts = out.split("\u0000");
  for (let index = 0; index < parts.length; index++) {
    const token = parts[index];
    if (!token) continue;
    const first = token.indexOf("\t");
    const second = token.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const addsRaw = token.slice(0, first);
    const delsRaw = token.slice(first + 1, second);
    let filePath = token.slice(second + 1);
    if (!filePath) {
      index++;
      filePath = parts[++index] ?? "";
    }
    if (!filePath) continue;
    const binary = addsRaw === "-" || delsRaw === "-";
    result.set(filePath, {
      adds: binary ? 0 : Number(addsRaw) || 0,
      dels: binary ? 0 : Number(delsRaw) || 0,
      binary,
    });
  }
  return result;
}

function parseStatusZ(out) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const parts = out.split("\u0000");
  for (let index = 0; index < parts.length; index++) {
    const token = parts[index];
    if (!token) continue;
    const x = token[0];
    const y = token[1];
    if (x === "!" && y === "!") continue;
    const filePath = token.slice(3);
    if (!filePath) continue;
    let oldPath;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      oldPath = parts[++index] || undefined;
    }
    if (x === "?" && y === "?") {
      untracked.push({ path: filePath, status: "?" });
      continue;
    }
    if (x === "U" || y === "U") {
      unstaged.push({ path: filePath, oldPath, status: "U" });
      continue;
    }
    if (x !== " " && x !== "?") staged.push({ path: filePath, oldPath, status: x });
    if (y !== " " && y !== "?") unstaged.push({ path: filePath, oldPath, status: y });
  }
  return {
    staged,
    unstaged,
    untracked,
    counts: {
      staged: staged.length,
      unstaged: unstaged.length,
      untracked: untracked.length,
      total: staged.length + unstaged.length + untracked.length,
    },
  };
}

function buildRefMap(branches, tags, headSha) {
  const map = new Map();
  const add = (sha, badge) => {
    if (!sha) return;
    const list = map.get(sha) ?? [];
    if (!list.some((item) => item.kind === badge.kind && item.name === badge.name)) {
      list.push(badge);
      map.set(sha, list);
    }
  };
  const current = branches.find((branch) => branch.current);
  if (current) add(current.sha, { kind: "local", name: current.name, current: true });
  for (const branch of branches) {
    if (!branch.current) {
      add(branch.sha, { kind: branch.isRemote ? "remote" : "local", name: branch.name });
    }
  }
  if (headSha) add(headSha, { kind: "head", name: "HEAD" });
  for (const tag of tags) add(tag.sha, { kind: "tag", name: tag.name });
  const order = { head: 0, local: 1, remote: 2, tag: 3 };
  for (const list of map.values()) {
    list.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  }
  return map;
}

async function parseTags(cwd) {
  try {
    const out = await git(cwd, [
      "for-each-ref",
      "--format=%(refname:short)%00%(objectname)%00%(*objectname)",
      "refs/tags",
    ]);
    const tags = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [name, object, deref] = line.split("\u0000");
      if (name && (deref || object)) tags.push({ name, sha: deref || object });
    }
    return tags;
  } catch {
    return [];
  }
}

async function sessionContext(ctx, sessionId, res, requestedRoot) {
  if (!sessionId) {
    sendJson(res, 400, { error: "missing-session" });
    return null;
  }
  let session;
  try {
    session = ctx.sessions.get(sessionId);
  } catch {
    session = undefined;
  }
  const cwd = session?.header?.cwd;
  if (!cwd || !isAbsolute(cwd)) {
    sendJson(res, 404, { error: "session-workspace-not-found", sessionId });
    return null;
  }

  const workspaces = listWorkspaces(ctx);
  if (!workspaces.some((entry) => samePath(entry.path, cwd))) {
    workspaces.unshift({ id: "session", name: basename(cwd) + " (session)", path: cwd });
  }

  let root = cwd;
  if (requestedRoot) {
    const match = workspaces.find((entry) => samePath(entry.path, requestedRoot));
    if (!match) {
      sendJson(res, 403, { error: "workspace-not-allowed", root: requestedRoot });
      return null;
    }
    root = match.path;
  }

  let repoRoot = null;
  try {
    repoRoot = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    repoRoot = null;
  }
  return { sessionId, cwd, root, workspaces, repoRoot };
}

async function isGitRepo(path) {
  try {
    await git(path, ["rev-parse", "--show-toplevel"]);
    return true;
  } catch {
    return false;
  }
}

async function apiContext(ctx, url, res) {
  const context = await sessionContext(
    ctx,
    url.searchParams.get("session"),
    res,
    url.searchParams.get("root"),
  );
  if (!context) return;
  const workspaces = await Promise.all(
    context.workspaces.map(async (workspace) => ({
      ...workspace,
      isRepo: workspace.path === context.root ? context.repoRoot !== null : await isGitRepo(workspace.path),
    })),
  );
  let current = null;
  let detached = false;
  let changes = 0;
  if (context.repoRoot) {
    try {
      current = (await git(context.repoRoot, ["branch", "--show-current"])).trim() || null;
      detached = current === null;
      changes = (await git(context.repoRoot, ["status", "--porcelain=v1", "-uno"]))
        .split(/\r?\n/)
        .filter(Boolean).length;
    } catch {
      // An unreadable repository still answers with the workspace root.
    }
  }
  sendJson(res, 200, { ...context, workspaces, current, detached, changes });
}

async function apiTree(ctx, url, res) {
  const context = await sessionContext(
    ctx,
    url.searchParams.get("session"),
    res,
    url.searchParams.get("root"),
  );
  if (!context) return;
  const absolute = safeResolve(context.root, url.searchParams.get("path") || "");
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    sendJson(res, error.code === "ENOENT" ? 404 : 500, {
      error: error.code || "read-failed",
      message: error.message,
    });
    return;
  }
  const list = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    if (list.length >= MAX_ENTRIES) break;
    let size;
    if (entry.isFile()) {
      try {
        size = (await stat(resolve(absolute, entry.name))).size;
      } catch {
        size = undefined;
      }
    }
    list.push({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      size,
    });
  }
  list.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  sendJson(res, 200, {
    root: context.root,
    path: relative(context.root, absolute).split(sep).join("/"),
    entries: list,
    truncated: entries.length > MAX_ENTRIES,
  });
}

async function apiFile(ctx, url, res, req) {
  const context = await sessionContext(
    ctx,
    url.searchParams.get("session"),
    res,
    url.searchParams.get("root"),
  );
  if (!context) return;
  const relativePath = url.searchParams.get("path") || "";
  const absolute = safeResolve(context.root, relativePath);
  if (req.method === "PUT") {
    const body = await readJson(req);
    if (typeof body.text !== "string") {
      sendJson(res, 400, { error: "text-required" });
      return;
    }
    if (Buffer.byteLength(body.text) > MAX_FILE_BYTES) {
      sendJson(res, 413, { error: "file-too-large" });
      return;
    }
    await writeFile(absolute, body.text, "utf8");
    const info = await stat(absolute);
    sendJson(res, 200, { ok: true, size: info.size, mtime: info.mtimeMs });
    return;
  }
  let buffer;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) {
      sendJson(res, 400, { error: "not-a-file" });
      return;
    }
    if (info.size > MAX_FILE_BYTES) {
      sendJson(res, 413, { error: "file-too-large", size: info.size, limit: MAX_FILE_BYTES });
      return;
    }
    buffer = await readFile(absolute);
  } catch (error) {
    sendJson(res, error.code === "ENOENT" ? 404 : 500, {
      error: error.code || "read-failed",
      message: error.message,
    });
    return;
  }
  const binary = isProbablyBinary(buffer);
  sendJson(res, 200, {
    root: context.root,
    path: relative(context.root, absolute).split(sep).join("/"),
    absolutePath: absolute,
    language: languageFor(absolute),
    size: buffer.length,
    binary,
    text: binary ? "" : buffer.toString("utf8"),
  });
}

async function apiGitState(ctx, url, res) {
  const context = await sessionContext(
    ctx,
    url.searchParams.get("session"),
    res,
    url.searchParams.get("root"),
  );
  if (!context) return;
  if (!context.repoRoot) {
    sendJson(res, 200, {
      isRepo: false,
      cwd: context.cwd,
      root: context.root,
      workspaces: context.workspaces,
    });
    return;
  }
  const root = context.repoRoot;
  const limit = Math.min(5000, Math.max(20, Number(url.searchParams.get("limit")) || 500));
  const requested = url.searchParams.get("ref") || "";
  if (requested && requested !== "ALL" && !/^[A-Za-z0-9._\/-]+$/.test(requested)) {
    sendJson(res, 400, { error: "invalid-ref" });
    return;
  }
  const branchesOut = await git(root, [
    "for-each-ref",
    "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(subject)",
    "refs/heads",
    "refs/remotes",
  ]);
  const branches = parseBranches(branchesOut);
  const tags = await parseTags(root);
  const headSha = (await git(root, ["rev-parse", "HEAD"])).trim();
  const current = (await git(root, ["branch", "--show-current"])).trim() || null;
  const detached = current === null;
  const ref = requested || current || "ALL";
  const rev = ref === "ALL" ? "--all" : ref;
  const out = await git(root, [
    "log",
    "--no-color",
    "--no-show-signature",
    `--max-count=${limit + 1}`,
    "--topo-order",
    "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%s%x1e",
    rev,
  ]);
  const commits = parseLog(out);
  const hasMore = commits.length > limit;
  if (hasMore) commits.length = limit;
  const refMap = buildRefMap(branches, tags, headSha);
  for (const commit of commits) commit.refs = refMap.get(commit.hash) ?? [];
  const currentBranch = branches.find((branch) => branch.current);
  const changes = (await git(root, ["status", "--porcelain=v1", "-uno"]))
    .split(/\r?\n/)
    .filter(Boolean).length;
  sendJson(res, 200, {
    isRepo: true,
    repoRoot: root,
    root: context.root,
    cwd: context.cwd,
    ref,
    label: ref === "ALL" ? "All branches" : ref,
    branches,
    commits,
    limit,
    hasMore,
    current,
    detached,
    headSha,
    ahead: currentBranch?.ahead ?? 0,
    behind: currentBranch?.behind ?? 0,
    empty: !headSha,
    changes,
  });
}

async function apiGitStatus(ctx, url, res) {
  const context = await sessionContext(
    ctx,
    url.searchParams.get("session"),
    res,
    url.searchParams.get("root"),
  );
  if (!context) return;
  if (!context.repoRoot) {
    sendJson(res, 404, { error: "not-a-repository" });
    return;
  }
  const out = await git(context.repoRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  sendJson(res, 200, {
    ...parseStatusZ(out),
    root: context.root,
    repoRoot: context.repoRoot,
  });
}

async function readWorkingFile(root, filePath) {
  const absolute = safeResolve(root, filePath);
  const info = await stat(absolute);
  if (!info.isFile()) {
    return { binary: false, text: "", missing: true };
  }
  if (info.size > MAX_FILE_BYTES) {
    const error = new Error("file is too large to display");
    error.status = 413;
    throw error;
  }
  const buffer = await readFile(absolute);
  if (isProbablyBinary(buffer)) return { binary: true, text: "" };
  return { binary: false, text: buffer.toString("utf8") };
}

async function showGitPath(root, revision, filePath) {
  try {
    const buffer = await gitBuffer(root, ["show", `${revision}:${filePath}`], { timeout: 60000 });
    if (isProbablyBinary(buffer)) return { binary: true, text: "" };
    return { binary: false, text: buffer.toString("utf8") };
  } catch {
    return { binary: false, text: "", missing: true };
  }
}

async function apiGitWorktreeDiff(ctx, url, res) {
  const context = await sessionContext(
    ctx,
    url.searchParams.get("session"),
    res,
    url.searchParams.get("root"),
  );
  if (!context) return;
  if (!context.repoRoot) {
    sendJson(res, 404, { error: "not-a-repository" });
    return;
  }
  const root = context.repoRoot;
  const filePath = url.searchParams.get("path") || "";
  const oldPath = url.searchParams.get("oldPath") || filePath;
  const staged = url.searchParams.get("staged") === "1";
  const status = (url.searchParams.get("status") || "M").slice(0, 1);
  if (!filePath || filePath.includes("\u0000")) {
    sendJson(res, 400, { error: "invalid-path" });
    return;
  }
  const absolute = resolve(root, filePath);
  if (!inside(root, absolute)) {
    sendJson(res, 403, { error: "outside-repository" });
    return;
  }

  let oldSide = { binary: false, text: "" };
  let newSide = { binary: false, text: "" };
  if (staged) {
    if (status !== "A") oldSide = await showGitPath(root, "HEAD", oldPath);
    if (status !== "D") newSide = await showGitPath(root, "", filePath);
  } else if (status === "?" || status === "A") {
    newSide = await readWorkingFile(root, filePath);
  } else if (status === "D") {
    oldSide = await showGitPath(root, "", oldPath);
  } else {
    oldSide = await showGitPath(root, "", oldPath);
    newSide = await readWorkingFile(root, filePath);
  }

  sendJson(res, 200, {
    path: filePath,
    oldPath,
    staged,
    status,
    old: oldSide.text,
    new: newSide.text,
    binary: oldSide.binary || newSide.binary,
    oldMissing: oldSide.missing === true,
    newMissing: newSide.missing === true,
  });
}

async function apiGitCommit(ctx, url, res) {
  const context = await sessionContext(
    ctx,
    url.searchParams.get("session"),
    res,
    url.searchParams.get("root"),
  );
  if (!context?.repoRoot) {
    sendJson(res, 404, { error: "not-a-repository" });
    return;
  }
  const hash = url.searchParams.get("hash") || "";
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    sendJson(res, 400, { error: "invalid-hash" });
    return;
  }
  const root = context.repoRoot;
  const parentsOut = await git(root, ["rev-list", "--parents", "-n", "1", hash]);
  const parents = parentsOut.trim().split(/\s+/).slice(1);
  const body = (await git(root, ["show", "-s", "--format=%B", hash])).replace(/\s+$/, "");
  const base = parents[0] ?? EMPTY_TREE;
  const statusOut = await git(root, [
    "diff",
    "--no-color",
    "--find-renames",
    "-M",
    "-z",
    "--name-status",
    base,
    hash,
  ]);
  const numstatOut = await git(root, [
    "diff",
    "--no-color",
    "--find-renames",
    "-M",
    "-z",
    "--numstat",
    base,
    hash,
  ]);
  const statuses = parseNameStatusZ(statusOut);
  const stats = parseNumstatZ(numstatOut);
  const files = statuses.map((entry, index) => {
    const value = stats.get(entry.path) ?? (stats.size === statuses.length ? [...stats.values()][index] : undefined);
    return {
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      adds: value?.adds ?? 0,
      dels: value?.dels ?? 0,
      binary: value?.binary ?? false,
    };
  });
  sendJson(res, 200, { hash, body, parents, files });
}

async function showPath(root, rev, filePath) {
  try {
    const buffer = await gitBuffer(root, ["show", `${rev}:${filePath}`], { timeout: 60000 });
    if (isProbablyBinary(buffer)) return { binary: true, text: "" };
    return { binary: false, text: buffer.toString("utf8") };
  } catch {
    return { binary: false, text: "", missing: true };
  }
}

async function apiGitDiff(ctx, url, res) {
  const context = await sessionContext(
    ctx,
    url.searchParams.get("session"),
    res,
    url.searchParams.get("root"),
  );
  if (!context?.repoRoot) {
    sendJson(res, 404, { error: "not-a-repository" });
    return;
  }
  const root = context.repoRoot;
  const hash = url.searchParams.get("hash") || "";
  const parent = url.searchParams.get("parent") || "";
  const filePath = url.searchParams.get("path") || "";
  const oldPath = url.searchParams.get("oldPath") || filePath;
  const status = url.searchParams.get("status") || "M";
  if (!/^[0-9a-f]{7,40}$/i.test(hash) || (parent && !/^[0-9a-f]{7,40}$/i.test(parent))) {
    sendJson(res, 400, { error: "invalid-revision" });
    return;
  }
  if (!filePath || filePath.includes("\u0000")) {
    sendJson(res, 400, { error: "invalid-path" });
    return;
  }
  const absolute = resolve(root, filePath);
  if (!inside(root, absolute)) {
    sendJson(res, 403, { error: "outside-repository" });
    return;
  }
  const oldSide = status === "A" ? { binary: false, text: "" } : await showPath(root, parent || EMPTY_TREE, oldPath);
  const newSide = status === "D" ? { binary: false, text: "" } : await showPath(root, hash, filePath);
  sendJson(res, 200, {
    path: filePath,
    oldPath,
    status,
    old: oldSide.text,
    new: newSide.text,
    binary: oldSide.binary || newSide.binary,
    oldMissing: oldSide.missing === true,
    newMissing: newSide.missing === true,
  });
}

async function apiGitAction(ctx, url, res, req) {
  const context = await sessionContext(
    ctx,
    url.searchParams.get("session"),
    res,
    url.searchParams.get("root"),
  );
  if (!context?.repoRoot) {
    sendJson(res, 404, { error: "not-a-repository" });
    return;
  }
  const root = context.repoRoot;
  const body = await readJson(req);
  const action = String(body.action || "");
  const ref = body.ref ? String(body.ref) : "";
  const hash = body.hash ? String(body.hash) : "";
  const name = body.name ? String(body.name) : "";
  const mode = body.mode ? String(body.mode) : "";
  const force = body.force === true;

  const branch = /^[A-Za-z0-9._\/-]+$/.test(ref) ? ref : "";
  const revision = /^[0-9a-f]{7,40}$/i.test(hash) ? hash : "";
  const branchName = /^[A-Za-z0-9._\/-]+$/.test(name) ? name : "";
  const remote = /^[A-Za-z0-9._-]+$/.test(String(body.remote || "")) ? String(body.remote) : "";
  const remoteBranch =
    /^[A-Za-z0-9._\/-]+$/.test(String(body.branch || "")) &&
    !String(body.branch || "").startsWith("-") &&
    !String(body.branch || "").includes("..")
      ? String(body.branch)
      : "";

  try {
    switch (action) {
      case "checkoutBranch": {
        if (!branch) throw Object.assign(new Error("branch is required"), { status: 400 });
        if (body.remote) {
          const localName = branch.split("/").slice(1).join("/");
          let exists = false;
          try {
            await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${localName}`]);
            exists = true;
          } catch {
            exists = false;
          }
          if (exists) await git(root, ["checkout", localName]);
          else await git(root, ["checkout", "-b", localName, "--track", branch]);
          return sendJson(res, 200, { ok: true, message: `Checked out ${localName}` });
        }
        await git(root, ["checkout", branch]);
        return sendJson(res, 200, { ok: true, message: `Checked out ${branch}` });
      }
      case "checkoutRevision": {
        if (!revision) throw Object.assign(new Error("commit hash is required"), { status: 400 });
        await git(root, ["checkout", "--detach", revision]);
        return sendJson(res, 200, { ok: true, message: `Checked out ${revision.slice(0, 7)} (detached HEAD)` });
      }
      case "newBranch": {
        if (!branchName) throw Object.assign(new Error("branch name is required"), { status: 400 });
        const from = revision || branch;
        const args = ["checkout", "-b", branchName];
        if (from) args.push(from);
        await git(root, args);
        return sendJson(res, 200, { ok: true, message: `Created and checked out ${branchName}` });
      }
      case "merge": {
        const target = revision || branch;
        if (!target) throw Object.assign(new Error("revision is required"), { status: 400 });
        await git(root, ["merge", "--no-edit", target]);
        return sendJson(res, 200, { ok: true, message: `Merged ${target}` });
      }
      case "rebase": {
        const target = revision || branch;
        if (!target) throw Object.assign(new Error("revision is required"), { status: 400 });
        await git(root, ["rebase", target]);
        return sendJson(res, 200, { ok: true, message: `Rebased onto ${target}` });
      }
      case "cherryPick": {
        if (!revision) throw Object.assign(new Error("commit hash is required"), { status: 400 });
        await git(root, ["cherry-pick", revision]);
        return sendJson(res, 200, { ok: true, message: `Cherry-picked ${revision.slice(0, 7)}` });
      }
      case "revert": {
        if (!revision) throw Object.assign(new Error("commit hash is required"), { status: 400 });
        await git(root, ["revert", "--no-edit", revision]);
        return sendJson(res, 200, { ok: true, message: `Reverted ${revision.slice(0, 7)}` });
      }
      case "reset": {
        if (!revision || !["soft", "mixed", "hard"].includes(mode)) {
          throw Object.assign(new Error("commit hash and reset mode are required"), { status: 400 });
        }
        await git(root, ["reset", `--${mode}`, revision]);
        return sendJson(res, 200, { ok: true, message: `Reset to ${revision.slice(0, 7)} (${mode})` });
      }
      case "createTag": {
        if (!branchName || !revision) throw Object.assign(new Error("tag name and commit are required"), { status: 400 });
        await git(root, ["tag", branchName, revision]);
        return sendJson(res, 200, { ok: true, message: `Created tag ${branchName}` });
      }
      case "deleteBranch": {
        if (!branch) throw Object.assign(new Error("branch is required"), { status: 400 });
        await git(root, ["branch", force ? "-D" : "-d", branch]);
        return sendJson(res, 200, { ok: true, message: `Deleted branch ${branch}` });
      }
      case "renameBranch": {
        if (!branch || !branchName) throw Object.assign(new Error("old and new branch names are required"), { status: 400 });
        await git(root, ["branch", "-m", branch, branchName]);
        return sendJson(res, 200, { ok: true, message: `Renamed ${branch} to ${branchName}` });
      }
      case "pullBranch": {
        if (!remote || !remoteBranch) {
          throw Object.assign(new Error("remote and branch are required"), { status: 400 });
        }
        await git(root, ["fetch", remote, remoteBranch], { timeout: 0 });
        await git(root, ["merge", "--no-edit", "FETCH_HEAD"]);
        return sendJson(res, 200, {
          ok: true,
          message: `Pulled ${remote}/${remoteBranch} into the current branch`,
        });
      }
      case "fetch": {
        await git(root, ["fetch", "--all", "--prune"], { timeout: 0 });
        return sendJson(res, 200, { ok: true, message: "Fetched all remotes" });
      }
      case "pull": {
        await git(root, ["pull", "--no-edit"], { timeout: 0 });
        return sendJson(res, 200, { ok: true, message: "Pulled" });
      }
      case "push": {
        const target = branch || null;
        const current = (await git(root, ["branch", "--show-current"])).trim();
        if (target && target !== current) {
          await git(root, ["push", "origin", target], { timeout: 0 });
        } else {
          try {
            await git(root, ["push"], { timeout: 0 });
          } catch (error) {
            if (!/no upstream branch|set-upstream|has no upstream/i.test(String(error.stderr || error.message))) throw error;
            await git(root, ["push", "--set-upstream", "origin", current || target], { timeout: 0 });
          }
        }
        return sendJson(res, 200, { ok: true, message: `Pushed ${target || current}` });
      }
      default:
        throw Object.assign(new Error("unknown action: " + action), { status: 400 });
    }
  } catch (error) {
    const message = String(error.stderr || error.message || error).trim();
    sendJson(res, error.status || 400, { error: "git-failed", message });
  }
}

async function serveStatic(res, pathname) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, "bad path");
    return;
  }
  const absolute = resolve(WEB, "." + (relativePath.startsWith("/") ? relativePath : "/" + relativePath));
  if (absolute !== WEB && !absolute.startsWith(WEB + sep)) {
    sendText(res, 403, "outside ui root");
    return;
  }
  try {
    const body = await readFile(absolute);
    const headers = {
      "content-type": MIME[extname(absolute).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    };
    if (absolute.endsWith(".html")) {
      headers["content-security-policy"] =
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src 'none'; base-uri 'none'";
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch (error) {
    if (error && error.code === "ENOENT") sendText(res, 404, "not found");
    else sendText(res, 500, error instanceof Error ? error.message : String(error));
  }
}

async function handle(ctx, req, res) {
  const rejection = ctx.connection.requestRejection(req);
  if (rejection !== undefined) {
    res.writeHead(rejection);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname.startsWith(BASE + "/web/")) {
    await serveStatic(res, url.pathname.slice(BASE.length + 5));
    return;
  }
  if (url.pathname === BASE + "/api/context") return apiContext(ctx, url, res);
  if (url.pathname === BASE + "/api/tree") return apiTree(ctx, url, res);
  if (url.pathname === BASE + "/api/file") return apiFile(ctx, url, res, req);
  if (url.pathname === BASE + "/api/git/state") return apiGitState(ctx, url, res);
  if (url.pathname === BASE + "/api/git/status") return apiGitStatus(ctx, url, res);
  if (url.pathname === BASE + "/api/git/worktree-diff") return apiGitWorktreeDiff(ctx, url, res);
  if (url.pathname === BASE + "/api/git/commit") return apiGitCommit(ctx, url, res);
  if (url.pathname === BASE + "/api/git/diff") return apiGitDiff(ctx, url, res);
  if (url.pathname === BASE + "/api/git/action" && req.method === "POST") return apiGitAction(ctx, url, res, req);
  sendJson(res, 404, { error: "not-found" });
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: BASE,
        handler: (req, res) => {
          handle(ctx, req, res).catch((error) => {
            ctx.logger.warn("code-git: request failed: " + (error instanceof Error ? error.message : error));
            if (!res.headersSent) sendText(res, 500, "internal error");
            else res.destroy();
          });
        },
      }),
    "code-git: /code-git routes",
  );
}
