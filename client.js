/*
 * dsh-code-git — client half.
 *
 * Registers two right-sidebar pages, each a thin React wrapper around a
 * same-origin iframe that carries the actual workbench:
 *
 *   Code — project tree, tabs and a CodeMirror editor.
 *   Git  — a PyCharm-style branch/commit panel with merge, cherry-pick, rebase,
 *          reset, tags and fetch/pull/push.
 *
 * The iframe owns all interaction, so the DSH bundle stays tiny and the pages
 * can use plain scripts and their own stylesheet.
 */
(function () {
  "use strict";

  const loader = typeof window === "undefined" ? undefined : window.__ModuleLoader__;
  if (loader === undefined || loader === null || typeof loader.load !== "function") {
    console.warn("dsh-code-git-workbench: module loader is absent");
    return;
  }

  try {
    loader.load({
      id: "dsh-code-git-workbench",
      factory: (require) => {
        try {
        const React = require("react");

        function Icon({ children }) {
          return React.createElement(
            "svg",
            {
              width: 16,
              height: 16,
              viewBox: "0 0 16 16",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: 1.3,
              strokeLinecap: "round",
              strokeLinejoin: "round",
              "aria-hidden": true,
            },
            children,
          );
        }

        function CodeGlyph() {
          return React.createElement(Icon, null, [
            React.createElement("path", { key: "a", d: "M5.5 4 2 8l3.5 4" }),
            React.createElement("path", { key: "b", d: "M10.5 4 14 8l-3.5 4" }),
          ]);
        }

        function GitGlyph() {
          return React.createElement(Icon, null, [
            React.createElement("circle", { key: "a", cx: 4, cy: 3, r: 1.6 }),
            React.createElement("circle", { key: "b", cx: 4, cy: 13, r: 1.6 }),
            React.createElement("circle", { key: "c", cx: 12, cy: 7, r: 1.6 }),
            React.createElement("path", { key: "d", d: "M4 4.6v6.8" }),
            React.createElement("path", { key: "e", d: "M4 8h3.2c2.2 0 3-1 4.8-1" }),
          ]);
        }

        function Page({ sessionId, page, title }) {
          const src =
            "/code-git/web/" +
            page +
            "?session=" +
            encodeURIComponent(sessionId === undefined || sessionId === null ? "" : sessionId);
          return React.createElement("iframe", {
            src,
            title,
            style: {
              display: "block",
              width: "100%",
              height: "100%",
              border: "0",
              background: "transparent",
              colorScheme: "normal",
            },
          });
        }

        function CodeTab(props) {
          return React.createElement(Page, {
            sessionId: props.sessionId,
            page: "code/index.html",
            title: "Code",
          });
        }

        function GitTab(props) {
          return React.createElement(Page, {
            sessionId: props.sessionId,
            page: "git/index.html",
            title: "Git",
          });
        }

        const CODE_KIND = "code-git-code";
        const GIT_KIND = "code-git-git";
        const CODE_ID = "dsh-code-git/code";
        const GIT_ID = "dsh-code-git/git";

        function definition(id, kind, title, commandId, order, description, icon) {
          return {
            id,
            kind,
            priority: "extension",
            title: () => title,
            keepMounted: true,
            guide: [
              {
                id: "workbench",
                commandId,
                order,
                title: () => title,
                description: () => description,
                icon,
              },
            ],
          };
        }

        function registerPage(ctx, def, component) {
          ctx.effect(() => ctx.sidebarRightTabs.register(def), "code-git: " + def.kind + " type");
          ctx.effect(
            () =>
              ctx.slots.inject("sidebar.right.pane.tab", () =>
                ctx.slots.register(
                  {
                    name: "sidebar.right.pane.tab",
                    key: def.id,
                  },
                  component,
                ),
              ),
            "code-git: " + def.kind + " body",
          );
        }

        /**
         * The shipped subagent catalog is rendered in creation order. Keep the
         * running children above idle ones by reordering the popup tree after
         * each render (the catalog is a React portal with no slot to sort).
         */
        function installSubagentSorting(ctx) {
          const cleanups = [];
          let scheduled = false;

          function isRunning(row) {
            const label = (row.getAttribute("aria-label") || "").toLowerCase();
            if (!label) return false;
            if (label.includes("not running") || label.includes("не выполняется") || label.includes("未运行")) {
              return false;
            }
            return (
              label.includes("running") ||
              label.includes("выполняется") ||
              label.includes("正在运行")
            );
          }

          function rowOf(node) {
            const first = node.firstElementChild;
            return first && first.getAttribute("role") === "treeitem" ? first : null;
          }

          function sortContainer(container) {
            const children = [...container.children].filter((element) => rowOf(element));
            if (children.length < 2) return;
            const ranked = children
              .map((element, index) => ({ element, index, active: isRunning(rowOf(element)) ? 0 : 1 }))
              .sort((a, b) => a.active - b.active || a.index - b.index);
            if (ranked.every((item, index) => item.element === children[index])) return;
            for (const item of ranked) container.appendChild(item.element);
          }

          function sortTree(tree) {
            sortContainer(tree);
            for (const element of tree.querySelectorAll("*")) {
              if (element !== tree && [...element.children].some((child) => rowOf(child))) {
                sortContainer(element);
              }
            }
          }

          function scan() {
            scheduled = false;
            for (const tree of document.querySelectorAll('[role="tree"]')) {
              const label = (tree.getAttribute("aria-label") || "").toLowerCase();
              if (!label.includes("subagent") && !label.includes("子智能体")) continue;
              if (!tree.dataset.codeGitSorted) {
                tree.dataset.codeGitSorted = "1";
                const observer = new MutationObserver(schedule);
                observer.observe(tree, {
                  childList: true,
                  subtree: true,
                  attributes: true,
                  attributeFilter: ["aria-label", "class"],
                });
                cleanups.push(() => observer.disconnect());
              }
              sortTree(tree);
            }
          }

          function schedule() {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(scan);
          }

          const bodyObserver = new MutationObserver(schedule);
          bodyObserver.observe(document.body, { childList: true, subtree: true });
          cleanups.push(() => bodyObserver.disconnect());
          schedule();

          ctx.effect(
            () => () => {
              for (const cleanup of cleanups) cleanup();
            },
            "code-git: subagent catalog order",
          );
        }

        function apply(ctx) {
          try {
            installSubagentSorting(ctx);
            registerPage(
              ctx,
              definition(CODE_ID, CODE_KIND, "Code", "codeGit.code", 20, "Project files and a code editor", CodeGlyph),
              CodeTab,
            );
            registerPage(
              ctx,
              definition(GIT_ID, GIT_KIND, "Git", "codeGit.git", 21, "Branches, commits and history actions", GitGlyph),
              GitTab,
            );
            // Shortcut registration is deferred; guide entries open both pages.
            // shortcut(ctx, "codeGit.code", "Code", ["code workbench", "editor"], "KeyE", CODE_KIND);
            // shortcut(ctx, "codeGit.git", "Git", ["git workbench", "history"], "KeyG", GIT_KIND);
          } catch (error) {
            console.warn("dsh-code-git-workbench: activation failed", error);
          }
        }

        return { apply, inject: ["slots", "sidebarRightTabs", "sidebarRight"] };
        } catch (error) {
          console.warn("dsh-code-git-workbench: factory failed", error);
          return { apply() {}, inject: [] };
        }
      },
    });
  } catch (error) {
    console.warn("dsh-code-git-workbench: bundle registration was refused", error);
  }
})();
