import { marked } from "marked";
import hljs from "highlight.js";
import DOMPurify from "dompurify";
import { Snippet, Collection } from "./types";

function escapeHtml(str: string | null | undefined): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Generates a self-contained, beautiful, responsive, interactive HTML page
 * for the exported snippets. Contains embedded CSS, syntax highlighting themes,
 * interactive search, language & collection filtering, dark/light toggle, and copy features.
 */
export function generateSnippetsHtml(
  snippets: Snippet[],
  collections: Collection[],
  customTitle?: string,
  onProgress?: (current: number, total: number, title: string) => void
): string {
  const collectionsMap = new Map<string, Collection>();
  for (const c of collections) {
    collectionsMap.set(c.id, c);
  }

  const isSingle = snippets.length === 1;
  const pageTitle = customTitle || (isSingle ? snippets[0].title || "Snippet Export" : "SnippetBox Archive Export");
  const exportDate = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  // Calculate stats
  const uniqueLangs = Array.from(new Set(snippets.map((s) => (s.language || "text").toLowerCase()))).sort();
  const uniqueCols = Array.from(new Set(snippets.map((s) => s.collectionId))).map((id) => collectionsMap.get(id)).filter(Boolean) as Collection[];
  const totalLines = snippets.reduce((acc, s) => acc + (s.content ? s.content.split("\n").length : 0), 0);

  // Pre-process snippets into HTML cards
  const snippetCardsHtml = snippets
    .map((s, index) => {
      if (onProgress) {
        onProgress(index + 1, snippets.length, s.title || "Untitled");
      }
      const col = collectionsMap.get(s.collectionId);
      const colName = col ? col.name : "Default";
      const colColor = col ? col.color : "#6366f1";
      const lang = (s.language || "text").toLowerCase();
      const isMd = lang === "markdown" || lang === "md";

      // Render Markdown preview if markdown
      let renderedMarkdownHtml = "";
      if (isMd) {
        try {
          const rawHtml = marked.parse(s.content || "") as string;
          renderedMarkdownHtml = DOMPurify.sanitize(rawHtml);
        } catch {
          renderedMarkdownHtml = `<p>${escapeHtml(s.content)}</p>`;
        }
      }

      // Syntax highlight the code
      let highlightedCode = "";
      try {
        if (lang && hljs.getLanguage(lang)) {
          highlightedCode = hljs.highlight(s.content || "", { language: lang }).value;
        } else {
          highlightedCode = hljs.highlightAuto(s.content || "").value;
        }
      } catch {
        highlightedCode = escapeHtml(s.content || "");
      }

      // Format code with line numbers
      const lines = highlightedCode.split("\n");
      const lineNumbersHtml = lines
        .map((_, i) => `<span class="line-num">${i + 1}</span>`)
        .join("");
      const codeLinesHtml = lines
        .map((line) => `<span class="code-line">${line || " "}</span>`)
        .join("\n");

      // Encoded raw content for copy button
      const rawContentEscaped = escapeHtml(s.content || "");

      return `
      <article
        class="snippet-card"
        id="snippet-${s.id}"
        data-id="${escapeHtml(s.id)}"
        data-title="${escapeHtml((s.title || "").toLowerCase())}"
        data-lang="${escapeHtml(lang)}"
        data-collection="${escapeHtml(s.collectionId)}"
        data-favorite="${s.favorite ? "true" : "false"}"
        data-tags="${escapeHtml(s.tags.join(",").toLowerCase())}"
        data-keywords="${escapeHtml(s.keywords.join(",").toLowerCase())}"
      >
        <header class="card-header">
          <div class="card-title-group">
            <h2 class="card-title">
              <span class="card-index">#${index + 1}</span>
              <a href="#snippet-${s.id}">${escapeHtml(s.title || "Untitled")}</a>
            </h2>
            <div class="card-badges">
              <span class="badge badge-lang" title="Language: ${escapeHtml(lang)}">
                <span class="badge-dot"></span>
                ${escapeHtml(lang.toUpperCase())}
              </span>
              <span class="badge badge-col" style="--badge-color: ${escapeHtml(colColor)};" title="Collection: ${escapeHtml(colName)}">
                <span class="badge-dot" style="background-color: ${escapeHtml(colColor)};"></span>
                ${escapeHtml(colName)}
              </span>
              ${
                s.favorite
                  ? `<span class="badge badge-fav" title="Favorited">★ Favorite</span>`
                  : ""
              }
              ${
                s.copyCount > 0
                  ? `<span class="badge badge-meta" title="Copied ${s.copyCount} times">📋 ${s.copyCount}x</span>`
                  : ""
              }
            </div>
          </div>
          <div class="card-actions">
            ${
              isMd
                ? `
              <div class="tab-toggle" data-card-id="${s.id}">
                <button type="button" class="tab-btn active" data-tab="preview" title="View formatted Markdown">Preview</button>
                <button type="button" class="tab-btn" data-tab="source" title="View raw Markdown source">Source</button>
              </div>
            `
                : ""
            }
            <button
              type="button"
              class="btn-copy"
              data-raw-content="${rawContentEscaped}"
              title="Copy snippet content to clipboard"
            >
              <svg class="icon-copy" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <svg class="icon-check" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="display:none;">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              <span class="copy-text">Copy</span>
            </button>
          </div>
        </header>

        ${
          s.tags.length > 0 || s.keywords.length > 0
            ? `
          <div class="card-tags-row">
            ${s.tags
              .map(
                (t) =>
                  `<button type="button" class="tag-chip" data-filter-tag="${escapeHtml(t)}" title="Filter by tag: ${escapeHtml(t)}">#${escapeHtml(t)}</button>`
              )
              .join("")}
            ${s.keywords
              .map(
                (k) =>
                  `<span class="keyword-pill" title="Extracted keyword">${escapeHtml(k)}</span>`
              )
              .join("")}
          </div>
        `
            : ""
        }

        <div class="card-content">
          ${
            isMd
              ? `
            <div class="markdown-body markdown-view-pane" id="preview-${s.id}">
              ${renderedMarkdownHtml}
            </div>
            <div class="code-container source-view-pane" id="source-${s.id}" style="display:none;">
              <div class="code-gutter">${lineNumbersHtml}</div>
              <pre class="code-pre"><code class="hljs ${escapeHtml(lang)}">${codeLinesHtml}</code></pre>
            </div>
          `
              : `
            <div class="code-container">
              <div class="code-gutter">${lineNumbersHtml}</div>
              <pre class="code-pre"><code class="hljs ${escapeHtml(lang)}">${codeLinesHtml}</code></pre>
            </div>
          `
          }
        </div>

        <footer class="card-footer">
          <div class="card-meta">
            ${s.createdAt ? `<span>Created: ${escapeHtml(s.createdAt.slice(0, 10))}</span>` : ""}
            ${s.updatedAt ? `<span>Updated: ${escapeHtml(s.updatedAt.slice(0, 10))}</span>` : ""}
            <span>${lines.length} ${lines.length === 1 ? "line" : "lines"}</span>
          </div>
        </footer>
      </article>
    `;
    })
    .join("\n");

  // Table of Contents list
  const tocListHtml = snippets
    .map((s, index) => {
      const lang = (s.language || "text").toLowerCase();
      return `
      <li class="toc-item" data-id="${escapeHtml(s.id)}">
        <a href="#snippet-${s.id}" class="toc-link">
          <span class="toc-index">${index + 1}</span>
          <span class="toc-title">${escapeHtml(s.title || "Untitled")}</span>
          <span class="toc-lang">${escapeHtml(lang)}</span>
        </a>
      </li>
    `;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(pageTitle)}</title>
  <style>
    /* ---------------------------------------------------------
       SnippetBox Nordic Theme Design System (Embedded)
       --------------------------------------------------------- */
    :root {
      color-scheme: dark;
      --font-ui: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --font-mono: "Fira Code", "JetBrains Mono", "Cascadia Code", Menlo, Monaco, Consolas, monospace;

      --bg-body: #090d16;
      --bg-surface: #0f1523;
      --bg-card: #141c2e;
      --bg-card-hover: #19233a;
      --bg-input: #0b111c;
      --bg-tag: #1c273c;
      --bg-code: #0b111c;
      --bg-gutter: #0f1523;

      --border-subtle: #1c273c;
      --border-default: #25334e;
      --border-strong: #334466;

      --accent-mint: #10b981;
      --accent-indigo: #6366f1;
      --accent-cyan: #06b6d4;
      --accent-amber: #f59e0b;
      --accent-rose: #f43f5e;

      --text-primary: #f8fafc;
      --text-secondary: #cbd5e1;
      --text-muted: #8493a8;
      --text-faint: #475569;

      --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.3);
      --shadow-md: 0 4px 14px rgba(0, 0, 0, 0.4);
      --shadow-lg: 0 10px 30px rgba(0, 0, 0, 0.5);

      /* Highlight.js Dark Theme Tokens */
      --hl-keyword: #ff7b72;
      --hl-function: #d2a8ff;
      --hl-string: #a5d6ff;
      --hl-number: #79c0ff;
      --hl-comment: #8b949e;
      --hl-variable: #ffa657;
      --hl-type: #7ee787;
      --hl-attr: #79c0ff;
      --hl-tag: #7ee787;
    }

    [data-theme="light"] {
      color-scheme: light;
      --bg-body: #f8fafc;
      --bg-surface: #ffffff;
      --bg-card: #ffffff;
      --bg-card-hover: #f1f5f9;
      --bg-input: #f8fafc;
      --bg-tag: #f1f5f9;
      --bg-code: #f8fafc;
      --bg-gutter: #f1f5f9;

      --border-subtle: #e2e8f0;
      --border-default: #cbd5e1;
      --border-strong: #94a3b8;

      --text-primary: #0f172a;
      --text-secondary: #334155;
      --text-muted: #64748b;
      --text-faint: #94a3b8;

      --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.06);
      --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.08);
      --shadow-lg: 0 10px 25px rgba(0, 0, 0, 0.1);

      /* Highlight.js Light Theme Tokens */
      --hl-keyword: #cf222e;
      --hl-function: #8250df;
      --hl-string: #0a3069;
      --hl-number: #0550ae;
      --hl-comment: #6e7781;
      --hl-variable: #953800;
      --hl-type: #116329;
      --hl-attr: #0550ae;
      --hl-tag: #116329;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    html {
      scroll-behavior: smooth;
    }

    body {
      font-family: var(--font-ui);
      background-color: var(--bg-body);
      color: var(--text-primary);
      line-height: 1.5;
      font-size: 14px;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      transition: background-color 0.2s ease, color 0.2s ease;
    }

    /* ---------------------------------------------------------
       Top Navigation Bar
       --------------------------------------------------------- */
    .navbar {
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      backdrop-filter: blur(12px);
      box-shadow: var(--shadow-sm);
    }

    .navbar-container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }

    .brand-group {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .brand-logo {
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, var(--accent-indigo), var(--accent-mint));
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #ffffff;
      box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
    }

    .brand-titles h1 {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .brand-subtitle {
      font-size: 11.5px;
      color: var(--text-muted);
    }

    .nav-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .btn-nav {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: var(--bg-card);
      border: 1px solid var(--border-default);
      color: var(--text-secondary);
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      text-decoration: none;
    }

    .btn-nav:hover {
      background: var(--bg-card-hover);
      color: var(--text-primary);
      border-color: var(--border-strong);
    }

    /* ---------------------------------------------------------
       Hero & Stats Summary
       --------------------------------------------------------- */
    .hero-section {
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      padding: 24px 0;
    }

    .hero-container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 0 24px;
    }

    .stats-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }

    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 12px 16px;
      box-shadow: var(--shadow-sm);
    }

    .stat-label {
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 4px;
    }

    .stat-val {
      font-size: 20px;
      font-weight: 700;
      color: var(--text-primary);
    }

    /* ---------------------------------------------------------
       Filter & Search Bar
       --------------------------------------------------------- */
    .filter-bar {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .search-box-wrapper {
      position: relative;
      width: 100%;
    }

    .search-icon {
      position: absolute;
      left: 12px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-muted);
      pointer-events: none;
    }

    .search-input {
      width: 100%;
      padding: 10px 14px 10px 38px;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      color: var(--text-primary);
      font-size: 13.5px;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }

    .search-input:focus {
      border-color: var(--accent-indigo);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
    }

    .filter-chips-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }

    .filter-chip {
      padding: 4px 10px;
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 20px;
      font-size: 11.5px;
      color: var(--text-secondary);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }

    .filter-chip:hover {
      background: var(--bg-card-hover);
      color: var(--text-primary);
    }

    .filter-chip.active {
      background: var(--accent-indigo);
      border-color: var(--accent-indigo);
      color: #ffffff;
      font-weight: 600;
    }

    /* ---------------------------------------------------------
       Main Workspace Layout (Sidebar + Content)
       --------------------------------------------------------- */
    .main-workspace {
      max-width: 1400px;
      width: 100%;
      margin: 0 auto;
      padding: 24px;
      display: grid;
      grid-template-columns: 280px 1fr;
      gap: 24px;
      flex: 1;
      align-items: start;
    }

    /* Sidebar / Table of Contents */
    .toc-sidebar {
      position: sticky;
      top: 74px;
      max-height: calc(100vh - 90px);
      overflow-y: auto;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      padding: 14px;
      box-shadow: var(--shadow-sm);
    }

    .toc-header {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 10px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .toc-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .toc-item a {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 6px;
      color: var(--text-secondary);
      text-decoration: none;
      font-size: 12px;
      transition: all 0.12s ease;
    }

    .toc-item a:hover {
      background: var(--bg-card-hover);
      color: var(--text-primary);
    }

    .toc-item.active a {
      background: rgba(99, 102, 241, 0.15);
      color: var(--accent-indigo);
      font-weight: 600;
    }

    .toc-index {
      font-size: 10.5px;
      font-weight: 600;
      color: var(--text-muted);
      min-width: 18px;
    }

    .toc-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .toc-lang {
      font-size: 9.5px;
      text-transform: uppercase;
      background: var(--bg-tag);
      padding: 2px 5px;
      border-radius: 4px;
      color: var(--text-muted);
    }

    /* Content Area: Cards List */
    .snippets-container {
      display: flex;
      flex-direction: column;
      gap: 24px;
      min-width: 0;
    }

    .snippet-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      box-shadow: var(--shadow-sm);
      overflow: hidden;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
      scroll-margin-top: 80px;
    }

    .snippet-card:hover {
      border-color: var(--border-strong);
      box-shadow: var(--shadow-md);
    }

    .card-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
    }

    .card-title-group {
      flex: 1;
      min-width: 0;
    }

    .card-title {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 8px;
      display: flex;
      align-items: baseline;
      gap: 8px;
    }

    .card-title a {
      color: inherit;
      text-decoration: none;
    }

    .card-title a:hover {
      color: var(--accent-indigo);
    }

    .card-index {
      font-size: 12px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-weight: 500;
    }

    .card-badges {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      border-radius: 5px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }

    .badge-lang {
      background: rgba(99, 102, 241, 0.12);
      color: var(--accent-indigo);
      border: 1px solid rgba(99, 102, 241, 0.25);
    }

    .badge-col {
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-secondary);
      border: 1px solid var(--border-subtle);
    }

    .badge-fav {
      background: rgba(245, 158, 11, 0.15);
      color: var(--accent-amber);
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .badge-meta {
      background: var(--bg-tag);
      color: var(--text-muted);
      font-size: 10px;
    }

    .badge-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }

    .card-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .tab-toggle {
      display: inline-flex;
      background: var(--bg-input);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      padding: 2px;
    }

    .tab-btn {
      padding: 4px 10px;
      border: none;
      background: transparent;
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 500;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.12s ease;
    }

    .tab-btn.active {
      background: var(--bg-card);
      color: var(--text-primary);
      box-shadow: var(--shadow-sm);
      font-weight: 600;
    }

    .btn-copy {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      color: var(--text-secondary);
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .btn-copy:hover {
      background: var(--bg-card-hover);
      color: var(--text-primary);
      border-color: var(--border-strong);
    }

    .btn-copy.copied {
      background: rgba(16, 185, 129, 0.15);
      border-color: var(--accent-mint);
      color: var(--accent-mint);
    }

    .card-tags-row {
      padding: 8px 20px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }

    .tag-chip {
      padding: 2px 7px;
      background: var(--bg-tag);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      font-size: 11px;
      color: var(--accent-cyan);
      cursor: pointer;
      transition: all 0.12s ease;
    }

    .tag-chip:hover {
      border-color: var(--accent-cyan);
    }

    .keyword-pill {
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      color: var(--text-muted);
      background: rgba(255, 255, 255, 0.04);
    }

    /* ---------------------------------------------------------
       Code Block & Markdown Containers
       --------------------------------------------------------- */
    .card-content {
      position: relative;
    }

    .code-container {
      display: flex;
      background: var(--bg-code);
      font-family: var(--font-mono);
      font-size: 12.5px;
      line-height: 1.6;
      overflow-x: auto;
      border-bottom: 1px solid var(--border-subtle);
    }

    .code-gutter {
      padding: 14px 10px 14px 12px;
      text-align: right;
      color: var(--text-faint);
      background: var(--bg-gutter);
      border-right: 1px solid var(--border-subtle);
      user-select: none;
      display: flex;
      flex-direction: column;
      min-width: 38px;
    }

    .line-num {
      font-size: 11.5px;
    }

    .code-pre {
      margin: 0;
      padding: 14px 16px;
      flex: 1;
      overflow-x: auto;
    }

    .code-pre code {
      font-family: inherit;
      color: var(--text-primary);
      display: block;
    }

    .code-line {
      display: block;
      min-height: 1.6em;
    }

    /* Markdown Rendering Body */
    .markdown-body {
      padding: 20px 24px;
      color: var(--text-primary);
      line-height: 1.7;
      font-size: 14px;
      border-bottom: 1px solid var(--border-subtle);
    }

    .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {
      margin-top: 1.4em;
      margin-bottom: 0.6em;
      color: var(--text-primary);
      font-weight: 700;
    }

    .markdown-body h1 { font-size: 1.7em; border-bottom: 1px solid var(--border-subtle); padding-bottom: 0.3em; }
    .markdown-body h2 { font-size: 1.4em; border-bottom: 1px solid var(--border-subtle); padding-bottom: 0.3em; }
    .markdown-body h3 { font-size: 1.2em; }
    .markdown-body p, .markdown-body ul, .markdown-body ol { margin-bottom: 1em; }
    .markdown-body ul, .markdown-body ol { padding-left: 24px; }
    .markdown-body li { margin-bottom: 0.3em; }
    .markdown-body blockquote {
      border-left: 4px solid var(--accent-indigo);
      padding: 8px 16px;
      margin: 1em 0;
      color: var(--text-secondary);
      background: var(--bg-surface);
      border-radius: 0 6px 6px 0;
    }
    .markdown-body code:not(pre code) {
      font-family: var(--font-mono);
      font-size: 0.9em;
      padding: 2px 6px;
      background: var(--bg-code);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      color: var(--accent-mint);
    }
    .markdown-body pre {
      background: var(--bg-code);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      padding: 12px 16px;
      overflow-x: auto;
      margin: 1em 0;
    }
    .markdown-body table {
      width: 100%;
      border-collapse: collapse;
      margin: 1em 0;
    }
    .markdown-body th, .markdown-body td {
      border: 1px solid var(--border-subtle);
      padding: 8px 12px;
      text-align: left;
    }
    .markdown-body th {
      background: var(--bg-surface);
      font-weight: 600;
    }

    .card-footer {
      padding: 10px 20px;
      background: var(--bg-surface);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .card-meta {
      display: flex;
      align-items: center;
      gap: 14px;
      font-size: 11px;
      color: var(--text-muted);
    }

    /* ---------------------------------------------------------
       Highlight.js Syntax Tokens (Embedded)
       --------------------------------------------------------- */
    .hljs-keyword, .hljs-selector-tag, .hljs-subst { color: var(--hl-keyword); font-weight: 600; }
    .hljs-function, .hljs-title, .hljs-section { color: var(--hl-function); }
    .hljs-string, .hljs-regexp { color: var(--hl-string); }
    .hljs-number, .hljs-literal { color: var(--hl-number); }
    .hljs-comment, .hljs-quote { color: var(--hl-comment); font-style: italic; }
    .hljs-variable, .hljs-template-variable { color: var(--hl-variable); }
    .hljs-type, .hljs-class .hljs-title { color: var(--hl-type); font-weight: 600; }
    .hljs-attr, .hljs-attribute { color: var(--hl-attr); }
    .hljs-tag, .hljs-name { color: var(--hl-tag); }
    .hljs-built_in { color: var(--accent-cyan); }
    .hljs-meta { color: var(--text-muted); }

    /* ---------------------------------------------------------
       Empty Search State & Toast
       --------------------------------------------------------- */
    .empty-state {
      padding: 60px 20px;
      text-align: center;
      background: var(--bg-card);
      border: 1px dashed var(--border-strong);
      border-radius: 10px;
    }

    .empty-state h3 {
      font-size: 16px;
      margin-bottom: 6px;
      color: var(--text-primary);
    }

    .empty-state p {
      font-size: 13px;
      color: var(--text-muted);
    }

    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: var(--bg-card);
      border: 1px solid var(--accent-mint);
      box-shadow: var(--shadow-lg);
      padding: 10px 18px;
      border-radius: 8px;
      color: var(--text-primary);
      font-size: 12.5px;
      font-weight: 500;
      z-index: 1000;
      display: flex;
      align-items: center;
      gap: 8px;
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events: none;
    }

    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }

    .btn-back-top {
      position: fixed;
      bottom: 24px;
      left: 24px;
      width: 40px;
      height: 40px;
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: 50%;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: var(--shadow-md);
      cursor: pointer;
      opacity: 0;
      transform: scale(0.8);
      transition: all 0.2s ease;
      z-index: 90;
    }

    .btn-back-top.show {
      opacity: 1;
      transform: scale(1);
    }

    .btn-back-top:hover {
      color: var(--text-primary);
      background: var(--bg-card-hover);
    }

    /* ---------------------------------------------------------
       Print Styles
       --------------------------------------------------------- */
    @media print {
      body {
        background: #ffffff !important;
        color: #000000 !important;
      }
      .navbar, .hero-section, .toc-sidebar, .card-actions, .btn-back-top, .toast {
        display: none !important;
      }
      .main-workspace {
        display: block !important;
        padding: 0 !important;
        max-width: 100% !important;
      }
      .snippet-card {
        border: 1px solid #cccccc !important;
        box-shadow: none !important;
        margin-bottom: 24px !important;
        page-break-inside: avoid;
      }
      .code-container {
        background: #f8f9fa !important;
      }
    }

    @media (max-width: 860px) {
      .main-workspace {
        grid-template-columns: 1fr;
      }
      .toc-sidebar {
        display: none;
      }
    }
  </style>
</head>
<body>

  <!-- Top Navbar -->
  <nav class="navbar">
    <div class="navbar-container">
      <div class="brand-group">
        <div class="brand-logo">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="16 18 22 12 16 6"></polyline>
            <polyline points="8 6 2 12 8 18"></polyline>
          </svg>
        </div>
        <div class="brand-titles">
          <h1>${escapeHtml(pageTitle)}</h1>
          <div class="brand-subtitle">Generated on ${escapeHtml(exportDate)} · SnippetBox Archive</div>
        </div>
      </div>
      <div class="nav-actions">
        <button type="button" class="btn-nav" id="btn-toggle-theme" title="Toggle Dark / Light Theme">
          <span id="theme-icon">🌙</span>
          <span id="theme-label">Theme</span>
        </button>
        <button type="button" class="btn-nav" onclick="window.print()" title="Print or Save as PDF via Browser">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 6 2 18 2 18 9"></polyline>
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
            <rect x="6" y="14" width="12" height="8"></rect>
          </svg>
          Print
        </button>
      </div>
    </div>
  </nav>

  <!-- Hero & Filter Section -->
  <section class="hero-section">
    <div class="hero-container">
      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-label">Total Snippets</div>
          <div class="stat-val" id="stat-total">${snippets.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Visible Now</div>
          <div class="stat-val" id="stat-visible">${snippets.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Code Lines</div>
          <div class="stat-val">${totalLines.toLocaleString()}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Languages</div>
          <div class="stat-val">${uniqueLangs.length}</div>
        </div>
      </div>

      <div class="filter-bar">
        <div class="search-box-wrapper">
          <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            type="text"
            class="search-input"
            id="search-input"
            placeholder="Search snippet titles, code, tags, or keywords in real-time... (Press '/' to focus)"
            autocomplete="off"
            spellcheck="false"
          />
        </div>

        <div class="filter-chips-row">
          <span style="font-size:11.5px;color:var(--text-muted);font-weight:600;">LANGUAGES:</span>
          <button type="button" class="filter-chip active" data-lang-filter="all">All (${snippets.length})</button>
          ${uniqueLangs
            .map((lang) => {
              const count = snippets.filter((s) => (s.language || "text").toLowerCase() === lang).length;
              return `<button type="button" class="filter-chip" data-lang-filter="${escapeHtml(lang)}">${escapeHtml(lang.toUpperCase())} (${count})</button>`;
            })
            .join("")}
          ${
            snippets.some((s) => s.favorite)
              ? `<button type="button" class="filter-chip" id="btn-filter-fav">★ Favorites</button>`
              : ""
          }
        </div>

        ${
          uniqueCols.length > 1
            ? `
        <div class="filter-chips-row">
          <span style="font-size:11.5px;color:var(--text-muted);font-weight:600;">COLLECTIONS:</span>
          <button type="button" class="filter-chip active" data-col-filter="all">All Collections</button>
          ${uniqueCols
            .map((col) => {
              const count = snippets.filter((s) => s.collectionId === col.id).length;
              return `<button type="button" class="filter-chip" data-col-filter="${escapeHtml(col.id)}"><span class="badge-dot" style="background-color:${escapeHtml(col.color)};"></span>${escapeHtml(col.name)} (${count})</button>`;
            })
            .join("")}
        </div>
        `
            : ""
        }
      </div>
    </div>
  </section>

  <!-- Main Workspace -->
  <main class="main-workspace">
    <!-- Sidebar Table of Contents -->
    <aside class="toc-sidebar">
      <div class="toc-header">
        <span>Table of Contents</span>
        <span id="toc-count">${snippets.length}</span>
      </div>
      <ul class="toc-list" id="toc-list">
        ${tocListHtml}
      </ul>
    </aside>

    <!-- Content Snippets Cards -->
    <section class="snippets-container" id="snippets-container">
      ${snippetCardsHtml}
      <div class="empty-state" id="empty-state" style="display:none;">
        <h3>No matching snippets</h3>
        <p>Try adjusting your search query or language filters.</p>
      </div>
    </section>
  </main>

  <!-- Back to Top Button -->
  <button type="button" class="btn-back-top" id="btn-back-top" title="Back to top">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5">
      <polyline points="18 15 12 9 6 15"></polyline>
    </svg>
  </button>

  <!-- Toast Notification -->
  <div class="toast" id="toast">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--accent-mint)" stroke-width="2.5">
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
    <span id="toast-text">Copied to clipboard</span>
  </div>

  <!-- Interactive Script (Self-Contained) -->
  <script>
    (function () {
      // 1. Theme Management (persists in localStorage)
      const themeToggle = document.getElementById("btn-toggle-theme");
      const themeIcon = document.getElementById("theme-icon");
      const savedTheme = localStorage.getItem("snippetbox_export_theme") || "dark";
      setTheme(savedTheme);

      themeToggle?.addEventListener("click", () => {
        const current = document.documentElement.getAttribute("data-theme");
        const next = current === "dark" ? "light" : "dark";
        setTheme(next);
      });

      function setTheme(t) {
        document.documentElement.setAttribute("data-theme", t);
        localStorage.setItem("snippetbox_export_theme", t);
        if (themeIcon) {
          themeIcon.textContent = t === "dark" ? "🌙" : "☀️";
        }
      }

      // 2. Search & Filtering State
      const searchInput = document.getElementById("search-input");
      const langChips = document.querySelectorAll("[data-lang-filter]");
      const colChips = document.querySelectorAll("[data-col-filter]");
      const favChip = document.getElementById("btn-filter-fav");
      const cards = Array.from(document.querySelectorAll(".snippet-card"));
      const tocItems = Array.from(document.querySelectorAll(".toc-item"));
      const emptyState = document.getElementById("empty-state");
      const statVisible = document.getElementById("stat-visible");
      const tocCount = document.getElementById("toc-count");

      let activeLang = "all";
      let activeCol = "all";
      let filterFavOnly = false;
      let activeTag = "";

      function applyFilters() {
        const query = (searchInput?.value || "").toLowerCase().trim();
        let visible = 0;

        cards.forEach((card) => {
          const title = card.getAttribute("data-title") || "";
          const lang = card.getAttribute("data-lang") || "";
          const colId = card.getAttribute("data-collection") || "";
          const fav = card.getAttribute("data-favorite") === "true";
          const tags = card.getAttribute("data-tags") || "";
          const keywords = card.getAttribute("data-keywords") || "";
          const id = card.getAttribute("data-id") || "";

          const matchLang = activeLang === "all" || lang === activeLang;
          const matchCol = activeCol === "all" || colId === activeCol;
          const matchFav = !filterFavOnly || fav;
          const matchTag = !activeTag || tags.includes(activeTag.toLowerCase());

          // Search matches in title, tags, keywords, or content
          let matchQuery = true;
          if (query) {
            const raw = card.querySelector(".btn-copy")?.getAttribute("data-raw-content") || "";
            matchQuery =
              title.includes(query) ||
              tags.includes(query) ||
              keywords.includes(query) ||
              raw.toLowerCase().includes(query);
          }

          const isVisible = matchLang && matchCol && matchFav && matchTag && matchQuery;
          card.style.display = isVisible ? "" : "none";

          const toc = tocItems.find((t) => t.getAttribute("data-id") === id);
          if (toc) toc.style.display = isVisible ? "" : "none";

          if (isVisible) visible++;
        });

        if (emptyState) emptyState.style.display = visible === 0 ? "block" : "none";
        if (statVisible) statVisible.textContent = String(visible);
        if (tocCount) tocCount.textContent = String(visible);
      }

      searchInput?.addEventListener("input", applyFilters);

      // Keyboard shortcut: '/' to focus search
      window.addEventListener("keydown", (e) => {
        if (e.key === "/" && document.activeElement !== searchInput) {
          e.preventDefault();
          searchInput?.focus();
        }
      });

      langChips.forEach((chip) => {
        chip.addEventListener("click", () => {
          langChips.forEach((c) => c.classList.remove("active"));
          chip.classList.add("active");
          activeLang = chip.getAttribute("data-lang-filter") || "all";
          applyFilters();
        });
      });

      colChips.forEach((chip) => {
        chip.addEventListener("click", () => {
          colChips.forEach((c) => c.classList.remove("active"));
          chip.classList.add("active");
          activeCol = chip.getAttribute("data-col-filter") || "all";
          applyFilters();
        });
      });

      favChip?.addEventListener("click", () => {
        filterFavOnly = !filterFavOnly;
        favChip.classList.toggle("active", filterFavOnly);
        applyFilters();
      });

      // Tag chips inside cards
      document.querySelectorAll("[data-filter-tag]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const tag = btn.getAttribute("data-filter-tag") || "";
          if (activeTag === tag) {
            activeTag = "";
          } else {
            activeTag = tag;
          }
          applyFilters();
        });
      });

      // 3. Markdown View Toggle (Preview vs Source)
      document.querySelectorAll(".tab-toggle").forEach((toggle) => {
        const cardId = toggle.getAttribute("data-card-id");
        const previewPane = document.getElementById("preview-" + cardId);
        const sourcePane = document.getElementById("source-" + cardId);
        const buttons = toggle.querySelectorAll(".tab-btn");

        buttons.forEach((btn) => {
          btn.addEventListener("click", () => {
            buttons.forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            const tab = btn.getAttribute("data-tab");
            if (tab === "preview") {
              if (previewPane) previewPane.style.display = "block";
              if (sourcePane) sourcePane.style.display = "none";
            } else {
              if (previewPane) previewPane.style.display = "none";
              if (sourcePane) sourcePane.style.display = "flex";
            }
          });
        });
      });

      // 4. One-Click Copy Content with Toast Feedback
      const toast = document.getElementById("toast");
      let toastTimer = null;

      function showToast(text) {
        if (!toast) return;
        const toastText = document.getElementById("toast-text");
        if (toastText) toastText.textContent = text;
        toast.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
          toast.classList.remove("show");
        }, 2200);
      }

      document.querySelectorAll(".btn-copy").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const text = btn.getAttribute("data-raw-content") || "";
          try {
            await navigator.clipboard.writeText(text);
            const iconCopy = btn.querySelector(".icon-copy");
            const iconCheck = btn.querySelector(".icon-check");
            const copyText = btn.querySelector(".copy-text");

            btn.classList.add("copied");
            if (iconCopy) iconCopy.style.display = "none";
            if (iconCheck) iconCheck.style.display = "inline";
            if (copyText) copyText.textContent = "Copied!";
            showToast("Snippet copied to clipboard");

            setTimeout(() => {
              btn.classList.remove("copied");
              if (iconCopy) iconCopy.style.display = "inline";
              if (iconCheck) iconCheck.style.display = "none";
              if (copyText) copyText.textContent = "Copy";
            }, 1800);
          } catch (err) {
            console.error("Clipboard copy failed:", err);
            showToast("Failed to copy snippet");
          }
        });
      });

      // 5. Back to Top Button
      const backTop = document.getElementById("btn-back-top");
      window.addEventListener("scroll", () => {
        if (window.scrollY > 300) {
          backTop?.classList.add("show");
        } else {
          backTop?.classList.remove("show");
        }
      });
      backTop?.addEventListener("click", () => {
        window.scrollTo({ top: 0, behavior: "smooth" });
      });

      // 6. Active TOC highlighting with IntersectionObserver
      if ("IntersectionObserver" in window) {
        const observer = new IntersectionObserver(
          (entries) => {
            entries.forEach((entry) => {
              if (entry.isIntersecting) {
                const id = entry.target.getAttribute("data-id");
                tocItems.forEach((t) => {
                  t.classList.toggle("active", t.getAttribute("data-id") === id);
                });
              }
            });
          },
          { rootMargin: "-80px 0px -70% 0px" }
        );
        cards.forEach((c) => observer.observe(c));
      }
    })();
  </script>
</body>
</html>`;
}
