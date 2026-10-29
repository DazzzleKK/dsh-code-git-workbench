/* Maps DSH design tokens onto the VS Code-shaped variables the Git UI uses,
 * so the panel reads as part of the Harness shell in both themes. */
(function () {
  "use strict";

  function readToken(styles, names) {
    for (const name of names) {
      const value = styles.getPropertyValue(name).trim();
      if (value) return value;
    }
    return "";
  }

  function apply() {
    let body;
    let root;
    try {
      body = window.parent.document.body;
      root = window.parent.document.documentElement;
      if (!body) return;
    } catch {
      return;
    }
    const styles = getComputedStyle(body);
    const rootStyles = getComputedStyle(root);
    const token = (names) => readToken(styles, names) || readToken(rootStyles, names);

    const dark =
      body.hasAttribute("data-ds-dark-theme") ||
      (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.colorScheme = dark ? "dark" : "light";

    const bg = token(["--dsw-alias-bg-base"]) || styles.backgroundColor || (dark ? "#1b1b1d" : "#ffffff");
    const layer = token(["--dsw-alias-bg-layer-1", "--dsw-alias-bg-layer-2"]) || bg;
    const fg = token(["--dsw-alias-label-primary"]) || styles.color || (dark ? "#dedede" : "#24292f");
    const muted = token(["--dsw-alias-label-tertiary", "--dsw-alias-label-secondary"]) || (dark ? "#8f8f96" : "#6e7781");
    const border = token(["--dsw-alias-border-l1", "--dsw-alias-separator-primary"]) || (dark ? "#333338" : "#d8dee4");
    const accent = token(["--dsw-alias-accent-primary", "--dsw-brand-primary", "--dsw-alias-label-link"]) || (dark ? "#4f9cf7" : "#0969da");
    const hover = dark ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.05)";
    const inactive = dark ? "rgba(255,255,255,.09)" : "rgba(0,0,0,.08)";
    const selection = `color-mix(in srgb, ${accent} 38%, transparent)`;
    const uiFont = styles.fontFamily || token(["--dsw-font-family"]) || "Segoe UI, sans-serif";
    const mono = token(["--dsw-font-family-mono", "--dsh-code-font-family"]) || "Cascadia Code, Consolas, monospace";

    const vars = {
      "--vscode-editor-background": bg,
      "--vscode-sideBar-background": layer,
      "--vscode-foreground": fg,
      "--vscode-descriptionForeground": muted,
      "--vscode-panel-border": border,
      "--vscode-editorWidget-border": border,
      "--vscode-list-hoverBackground": hover,
      "--vscode-list-inactiveSelectionBackground": inactive,
      "--vscode-list-activeSelectionBackground": selection,
      "--vscode-list-activeSelectionForeground": fg,
      "--vscode-editor-selectionBackground": selection,
      "--vscode-editor-selectionForeground": fg,
      "--vscode-focusBorder": accent,
      "--vscode-input-background": layer,
      "--vscode-input-foreground": fg,
      "--vscode-input-border": border,
      "--vscode-menu-background": layer,
      "--vscode-menu-foreground": fg,
      "--vscode-menu-selectionBackground": accent,
      "--vscode-menu-selectionForeground": dark ? "#ffffff" : "#ffffff",
      "--vscode-menu-border": border,
      "--vscode-editorWidget-background": layer,
      "--vscode-scrollbarSlider-background": "rgba(128,128,128,.35)",
      "--vscode-scrollbarSlider-hoverBackground": "rgba(128,128,128,.55)",
      "--vscode-gitDecoration-addedResourceForeground": "#3fb950",
      "--vscode-gitDecoration-modifiedResourceForeground": "#d29922",
      "--vscode-errorForeground": "#f85149",
      "--vscode-font-family": uiFont,
      "--vscode-editor-font-family": mono,
    };
    for (const [name, value] of Object.entries(vars)) {
      if (value) document.documentElement.style.setProperty(name, value);
    }
  }

  apply();
  try {
    const body = window.parent.document.body;
    new MutationObserver(apply).observe(body, {
      attributes: true,
      attributeFilter: ["data-ds-dark-theme", "class", "style"],
    });
    new MutationObserver(apply).observe(window.parent.document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
  } catch {
    // Standalone tab: keep the built-in fallback palette.
  }
})();
