import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl, openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { marked } from "marked";
import hljs from "highlight.js";
import DOMPurify from "dompurify";
import { icon } from "./icons";
import { runExportInBackground } from "./export-runner";
import {
  AppSnapshot,
  AppSettings,
  BackupPreview,
  BackupResult,
  Collection,
  DatabaseInfo,
  RestoreResult,
  SearchFilter,
  SearchResult,
  Snippet,
  SnippetInput,
  TestProviderResult,
  TextImportJob,
} from "./types";
import "./styles.css";
import brandLogo from "../src-tauri/icons/icon.svg";

// Configure Marked with highlight.js
marked.setOptions({
  breaks: true,
  gfm: true,
});

const renderer = new marked.Renderer();
renderer.code = function ({ text, lang }: { text: string; lang?: string }): string {
  const language = lang && hljs.getLanguage(lang) ? lang : "";
  const highlighted = language
    ? hljs.highlight(text, { language }).value
    : hljs.highlightAuto(text).value;

  const displayLang = language || "code";
  const escapedCode = encodeURIComponent(text);

  return `
    <div class="code-block-wrap">
      <div class="code-block-header">
        <span>${escapeHtml(displayLang)}</span>
        <button class="code-copy-btn" data-code="${escapedCode}">
          ${icon("copy")} Copy
        </button>
      </div>
      <pre><code class="hljs ${escapeHtml(displayLang)}">${highlighted}</code></pre>
    </div>
  `;
};

marked.use({ renderer });

// State
let snapshot: AppSnapshot = {
  snippets: [],
  collections: [],
  tags: [],
  keywords: [],
  settings: {
    provider: "local",
    openaiBaseUrl: "https://api.openai.com/v1",
    openaiApiKey: "",
    openaiModel: "text-embedding-3-small",
    openaiDimensions: 512,
    theme: "dark",
    editorMode: "split",
    openSnippetsInNewTabs: true,
  },
  providerStatus: {
    localModelLoaded: false,
    localModelName: "",
    localDimension: 512,
    activeProvider: "local",
  },
  databaseInfo: {
    filename: "snippets.sqlite3",
    sizeBytes: 0,
    path: "",
    directory: "",
  },
};

let searchResults: SearchResult[] = [];
let activeSnippetId: string | null = null;
let openSnippetIds: string[] = [];
let selectedSnippetIds = new Set<string>();
let lastCheckedSnippetId: string | null = null;
let bulkMoveModalOpen = false;
let bulkMoveCollectionId: string | null = null;
let bulkTagModalOpen = false;
let bulkTagInput = "";
let bulkTagRemove = false;
let relatedSnippets: SearchResult[] = [];
let relatedSnippetId: string | null = null;
let relatedSnippetsLoading = false;
let relatedSnippetsError = "";
let relatedSnippetsRequestId = 0;

export type ExportFormat = "json" | "pdf" | "html";

interface ExportModalState {
  isOpen: boolean;
  snippetIds: string[];
  formats: Set<ExportFormat>;
  baseFilename: string;
  isExporting: boolean;
  progressPercent: number;
  progressStage: string;
  progressCurrent: number;
  progressTotal: number;
  error?: string | null;
}

interface ExportedFileRecord {
  format: ExportFormat;
  path: string;
  filename: string;
}

interface ExportSuccessState {
  isOpen: boolean;
  snippetCount: number;
  files: ExportedFileRecord[];
}

let exportModalState: ExportModalState = {
  isOpen: false,
  snippetIds: [],
  formats: new Set<ExportFormat>(["pdf"]),
  baseFilename: "snippets-export",
  isExporting: false,
  progressPercent: 0,
  progressStage: "",
  progressCurrent: 0,
  progressTotal: 0,
  error: null,
};

let exportSuccessState: ExportSuccessState = {
  isOpen: false,
  snippetCount: 0,
  files: [],
};

const filterState: SearchFilter = {
  query: "",
  searchMode: "hybrid",
  collectionIds: [],
  tags: [],
  languages: [],
  dateFrom: "",
  dateTo: "",
  favoriteOnly: false,
  sortBy: "created_desc",
};

// Pagination state
const PAGE_SIZE = 10;
let currentPage = 1;
let userExplicitlyChangedSort = false;

// Popover states
let collectionPopoverOpen = false;
let datePopoverOpen = false;
let openSelectId: string | null = null;
let settingsModalOpen = false;
let settingsActiveTab: "ai" | "preferences" | "backup" = "ai";
let collectionModalOpen = false;
let editingCollection: Collection | null = null;
let importModalOpen = false;
let importCollectionId = "default";
let isImportingText = false;
let textImportJobs: TextImportJob[] = [];
let textImportPollInFlight = false;
let syncScrollEnabled = localStorage.getItem("snippetbox-sync-scroll") !== "false";
let detailHeaderCollapsed = localStorage.getItem("snippetbox-detail-header-collapsed") === "true";
let snippetsPaneCollapsed = localStorage.getItem("snippetbox-snippets-pane-collapsed") === "true";
let lastRenderedSnippetId: string | null = null;

const BACKUP_CANCELLED_ERROR = "BACKUP_CANCELLED";
let activeDataOperationId: string | null = null;
let dataOperationCancellationPending = false;

interface BackupModalState {
  type:
    | "backup-progress"
    | "backup-success"
    | "restore-inspecting"
    | "restore-confirm"
    | "restore-progress"
    | "restore-success";
  title: string;
  message?: string;
  path?: string;
  preview?: BackupPreview;
  backupResult?: BackupResult;
  restoreResult?: RestoreResult;
  operationId?: string;
  cancellationPending?: boolean;
}

let backupModalState: BackupModalState | null = null;

interface ConfirmationDialogState {
  title: string;
  message: string;
  confirmLabel: string;
  action: () => Promise<void> | void;
}

let confirmationDialog: ConfirmationDialogState | null = null;

let isTestingConnection = false;
let connectionTestResult: TestProviderResult | null = null;
let isReindexing = false;

// Search debounce
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let keywordSearchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let keywordSearchQuery = "";
let autoTitleDraftId: string | null = null;
let autoTitleValue = "";
let autoTitleEnabled = false;

// Platform detection
const isMac = navigator.userAgent.toLowerCase().includes("mac");

// Keep the default at 100%, while allowing the complete interface to be made
// more comfortable on high-DPI displays with Cmd/Ctrl +/-.
const INTERFACE_SCALE_LEVELS = [0.8, 1, 1.2, 1.4, 1.6, 1.8, 2] as const;
const DEFAULT_INTERFACE_SCALE = 1;
const storedInterfaceScale = Number(localStorage.getItem("snippetbox-interface-scale"));
let interfaceScale = INTERFACE_SCALE_LEVELS.includes(
  storedInterfaceScale as typeof INTERFACE_SCALE_LEVELS[number]
)
  ? storedInterfaceScale
  : DEFAULT_INTERFACE_SCALE;

const SORT_OPTIONS = [
  { value: "relevance", label: "Best Match" },
  { value: "created_desc", label: "Newest First" },
  { value: "created_asc", label: "Oldest First" },
  { value: "updated_desc", label: "Recently Updated" },
  { value: "title_asc", label: "Title (A-Z)" },
  { value: "copies_desc", label: "Most Copied" },
];

// Presets for OpenAI-compatible embedding providers
const PROVIDER_PRESETS = [
  {
    name: "OpenAI",
    url: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    dims: 512,
  },
  {
    name: "Ollama",
    url: "http://localhost:11434/v1",
    model: "nomic-embed-text",
    dims: 512,
  },
  {
    name: "LM Studio",
    url: "http://localhost:1234/v1",
    model: "text-embedding-nomic-embed-text-v1.5",
    dims: 512,
  },
  {
    name: "LocalAI / vLLM",
    url: "http://localhost:8080/v1",
    model: "text-embedding-ada-002",
    dims: 512,
  },
  {
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1",
    model: "openai/text-embedding-3-small",
    dims: 512,
  },
];

// Initialize app
async function init() {
  await setInterfaceScale(interfaceScale, false);

  document.documentElement.setAttribute(
    "data-theme",
    snapshot.settings.theme === "light" ? "light" : "dark"
  );

  try {
    const data = await invoke<AppSnapshot>("get_app_snapshot");
    snapshot = data;
    textImportJobs = await invoke<TextImportJob[]>("get_text_import_jobs");

    // Apply settings
    document.documentElement.setAttribute(
      "data-theme",
      snapshot.settings.theme === "light" ? "light" : "dark"
    );

    // Initial search
    await performSearch();

    // Select first snippet if available
    if (searchResults.length > 0) {
      activeSnippetId = searchResults[0].snippet.id;
      openSnippetIds = [activeSnippetId];
    }

    render();
    if (activeSnippetId) void loadRelatedSnippets(activeSnippetId);
  } catch (err) {
    console.error("Failed to load initial snapshot:", err);
    showToast(`Error initializing app: ${err}`, "error");
    render();
  }

  setupGlobalEventListeners();
  window.setInterval(() => void pollTextImportJobs(), 1000);
}

function isActiveTextImport(job: TextImportJob): boolean {
  return job.status === "queued" || job.status === "scanning" || job.status === "importing";
}

function renderTextImportStatus(): string {
  const activeJobs = textImportJobs.filter(isActiveTextImport);
  if (activeJobs.length === 0) return "";
  const current = [...activeJobs].reverse().find((job) => job.status !== "queued") || activeJobs[0];
  const collection = snapshot.collections.find((item) => item.id === current.collectionId);
  const progress = current.status === "scanning"
    ? "Scanning…"
    : current.status === "queued"
      ? "Queued…"
      : `${current.processedCount}/${current.discoveredCount} · ${current.importedCount} imported`;
  const remaining = activeJobs.length > 1 ? ` · +${activeJobs.length - 1} queued` : "";
  return `
    <span class="import-status-spinner" aria-hidden="true"></span>
    <span><strong>${escapeHtml(progress)}</strong><small>${escapeHtml(collection?.name || "Collection")}${remaining}</small></span>
  `;
}

function updateTextImportStatus(): void {
  const element = document.getElementById("text-import-status");
  if (!element) return;
  const content = renderTextImportStatus();
  element.innerHTML = content;
  element.hidden = !content;
}

async function pollTextImportJobs(): Promise<void> {
  if (textImportPollInFlight) return;
  textImportPollInFlight = true;
  try {
    const nextJobs = await invoke<TextImportJob[]>("get_text_import_jobs");
    const previous = new Map(textImportJobs.map((job) => [job.id, job]));
    const finished = nextJobs.filter((job) => {
      const old = previous.get(job.id);
      return old && isActiveTextImport(old) && !isActiveTextImport(job);
    });
    textImportJobs = nextJobs;
    updateTextImportStatus();

    if (finished.length > 0) {
      for (const job of finished) {
        if (job.status === "completed") {
          const details: string[] = [];
          if (job.skippedCount > 0) details.push(`${job.skippedCount} skipped`);
          if (job.failedCount > 0) details.push(`${job.failedCount} unreadable`);
          showToast(`Imported ${job.importedCount} snippets${details.length ? ` (${details.join(", ")})` : ""}`);
        } else {
          showToast(`Import failed: ${job.error || "Unknown error"}`, "error");
        }
      }
      await refreshSnapshotPreservingDrafts();
      await performSearch();
      preserveRenderedEditorState();
      render();
    }
  } catch (error) {
    console.error("Failed to refresh text import status:", error);
  } finally {
    textImportPollInFlight = false;
  }
}

let searchRequestId = 0;

async function performSearch() {
  const requestId = ++searchRequestId;
  try {
    if (filterState.query?.trim()) {
      if (!userExplicitlyChangedSort || filterState.sortBy === "created_desc") {
        filterState.sortBy = "relevance";
      }
    } else if (filterState.sortBy === "relevance") {
      filterState.sortBy = "created_desc";
    }

    const results = await invoke<SearchResult[]>("search_snippets", {
      filter: structuredClone(filterState),
    });
    if (requestId !== searchRequestId) return;
    searchResults = results;
    currentPage = 1;

    // Search and filters should not replace a document that is already open.
    // Select the first result only when the viewer has no active tab.
    if (!activeSnippetId && searchResults.length > 0) {
      openSnippet(searchResults[0].snippet.id);
    }
  } catch (err) {
    if (requestId !== searchRequestId) return;
    searchResults = [];
    console.error("Search failed:", err);
    showToast(`Search failed: ${err}`, "error");
  }
}

function getActiveSnippet(): Snippet | null {
  if (!activeSnippetId) return null;
  return snapshot.snippets.find((s) => s.id === activeSnippetId) || null;
}

function openSnippet(id: string): void {
  if (!snapshot.snippets.some((snippet) => snippet.id === id)) return;

  if (openSnippetIds.includes(id)) {
    activeSnippetId = id;
  } else if (snapshot.settings.openSnippetsInNewTabs) {
    openSnippetIds.push(id);
    activeSnippetId = id;
  } else if (activeSnippetId) {
    const activeIndex = openSnippetIds.indexOf(activeSnippetId);
    if (activeIndex >= 0) openSnippetIds.splice(activeIndex, 1, id);
    else openSnippetIds.push(id);
    activeSnippetId = id;
  } else {
    openSnippetIds.push(id);
    activeSnippetId = id;
  }

  openSnippetIds = [...new Set(openSnippetIds)];
}

function isDraftSnippetId(id: string): boolean {
  return id.startsWith("new-");
}

function getPaginatedSnippetIds(): string[] {
  const startIndex = (currentPage - 1) * PAGE_SIZE;
  return searchResults
    .slice(startIndex, startIndex + PAGE_SIZE)
    .map((result) => result.snippet.id);
}

function getSelectedSavedIds(): string[] {
  return [...selectedSnippetIds].filter((id) => !isDraftSnippetId(id));
}

function clearSnippetSelection(): void {
  selectedSnippetIds = new Set();
  lastCheckedSnippetId = null;
}

function pruneSnippetSelection(): void {
  const existing = new Set(snapshot.snippets.map((snippet) => snippet.id));
  selectedSnippetIds = new Set([...selectedSnippetIds].filter((id) => existing.has(id)));
  if (lastCheckedSnippetId && !selectedSnippetIds.has(lastCheckedSnippetId)) {
    lastCheckedSnippetId = null;
  }
}

function toggleSnippetSelection(id: string, selected?: boolean): void {
  const shouldSelect = selected ?? !selectedSnippetIds.has(id);
  if (shouldSelect) selectedSnippetIds.add(id);
  else selectedSnippetIds.delete(id);
  lastCheckedSnippetId = id;
}

function selectSnippetRange(toId: string, pageIds: string[]): void {
  const toIndex = pageIds.indexOf(toId);
  if (toIndex < 0) {
    toggleSnippetSelection(toId, true);
    return;
  }

  const fromId =
    lastCheckedSnippetId && pageIds.includes(lastCheckedSnippetId)
      ? lastCheckedSnippetId
      : pageIds[0];
  const fromIndex = Math.max(0, pageIds.indexOf(fromId));
  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);
  for (let i = start; i <= end; i++) {
    selectedSnippetIds.add(pageIds[i]);
  }
  lastCheckedSnippetId = toId;
}

function allSelectedAreFavorited(): boolean {
  const ids = getSelectedSavedIds();
  if (ids.length === 0) return false;
  return ids.every((id) => {
    const snippet =
      snapshot.snippets.find((item) => item.id === id) ||
      searchResults.find((result) => result.snippet.id === id)?.snippet;
    return Boolean(snippet?.favorite);
  });
}

function parseTagList(value: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of value.split(",")) {
    const tag = part.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

function applySnippetCollection(id: string, collectionId: string): void {
  const snippet = snapshot.snippets.find((item) => item.id === id);
  if (snippet) snippet.collectionId = collectionId;
  const searchItem = searchResults.find((result) => result.snippet.id === id);
  if (searchItem) searchItem.snippet.collectionId = collectionId;
}

function applySnippetFavorite(id: string, favorite: boolean): void {
  const snippet = snapshot.snippets.find((item) => item.id === id);
  if (snippet) snippet.favorite = favorite;
  const searchItem = searchResults.find((result) => result.snippet.id === id);
  if (searchItem) searchItem.snippet.favorite = favorite;
}

function preserveRenderedEditorState(): void {
  const editor = document.getElementById("editor-textarea") as HTMLTextAreaElement | null;
  const title = document.getElementById("detail-title") as HTMLInputElement | null;
  const tags = document.getElementById("detail-tags") as HTMLInputElement | null;
  if (!activeSnippetId || !editor || !title) return;
  const active = snapshot.snippets.find((snippet) => snippet.id === activeSnippetId);
  if (!active) return;
  active.title = title.value;
  active.content = editor.value;
  active.tags = parseTagList(tags?.value || "");
  const collectionId = document.querySelector<HTMLElement>("[data-select-picker='detail-collection']")
    ?.dataset.selectedValue;
  if (collectionId) active.collectionId = collectionId;
}

async function refreshSnapshotPreservingDrafts(): Promise<void> {
  const fresh = await invoke<AppSnapshot>("get_app_snapshot");
  const drafts = snapshot.snippets.filter((snippet) => isDraftSnippetId(snippet.id));
  snapshot = fresh;
  if (drafts.length > 0) {
    snapshot.snippets = [...drafts, ...snapshot.snippets];
  }
  preserveRenderedEditorState();
  pruneSnippetSelection();
}

async function runSearchKeepingPage(): Promise<void> {
  const page = currentPage;
  await performSearch();
  currentPage = page;
}

function closeBulkActionModals(): void {
  bulkMoveModalOpen = false;
  bulkTagModalOpen = false;
}

function closeSnippetTab(id: string): void {
  const index = openSnippetIds.indexOf(id);
  if (index < 0) return;

  const snippet = snapshot.snippets.find((item) => item.id === id);
  if (snippet?.id.startsWith("new-") && !snippet.title && !snippet.content) {
    snapshot.snippets = snapshot.snippets.filter((item) => item.id !== id);
    searchResults = searchResults.filter((result) => result.snippet.id !== id);
  }

  openSnippetIds.splice(index, 1);
  if (activeSnippetId === id) {
    activeSnippetId = openSnippetIds[index] || openSnippetIds[index - 1] || null;
  }
}

function renderSnippetTabs(): string {
  return `
    <div class="snippet-tabs-bar">
      <div class="snippet-tabs" role="tablist" aria-label="Open snippets">
        ${openSnippetIds
          .map((id) => snapshot.snippets.find((snippet) => snippet.id === id))
          .filter((snippet): snippet is Snippet => Boolean(snippet))
          .map((snippet) => `
            <button
              type="button"
              class="snippet-tab ${snippet.id === activeSnippetId ? "active" : ""}"
              data-snippet-tab="${escapeHtml(snippet.id)}"
              role="tab"
              aria-selected="${snippet.id === activeSnippetId}"
              title="${escapeHtml(snippet.title || "Untitled Snippet")}"
            >
              <span class="snippet-tab-title">${escapeHtml(snippet.title || "Untitled Snippet")}</span>
              <span class="snippet-tab-close" data-close-snippet-tab="${escapeHtml(snippet.id)}" aria-label="Close tab" title="Close tab">${icon("close")}</span>
            </button>
          `).join("")}
      </div>
      ${activeSnippetId ? `
        <button
          type="button"
          class="snippet-details-toggle ${detailHeaderCollapsed ? "collapsed" : ""}"
          id="btn-toggle-detail-header"
          aria-expanded="${!detailHeaderCollapsed}"
          title="${detailHeaderCollapsed ? "Show snippet details" : "Hide snippet details"}"
        >
          ${icon("chevron")}
          <span>${detailHeaderCollapsed ? "Show details" : "Hide details"}</span>
        </button>
      ` : ""}
    </div>
  `;
}

function renderRelatedSnippetsPanel(snippet: Snippet): string {
  if (snippet.id.startsWith("new-")) return "";
  const isCurrent = relatedSnippetId === snippet.id;
  const body = relatedSnippetsLoading && isCurrent
    ? `<div class="related-snippets-message">Finding related snippets…</div>`
    : relatedSnippetsError && isCurrent
    ? `<div class="related-snippets-message related-snippets-error">${escapeHtml(relatedSnippetsError)}</div>`
    : isCurrent && relatedSnippets.length > 0
    ? `<div class="related-snippets-scroll">${relatedSnippets.map((result) => {
        const collection = snapshot.collections.find((item) => item.id === result.snippet.collectionId);
        return `
          <button type="button" class="related-snippet-card" data-related-snippet="${escapeHtml(result.snippet.id)}">
            <span class="related-snippet-title">${escapeHtml(result.snippet.title || "Untitled Snippet")}</span>
            <span class="related-snippet-preview">${escapeHtml(result.snippet.content.slice(0, 100).replace(/\s+/g, " ") || "Empty snippet")}</span>
            <span class="related-snippet-meta">
              <span>${escapeHtml(collection?.name || "Default")}</span>
              <span title="Hybrid relevance score">Score ${Math.round(result.score * 100)}</span>
            </span>
          </button>
        `;
      }).join("")}</div>`
    : `<div class="related-snippets-message">No related snippets found.</div>`;

  return `
    <section class="related-snippets-panel" id="related-snippets-panel" aria-label="Related snippets">
      <div class="related-snippets-heading">${icon("sparkles")} Related snippets</div>
      ${body}
    </section>
  `;
}

function attachRelatedSnippetListeners(): void {
  document.querySelectorAll<HTMLElement>("[data-related-snippet]").forEach((card) => {
    card.addEventListener("click", () => {
      const id = card.dataset.relatedSnippet;
      if (!id) return;
      openSnippet(id);
      render();
      void loadRelatedSnippets(id);
    });
  });
}

function updateRelatedSnippetsPanel(): void {
  const activeSnippet = getActiveSnippet();
  const currentPanel = document.getElementById("related-snippets-panel");
  if (!activeSnippet || activeSnippet.id.startsWith("new-")) {
    currentPanel?.remove();
    return;
  }
  const markup = renderRelatedSnippetsPanel(activeSnippet);
  if (currentPanel) currentPanel.outerHTML = markup;
  else document.querySelector(".detail-keywords-row")?.insertAdjacentHTML("afterend", markup);
  attachRelatedSnippetListeners();
}

async function loadRelatedSnippets(id: string): Promise<void> {
  if (id.startsWith("new-")) return;
  const requestId = ++relatedSnippetsRequestId;
  relatedSnippetId = id;
  relatedSnippets = [];
  relatedSnippetsError = "";
  relatedSnippetsLoading = true;
  updateRelatedSnippetsPanel();

  try {
    const results = await invoke<SearchResult[]>("get_related_snippets", { id });
    if (requestId !== relatedSnippetsRequestId) return;
    relatedSnippets = results.slice(0, 10);
  } catch (error) {
    if (requestId !== relatedSnippetsRequestId) return;
    relatedSnippetsError = String(error);
  } finally {
    if (requestId === relatedSnippetsRequestId) {
      relatedSnippetsLoading = false;
      updateRelatedSnippetsPanel();
    }
  }
}

interface SingleSelectOption {
  value: string;
  label: string;
}

function renderSingleSelect(
  id: string,
  value: string,
  options: SingleSelectOption[],
  extraClass = ""
): string {
  const selectedOption = options.find((option) => option.value === value) || options[0];
  const isOpen = openSelectId === id;

  return `
    <div class="single-select ${extraClass}" data-select-picker="${escapeHtml(id)}" data-selected-value="${escapeHtml(value)}">
      <button
        type="button"
        class="single-select-trigger"
        data-select-trigger="${escapeHtml(id)}"
        aria-haspopup="listbox"
        aria-expanded="${isOpen}"
      >
        <span class="single-select-trigger-label">${escapeHtml(selectedOption?.label || "Select…")}</span>
        ${icon("chevron", "single-select-chevron")}
      </button>
      <div class="single-select-options" role="listbox" ${isOpen ? "" : "hidden"}>
        ${options
          .map(
            (option) => `
          <button
            type="button"
            class="single-select-option ${option.value === value ? "selected" : ""}"
            data-select-option="${escapeHtml(option.value)}"
            role="option"
            aria-selected="${option.value === value}"
          >
            <span class="single-select-option-label">${escapeHtml(option.label)}</span>
            ${option.value === value ? icon("check") : ""}
          </button>
        `
          )
          .join("")}
      </div>
    </div>
  `;
}

function updateSingleSelectDisplay(picker: HTMLElement, value: string): void {
  picker.dataset.selectedValue = value;
  const options = Array.from(
    picker.querySelectorAll<HTMLButtonElement>("[data-select-option]")
  );
  const selectedOption = options.find(
    (option) => option.getAttribute("data-select-option") === value
  );
  const label = picker.querySelector<HTMLElement>(".single-select-trigger-label");
  if (label && selectedOption) {
    label.textContent = selectedOption.querySelector(".single-select-option-label")?.textContent || "";
  }

  options.forEach((option) => {
    const selected = option === selectedOption;
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-selected", String(selected));
    const check = option.querySelector<HTMLElement>(".icon");
    if (selected && !check) option.insertAdjacentHTML("beforeend", icon("check"));
    if (!selected && check) check.remove();
  });

  const trigger = picker.querySelector<HTMLButtonElement>("[data-select-trigger]");
  const optionsList = picker.querySelector<HTMLElement>(".single-select-options");
  if (trigger) trigger.setAttribute("aria-expanded", "false");
  if (optionsList) optionsList.hidden = true;
}

function setSingleSelectOpen(id: string | null): void {
  openSelectId = id;
  document.querySelectorAll<HTMLElement>("[data-select-picker]").forEach((picker) => {
    const isOpen = picker.getAttribute("data-select-picker") === id;
    picker.querySelector<HTMLButtonElement>("[data-select-trigger]")?.setAttribute(
      "aria-expanded",
      String(isOpen)
    );
    const options = picker.querySelector<HTMLElement>(".single-select-options");
    if (options) options.hidden = !isOpen;
  });
}

function closeFilterPopovers(): void {
  collectionPopoverOpen = false;
  datePopoverOpen = false;
  document.getElementById("popover-collection")?.setAttribute("hidden", "");
  document.getElementById("popover-date")?.setAttribute("hidden", "");
}

function getVisibleKeywords(): string[] {
  const query = keywordSearchQuery.trim().toLowerCase().replace(/^#/, "");
  if (!query) return snapshot.keywords;
  return snapshot.keywords.filter((keyword) => keyword.toLowerCase().includes(query));
}

function renderExportModal(): string {
  if (!exportModalState.isOpen) return "";

  const snippetCount = exportModalState.snippetIds.length;
  const isSingle = snippetCount === 1;
  const singleSnippet = isSingle
    ? snapshot.snippets.find((s) => s.id === exportModalState.snippetIds[0])
    : null;
  const singleTitle = singleSnippet?.title || "Untitled";
  const scopeText = isSingle
    ? `Single Snippet: <strong>${escapeHtml(singleTitle)}</strong>`
    : `Multiple Snippets: <strong>${snippetCount} selected</strong>`;

  const formatsCount = exportModalState.formats.size;

  return `
    <div class="modal-overlay" id="modal-export">
      <div class="modal-card export-modal-card" role="dialog" aria-modal="true" aria-labelledby="export-modal-title">
        <div class="modal-header">
          <div class="modal-title">
            ${icon("download")}
            <span id="export-modal-title">${exportModalState.isExporting ? "Exporting Snippets…" : "Export Snippets"}</span>
          </div>
          ${
            exportModalState.isExporting
              ? ""
              : `
          <button type="button" class="modal-close-btn" id="btn-close-export">
            ${icon("close")}
          </button>
          `
          }
        </div>

        ${
          exportModalState.isExporting
            ? `
        <div class="modal-body">
          <div class="export-progress-panel">
            <div class="export-progress-spinner-wrap">
              <div class="export-spinner"></div>
              <div class="export-spinner-icon">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
              </div>
            </div>

            <div class="export-progress-title">Generating Export Document…</div>
            <div class="export-progress-stage" id="export-progress-stage">${escapeHtml(exportModalState.progressStage || "Processing on background thread…")}</div>

            <div class="export-progress-bar-wrap">
              <div class="export-progress-bar-fill" id="export-progress-bar-fill" style="width: ${Math.max(5, exportModalState.progressPercent)}%;"></div>
            </div>

            <div class="export-progress-meta">
              <span id="export-progress-counts">${exportModalState.progressCurrent > 0 ? `${exportModalState.progressCurrent} of ${exportModalState.progressTotal} processed` : "Preparing background worker…"}</span>
              <span id="export-progress-percent" style="font-weight: 700; color: var(--text-primary);">${exportModalState.progressPercent}%</span>
            </div>

            <div class="export-progress-note">
              <span class="pulse-dot"></span>
              Running on a dedicated background thread to keep SnippetBox fluid.
            </div>
          </div>
        </div>

        <div class="modal-footer" style="justify-content: center;">
          <span style="font-size: 11.5px; color: var(--text-muted); display: inline-flex; align-items: center; gap: 8px;">
            <span class="spinner-inline"></span>
            Please keep this dialog open while your files are generated…
          </span>
        </div>
        `
            : `
        <div class="modal-body">
          <div class="export-summary-box">
            <span>Scope: ${scopeText}</span>
            <span>${isSingle && singleSnippet ? escapeHtml((singleSnippet.language || "text").toUpperCase()) : `${snippetCount} items`}</span>
          </div>

          <div style="font-size: 11.5px; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px;">
            Choose Format(s) — select one or multiple:
          </div>

          <div class="export-formats-list">
            <!-- PDF Document Card -->
            <label class="export-format-card ${exportModalState.formats.has("pdf") ? "selected" : ""}" data-format-card="pdf">
              <input type="checkbox" class="export-format-checkbox" data-export-format="pdf" ${exportModalState.formats.has("pdf") ? "checked" : ""} />
              <div class="export-format-icon" style="color: var(--rose);">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                  <line x1="16" y1="13" x2="8" y2="13"></line>
                  <line x1="16" y1="17" x2="8" y2="17"></line>
                  <polyline points="10 9 9 9 8 9"></polyline>
                </svg>
              </div>
              <div class="export-format-info">
                <div class="export-format-title-row">
                  <span class="export-format-title">PDF Document</span>
                  <span class="export-format-badge">.pdf</span>
                  <span class="export-format-badge" style="background: rgba(244, 63, 94, 0.12); color: var(--rose); border-color: rgba(244, 63, 94, 0.25);">Default</span>
                </div>
                <div class="export-format-desc">
                  Beautiful publication with cover banner, metadata cards, clean typography, code blocks with line numbers, and pagination.
                </div>
              </div>
            </label>

            <!-- HTML Card -->
            <label class="export-format-card ${exportModalState.formats.has("html") ? "selected" : ""}" data-format-card="html">
              <input type="checkbox" class="export-format-checkbox" data-export-format="html" ${exportModalState.formats.has("html") ? "checked" : ""} />
              <div class="export-format-icon" style="color: var(--cyan);">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="2" y1="12" x2="22" y2="12"></line>
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
                </svg>
              </div>
              <div class="export-format-info">
                <div class="export-format-title-row">
                  <span class="export-format-title">Self-Contained HTML</span>
                  <span class="export-format-badge">.html</span>
                  <span class="export-format-badge" style="background: rgba(6, 182, 212, 0.12); color: var(--cyan); border-color: rgba(6, 182, 212, 0.25);">Interactive Web</span>
                </div>
                <div class="export-format-desc">
                  Stunning standalone webpage with dark/light mode toggle, instant search, syntax highlighting, and copy buttons.
                </div>
              </div>
            </label>

            <!-- JSON Card -->
            <label class="export-format-card ${exportModalState.formats.has("json") ? "selected" : ""}" data-format-card="json">
              <input type="checkbox" class="export-format-checkbox" data-export-format="json" ${exportModalState.formats.has("json") ? "checked" : ""} />
              <div class="export-format-icon" style="color: var(--amber);">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="16 18 22 12 16 6"></polyline>
                  <polyline points="8 6 2 12 8 18"></polyline>
                </svg>
              </div>
              <div class="export-format-info">
                <div class="export-format-title-row">
                  <span class="export-format-title">JSON Data</span>
                  <span class="export-format-badge">.json</span>
                  <span class="export-format-badge" style="background: rgba(245, 158, 11, 0.12); color: var(--amber); border-color: rgba(245, 158, 11, 0.25);">Structured</span>
                </div>
                <div class="export-format-desc">
                  Complete raw data with all snippet fields, collections, tags, and timestamps. Ideal for backups and importing back into SnippetBox.
                </div>
              </div>
            </label>
          </div>

          <div class="export-filename-group">
            <label for="export-base-filename">Export Filename (without extension)</label>
            <input
              type="text"
              id="export-base-filename"
              value="${escapeHtml(exportModalState.baseFilename)}"
              placeholder="snippets-export"
            />
            <div class="export-hint">
              ${
                formatsCount === 1
                  ? `A save dialog will ask where to save <strong>${escapeHtml(exportModalState.baseFilename)}.${Array.from(exportModalState.formats)[0]}</strong>.`
                  : formatsCount > 1
                  ? `A folder picker will prompt for a destination directory, and save all ${formatsCount} chosen files there.`
                  : `<span style="color:var(--rose);">Please select at least one format above.</span>`
              }
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn-detail-action" id="btn-cancel-export">Cancel</button>
          <button type="button" class="btn-detail-action btn-save" id="btn-confirm-export" ${formatsCount === 0 ? "disabled" : ""}>
            ${icon("download")} Export (${formatsCount} ${formatsCount === 1 ? "format" : "formats"})
          </button>
        </div>
        `
        }
      </div>
    </div>
  `;
}

function renderExportSuccessModal(): string {
  if (!exportSuccessState.isOpen) return "";

  return `
    <div class="modal-overlay" id="modal-export-success">
      <div class="modal-card export-modal-card" role="dialog" aria-modal="true" aria-labelledby="export-success-title">
        <div class="modal-header">
          <div class="modal-title" style="color: var(--mint);">
            ${icon("check")}
            <span id="export-success-title">Export Completed</span>
          </div>
          <button type="button" class="modal-close-btn" id="btn-close-export-success">
            ${icon("close")}
          </button>
        </div>

        <div class="modal-body">
          <div class="export-success-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
          <div style="text-align:center;font-weight:600;font-size:14px;color:var(--text-primary);margin-bottom:4px;">
            Files Saved Successfully
          </div>
          <div style="text-align:center;font-size:12px;color:var(--text-muted);margin-bottom:14px;">
            Exported <strong>${exportSuccessState.snippetCount}</strong> ${exportSuccessState.snippetCount === 1 ? "snippet" : "snippets"} across <strong>${exportSuccessState.files.length}</strong> ${exportSuccessState.files.length === 1 ? "format" : "formats"}.
          </div>

          <div class="export-success-files">
            ${exportSuccessState.files
              .map(
                (f) => `
              <div class="export-file-item">
                <div class="export-file-meta">
                  <div class="export-file-name-row">
                    <span class="export-file-format-badge badge-${f.format}">${f.format.toUpperCase()}</span>
                    <span class="export-file-name" title="${escapeHtml(f.filename)}">${escapeHtml(f.filename)}</span>
                  </div>
                  <div class="export-file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</div>
                </div>
                <div class="export-file-actions">
                  <button type="button" class="btn-file-action btn-open-exported-file" data-file-path="${escapeHtml(f.path)}" title="Open file">
                    Open
                  </button>
                  <button type="button" class="btn-file-action btn-reveal-exported-file" data-file-path="${escapeHtml(f.path)}" title="Reveal in folder">
                    Reveal
                  </button>
                </div>
              </div>
            `
              )
              .join("")}
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn-detail-action btn-save" id="btn-done-export-success">Done</button>
        </div>
      </div>
    </div>
  `;
}

// Render UI
function render() {
  const app = document.getElementById("app");
  if (!app) return;

  const prevSidebarScrollTop = document.querySelector(".sidebar-scroll")?.scrollTop ?? 0;
  const prevTagCloudScrollTop = document.querySelector(".tag-cloud")?.scrollTop ?? 0;
  const sameSnippet = lastRenderedSnippetId === activeSnippetId;
  const prevEditorScrollTop = sameSnippet
    ? (document.getElementById("editor-textarea") as HTMLTextAreaElement)?.scrollTop ?? 0
    : 0;
  const prevPreviewScrollTop = sameSnippet
    ? (document.querySelector(".preview-pane") as HTMLElement)?.scrollTop ?? 0
    : 0;

  const platform = isMac ? "macos" : "windows";
  const activeSnippet = getActiveSnippet();
  const editorMode = snapshot.settings.editorMode || "split";
  const savedSnippets = snapshot.snippets.filter((snippet) => !snippet.id.startsWith("new-"));

  const totalPages = Math.max(1, Math.ceil(searchResults.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const endIndex = Math.min(startIndex + PAGE_SIZE, searchResults.length);
  const paginatedResults = searchResults.slice(startIndex, endIndex);
  const pageSnippetIds = paginatedResults.map((result) => result.snippet.id);
  const pageAllSelected =
    pageSnippetIds.length > 0 && pageSnippetIds.every((id) => selectedSnippetIds.has(id));
  const pageSomeSelected = pageSnippetIds.some((id) => selectedSnippetIds.has(id));
  const unfavoriteSelected = allSelectedAreFavorited();

  app.innerHTML = `
    <!-- Window Titlebar -->
    <header class="window-titlebar" data-platform="${platform}" data-tauri-drag-region>
      <div class="titlebar-leading">
        <img class="titlebar-brand-mark" src="${brandLogo}" alt="" width="24" height="24" draggable="false" />
        <span class="titlebar-title">SnippetBox</span>
        <span class="titlebar-publisher">| GoodApps (hello@goodapps.store)</span>
      </div>

      <div class="titlebar-trailing">
        <div class="window-controls">
          <button class="window-control-btn window-control-minimize" id="btn-win-min" title="Minimize">
            ${icon("minimize")}
          </button>
          <button class="window-control-btn window-control-maximize" id="btn-win-max" title="Maximize">
            ${icon("maximize")}
          </button>
          <button class="window-control-btn window-control-close" id="btn-win-close" title="Close">
            ${icon("close")}
          </button>
        </div>
      </div>
    </header>

    <!-- Main Shell -->
    <div
      class="app-shell"
      data-view="split"
      data-snippets-pane-collapsed="${snippetsPaneCollapsed}"
    >
      <!-- Sidebar -->
      <aside class="sidebar">
        <div class="sidebar-create-actions">
          <button class="btn-new-snippet" id="btn-new-snippet">
            <span style="display:flex;align-items:center;gap:6px;">
              ${icon("plus")} New Snippet
            </span>
            <span class="key-shortcut">${isMac ? "⌘N" : "Ctrl+N"}</span>
          </button>
          <button
            class="btn-import-snippets"
            id="btn-import-snippets"
            title="Import text files"
            aria-label="Import text files"
          >
            ${icon("upload")}
          </button>
          <div class="text-import-status" id="text-import-status" ${textImportJobs.some(isActiveTextImport) ? "" : "hidden"}>
            ${renderTextImportStatus()}
          </div>
        </div>

        <div class="sidebar-scroll ${snapshot.keywords.length > 0 ? "has-keywords" : ""}">
          <!-- Library Navigation -->
          <div class="sidebar-section sidebar-library-section">
            <div class="sidebar-heading">Library</div>
            <button class="nav-item ${!filterState.favoriteOnly && (!filterState.collectionIds || filterState.collectionIds.length === 0) ? "active" : ""}" id="nav-all">
              ${icon("layers")}
              <span>All Snippets</span>
              <span class="nav-count">${savedSnippets.length}</span>
            </button>
            <button class="nav-item ${filterState.favoriteOnly ? "active" : ""}" id="nav-favorites">
              ${icon("star-filled", "active-star")}
              <span>Favorites</span>
              <span class="nav-count">${savedSnippets.filter((s) => s.favorite).length}</span>
            </button>
          </div>

          <!-- Collections -->
          <div class="sidebar-section sidebar-collections-section">
            <div class="sidebar-heading">
              <span>Collections</span>
              <button class="sidebar-heading-action" id="btn-add-collection" title="New Collection">
                ${icon("plus")}
              </button>
            </div>
            <div id="collections-list" class="collections-list">
              ${snapshot.collections
                .map((col) => {
                  const count = savedSnippets.filter(
                    (s) => s.collectionId === col.id
                  ).length;
                  const isSelected =
                    filterState.collectionIds?.includes(col.id) &&
                    filterState.collectionIds.length === 1;

                  return `
                    <div class="nav-item ${isSelected ? "active" : ""}" data-collection-id="${col.id}">
                      <span class="collection-dot" style="background-color: ${escapeHtml(col.color)};"></span>
                      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(col.name)}</span>
                      <span class="nav-count nav-count-collection">${count}</span>
                      ${
                        col.id !== "default"
                          ? `<div class="collection-actions">
                              <button type="button" class="collection-action-btn" data-rename-collection="${col.id}" title="Rename collection" aria-label="Rename ${escapeHtml(col.name)}">
                                ${icon("edit")}
                              </button>
                              <button class="collection-action-btn" data-delete-collection="${col.id}" title="Delete collection">
                                ${icon("trash")}
                              </button>
                            </div>`
                          : ""
                      }
                    </div>
                  `;
                })
                .join("")}
            </div>
          </div>

          <!-- Extracted Keywords Cloud -->
          ${
            snapshot.keywords.length > 0
              ? `
            <div class="sidebar-section sidebar-keywords-section">
              <div class="sidebar-heading">
                <span>Popular Keywords</span>
                <span class="keyword-count">${getVisibleKeywords().length}/${snapshot.keywords.length}</span>
              </div>
              <div class="keyword-search-wrap">
                ${icon("search")}
                <input
                  type="search"
                  id="keyword-search-input"
                  class="keyword-search-input"
                  value="${escapeHtml(keywordSearchQuery)}"
                  placeholder="Search keywords…"
                  autocomplete="off"
                  aria-label="Search popular keywords"
                />
              </div>
              <div class="tag-cloud">
                ${getVisibleKeywords()
                  .map(
                    (kw) => `
                    <span class="tag-badge ${filterState.query === kw ? "active" : ""}" data-keyword-filter="${escapeHtml(kw)}">
                      #${escapeHtml(kw)}
                    </span>
                  `
                  )
                  .join("") || `<div class="keywords-empty">No matching keywords</div>`}
              </div>
            </div>
          `
              : ""
          }
        </div>

        <!-- Sidebar Footer -->
        <div class="sidebar-footer">
          <button class="btn-sidebar-settings" id="btn-open-settings" title="Application Settings">
            ${icon("settings")}
            <span>Settings</span>
          </button>
          <button class="btn-sidebar-settings" id="btn-open-backup-sidebar" title="Backup &amp; Restore Data">
            ${icon("database")}
            <span>Backup</span>
          </button>
        </div>
      </aside>

      <!-- Snippets Browser (Middle Column) -->
      <section class="snippets-pane" aria-label="Snippets browser">
        <button
          type="button"
          class="snippets-pane-toggle ${snippetsPaneCollapsed ? "collapsed" : ""}"
          id="btn-toggle-snippets-pane"
          aria-controls="snippets-pane-content"
          aria-expanded="${!snippetsPaneCollapsed}"
          title="${snippetsPaneCollapsed ? "Show snippets browser" : "Hide snippets browser"}"
        >
          ${icon(snippetsPaneCollapsed ? "chevron-right" : "chevron-left")}
          <span class="sr-only">${snippetsPaneCollapsed ? "Show snippets browser" : "Hide snippets browser"}</span>
        </button>
        <div class="snippets-pane-content" id="snippets-pane-content">
        <div class="snippets-pane-header">
          <!-- Search Bar -->
          <div class="search-container">
            <div class="search-input-wrap">
              ${icon("search", "search-icon")}
              <input
                type="text"
                class="search-input"
                id="search-input"
                placeholder="Search snippets (Cmd+K)..."
                value="${escapeHtml(filterState.query || "")}"
                autocomplete="off"
              />
              ${
                filterState.query
                  ? `<button class="search-clear-btn" id="btn-clear-search">${icon("close")}</button>`
                  : ""
              }
            </div>
          </div>

          <!-- Search Mode Selector -->
          <div class="search-mode-selector">
            <button class="search-mode-btn ${filterState.searchMode === "hybrid" ? "active" : ""}" data-search-mode="hybrid" title="Combine semantic vectors and keywords">
              ${icon("sparkles")} Hybrid
            </button>
            <button class="search-mode-btn ${filterState.searchMode === "semantic" ? "active" : ""}" data-search-mode="semantic" title="Vector similarity search">
              ${icon("cpu")} Semantic
            </button>
            <button class="search-mode-btn ${filterState.searchMode === "keyword" ? "active" : ""}" data-search-mode="keyword" title="Exact FTS5 keyword matching">
              ${icon("file-text")} Keyword
            </button>
          </div>

          <!-- Filter Row -->
          <div class="filter-bar">
            <!-- Collections Multi-Select Filter -->
            <div class="filter-picker">
              <button class="filter-chip ${(filterState.collectionIds && filterState.collectionIds.length > 0) ? "active" : ""}" id="btn-filter-collection">
                ${icon("folder")}
                <span>${getCollectionsFilterLabel()}</span>
                ${icon("chevron", "filter-chevron")}
              </button>
              <div class="filter-popover" id="popover-collection" ${collectionPopoverOpen ? "" : "hidden"}>
                <div class="filter-popover-title">
                  <span>Filter Collections</span>
                  <span style="font-size:10px;color:var(--text-muted);">${(filterState.collectionIds || []).length} selected</span>
                </div>
                <div class="filter-options-list">
                  ${snapshot.collections
                    .map(
                      (c) => `
                      <label class="filter-option">
                        <input type="checkbox" data-filter-col-id="${c.id}" ${filterState.collectionIds?.includes(c.id) ? "checked" : ""}/>
                        <span class="collection-dot" style="background-color:${c.color};"></span>
                        <span class="filter-option-name">${escapeHtml(c.name)}</span>
                      </label>
                    `
                    )
                    .join("")}
                </div>
                ${
                  filterState.collectionIds && filterState.collectionIds.length > 0
                    ? `<button class="filter-popover-clear-btn" id="btn-clear-col-filter">Clear Collections</button>`
                    : ""
                }
              </div>
            </div>



            <!-- Date Added Filter -->
            <div class="filter-picker date-filter-picker">
              <button class="filter-chip ${filterState.dateFrom || filterState.dateTo ? "active" : ""}" id="btn-filter-date">
                ${icon("calendar")}
                <span>${getDateFilterLabel()}</span>
                ${icon("chevron", "filter-chevron")}
              </button>
              <div class="filter-popover date-filter-popover" id="popover-date" ${datePopoverOpen ? "" : "hidden"}>
                <div class="filter-popover-title">Date Added</div>
                <div class="date-presets">
                  <button class="date-preset-btn" data-date-preset="today">Today</button>
                  <button class="date-preset-btn" data-date-preset="7d">Last 7 Days</button>
                  <button class="date-preset-btn" data-date-preset="30d">Last 30 Days</button>
                  <button class="date-preset-btn" data-date-preset="all">All Time</button>
                </div>
                <div class="date-inputs-row">
                  <div class="date-input-group">
                    <label>From</label>
                    <input type="date" id="date-from-input" value="${filterState.dateFrom || ""}"/>
                  </div>
                  <div class="date-input-group">
                    <label>To</label>
                    <input type="date" id="date-to-input" value="${filterState.dateTo || ""}"/>
                  </div>
                </div>
                ${
                  filterState.dateFrom || filterState.dateTo
                    ? `<button class="filter-popover-clear-btn" id="btn-clear-date-filter">Clear Dates</button>`
                    : ""
                }
              </div>
            </div>

            <!-- Favorites Filter Chip -->
            <button class="filter-chip ${filterState.favoriteOnly ? "active" : ""}" id="btn-filter-fav">
              ${icon("star")} Favorite
            </button>

            <!-- Clear All Active Filters -->
            ${
              hasActiveFilters()
                ? `<button class="filter-chip clear-filters-chip" id="btn-clear-all-filters">
                    ${icon("close")} Reset
                  </button>`
                : ""
            }
          </div>
        </div>

        <!-- Subrow: Count, Sort, View segmented -->
        <div class="snippets-subbar">
          <div class="subbar-count">
            ${
              paginatedResults.length > 0
                ? `<label class="select-all-control" title="Select all on this page">
                    <input
                      type="checkbox"
                      id="btn-select-page"
                      ${pageAllSelected ? "checked" : ""}
                      ${pageSomeSelected && !pageAllSelected ? "data-indeterminate='true'" : ""}
                    />
                    <span class="snippets-count">${searchResults.length} ${searchResults.length === 1 ? "snippet" : "snippets"}</span>
                  </label>`
                : `<span class="snippets-count">${searchResults.length} ${searchResults.length === 1 ? "snippet" : "snippets"}</span>`
            }
          </div>
          <div class="subbar-actions">
            ${renderSingleSelect("sort-select", filterState.sortBy, SORT_OPTIONS, "sort-single-select")}
          </div>
        </div>

        <!-- Batch Action Bar if items selected -->
        ${
          selectedSnippetIds.size > 0
            ? `
          <div class="batch-bar">
            <div class="batch-bar-meta">
              <span>${selectedSnippetIds.size} selected</span>
              ${
                searchResults.length > selectedSnippetIds.size
                  ? `<button type="button" class="batch-link" id="btn-select-all-results">Select all ${searchResults.length}</button>`
                  : ""
              }
              <button type="button" class="batch-link" id="btn-clear-selection">Clear</button>
            </div>
            <div class="batch-buttons">
              <button type="button" class="batch-btn" id="btn-batch-move">${icon("folder")} Move</button>
              <button type="button" class="batch-btn" id="btn-batch-tag">${icon("tag")} Tag</button>
              <button type="button" class="batch-btn" id="btn-batch-favorite">${unfavoriteSelected ? icon("star-filled") : icon("star")} ${unfavoriteSelected ? "Unfavorite" : "Favorite"}</button>
              <button type="button" class="batch-btn" id="btn-batch-export">${icon("download")} Export</button>
              <button type="button" class="batch-btn batch-btn-danger" id="btn-batch-delete">${icon("trash")} Delete</button>
            </div>
          </div>
        `
            : ""
        }

        <!-- Snippet Cards List -->
        <div class="snippets-list-scroll" id="snippets-list">
          ${
            searchResults.length === 0
              ? `
              <div style="padding: 40px 20px; text-align: center; color: var(--text-muted);">
                <div style="font-size: 28px; margin-bottom: 10px;">🔍</div>
                <div style="font-weight: 600; font-size: 14px; margin-bottom: 4px; color: var(--text-primary);">No snippets found</div>
                <div style="font-size: 12px;">Try adjusting your search terms or filters.</div>
              </div>
            `
              : paginatedResults
                  .map((res) => {
                    const snip = res.snippet;
                    const isActive = snip.id === activeSnippetId;
                    const isMultiSelected = selectedSnippetIds.has(snip.id);
                    const collection = snapshot.collections.find(
                      (c) => c.id === snip.collectionId
                    );
                    const colColor = collection?.color || "#10b981";
                    const colName = collection?.name || "Default";

                    // Snippet preview excerpt
                    const excerpt =
                      res.highlight ||
                      snip.content.slice(0, 160).replace(/\n/g, " ") ||
                      "Empty snippet...";

                    return `
                      <div class="snippet-card ${isActive ? "active" : ""} ${isMultiSelected ? "multi-selected" : ""}" data-snippet-id="${snip.id}">
                        <div class="card-top">
                          <label class="card-select" title="Select snippet">
                            <input type="checkbox" data-select-snippet="${snip.id}" ${isMultiSelected ? "checked" : ""} />
                          </label>
                          <span class="card-title">${escapeHtml(snip.title || "Untitled Snippet")}</span>
                          <div class="card-badges">
                            <button class="card-action-btn ${snip.favorite ? "active-star" : ""}" data-toggle-fav="${snip.id}" title="Toggle favorite">
                              ${snip.favorite ? icon("star-filled") : icon("star")}
                            </button>
                          </div>
                        </div>

                        <div class="card-preview">${excerpt}</div>

                        ${
                          snip.tags && snip.tags.length > 0
                            ? `
                          <div class="card-tags">
                            ${snip.tags
                              .slice(0, 4)
                              .map(
                                (t) => `
                              <span class="card-tag-pill ${filterState.query === t ? "active" : ""}" data-card-tag="${escapeHtml(t)}" title="Filter by #${escapeHtml(t)}">#${escapeHtml(t)}</span>
                            `
                              )
                              .join("")}
                            ${snip.tags.length > 4 ? `<span class="card-tag-more">+${snip.tags.length - 4}</span>` : ""}
                          </div>
                        `
                            : ""
                        }

                        <div class="card-bottom">
                          <div class="card-meta-left">
                            <span class="card-collection-pill">
                              <span class="collection-dot" style="background-color: ${colColor};"></span>
                              ${escapeHtml(colName)}
                            </span>
                            ${
                              res.score && filterState.query
                                ? `<span class="card-score-pill" title="Relative relevance score; not a match probability">Score ${(res.score * 100).toFixed(0)}</span>`
                                : ""
                            }
                          </div>

                          <div class="card-actions">
                            <button class="card-action-btn" data-copy-snippet="${snip.id}" title="Copy snippet content">
                              ${icon("copy")}
                            </button>
                            <button class="card-action-btn" data-delete-snippet="${snip.id}" title="Delete snippet">
                              ${icon("trash")}
                            </button>
                          </div>
                        </div>
                      </div>
                    `;
                  })
                  .join("")
          }
        </div>

        <!-- Snippets Pagination Footer -->
        <div class="snippets-pagination">
          <span class="pagination-info">
            ${
              searchResults.length === 0
                ? "0 snippets"
                : `${startIndex + 1}–${endIndex} of ${searchResults.length}`
            }
          </span>
          <div class="pagination-controls">
            <button
              class="pagination-btn"
              id="btn-page-prev"
              ${currentPage <= 1 ? "disabled" : ""}
              title="Previous page"
            >
              ${icon("chevron-left")}
            </button>
            <span class="pagination-pages">${currentPage} / ${totalPages}</span>
            <button
              class="pagination-btn"
              id="btn-page-next"
              ${currentPage >= totalPages ? "disabled" : ""}
              title="Next page"
            >
              ${icon("chevron-right")}
            </button>
          </div>
        </div>
        </div>
      </section>

      <!-- Snippet Detail / Editor & Markdown Viewer Pane -->
      <main class="snippet-detail-pane">
        ${renderSnippetTabs()}
        ${
          activeSnippet
            ? `
          <div class="detail-header ${detailHeaderCollapsed ? "collapsed" : ""}">
            <input
              type="text"
              class="detail-title-input"
              id="detail-title"
              value="${escapeHtml(activeSnippet.title)}"
              placeholder="Snippet title..."
            />

            <div class="detail-meta-row">
              <div class="meta-field">
                <label>Collection:</label>
                ${renderSingleSelect(
                  "detail-collection",
                  activeSnippet.collectionId,
                  snapshot.collections.map((c) => ({ value: c.id, label: c.name })),
                  "detail-collection-select"
                )}
              </div>

              <div class="detail-tag-input-wrap">
                <label style="font-size:11px;color:var(--text-muted);">Tags:</label>
                <input
                  type="text"
                  class="detail-tag-input"
                  id="detail-tags"
                  value="${escapeHtml(activeSnippet.tags.join(", "))}"
                  placeholder="Comma separated tags..."
                />
              </div>
            </div>

            <!-- Keyword pills -->
            ${
              activeSnippet.keywords && activeSnippet.keywords.length > 0
                ? `
              <div class="detail-keywords-row">
                <div class="keywords-pills">
                  ${activeSnippet.keywords
                    .map(
                      (kw) => `
                    <span class="keyword-pill ${filterState.query === kw ? "active" : ""}" data-keyword-filter="${escapeHtml(kw)}" title="Filter by #${escapeHtml(kw)}">
                      #${escapeHtml(kw)}
                    </span>
                  `
                    )
                    .join("")}
                </div>
              </div>
            `
                : ""
            }

            ${renderRelatedSnippetsPanel(activeSnippet)}

            <div class="detail-actions-row">
              <div class="editor-mode-wrap">
                <div class="editor-mode-tabs">
                  <button class="editor-tab-btn ${editorMode === "split" ? "active" : ""}" data-editor-mode="split">
                    ${icon("split")} Split View
                  </button>
                  <button class="editor-tab-btn ${editorMode === "edit" ? "active" : ""}" data-editor-mode="edit">
                    ${icon("edit")} Edit
                  </button>
                  <button class="editor-tab-btn ${editorMode === "preview" ? "active" : ""}" data-editor-mode="preview">
                    ${icon("eye")} Preview
                  </button>
                </div>

                ${
                  editorMode === "split"
                    ? `
                  <button
                    type="button"
                    class="btn-sync-scroll ${syncScrollEnabled ? "active" : ""}"
                    id="btn-toggle-sync-scroll"
                    title="${syncScrollEnabled ? "Sync scroll is ON (click to disable)" : "Sync scroll is OFF (click to enable)"}"
                    aria-pressed="${syncScrollEnabled}"
                  >
                    ${icon("refresh")}
                    <span>Sync Scroll</span>
                  </button>
                `
                    : ""
                }
              </div>

              <div class="detail-button-group">
                <button class="btn-detail-action" id="btn-export-active" title="Export this snippet">
                  ${icon("download")} Export
                </button>
                <button class="btn-detail-action" id="btn-delete-active" style="color:var(--rose);" title="Delete this snippet">
                  ${icon("trash")} Delete
                </button>
                <button class="btn-detail-action btn-copy" id="btn-copy-active">
                  ${icon("copy")} Copy Snippet
                </button>
                <button class="btn-detail-action btn-save" id="btn-save-active">
                  ${icon("check")} Save Changes
                </button>
              </div>
            </div>
          </div>

          <!-- Workspace: Editor & Rendered Preview -->
          <div class="editor-workspace" data-mode="${editorMode}">
            <!-- Editor Textarea -->
            <div class="editor-pane">
              <textarea
                class="editor-textarea"
                id="editor-textarea"
                placeholder="Write or paste your code/markdown content here..."
                spellcheck="false"
              >${escapeHtml(activeSnippet.content)}</textarea>
            </div>

            <!-- Markdown Preview Pane -->
            <div class="preview-pane">
              <div class="preview-content" id="preview-content">
                ${renderMarkdown(activeSnippet.content)}
              </div>
            </div>
          </div>
        `
            : `
          <div class="empty-state-wrap">
            <div class="empty-state-card">
              <div class="empty-state-icon">📝</div>
              <h2 class="empty-state-title">No snippet selected</h2>
              <p class="empty-state-desc">Select a snippet from the list or create a new one to get started.</p>
              <button class="btn-detail-action btn-save btn-empty-state-new" id="btn-placeholder-new">
                ${icon("plus")} Create Snippet
              </button>
            </div>
          </div>
        `
        }
      </main>
    </div>

    <!-- Settings Modal -->
    <div class="modal-overlay" id="modal-settings" ${settingsModalOpen ? "" : "hidden"}>
      <div class="modal-card">
        <div class="modal-header">
          <div class="modal-title">
            ${icon("settings")}
            <span>Settings &amp; Preferences</span>
          </div>
          <button class="modal-close-btn" id="btn-close-settings">
            ${icon("close")}
          </button>
        </div>

        <!-- Settings Tabs -->
        <div class="settings-tabs">
          <button type="button" class="settings-tab-btn ${settingsActiveTab === "ai" ? "active" : ""}" data-settings-tab="ai">
            ${icon("sparkles")} AI &amp; Search
          </button>
          <button type="button" class="settings-tab-btn ${settingsActiveTab === "preferences" ? "active" : ""}" data-settings-tab="preferences">
            ${icon("sliders")} Preferences
          </button>
          <button type="button" class="settings-tab-btn ${settingsActiveTab === "backup" ? "active" : ""}" data-settings-tab="backup">
            ${icon("database")} Backup &amp; Restore
          </button>
        </div>

        <div class="modal-body">
          ${
            settingsActiveTab === "ai"
              ? `
          <!-- Embedding Provider Selection -->
          <div>
            <div class="settings-section-title">Embeddings Provider</div>
            <div class="provider-options">
              <button type="button" class="provider-card ${snapshot.settings.provider === "local" ? "selected" : ""}" data-select-provider="local" aria-pressed="${snapshot.settings.provider === "local"}">
                <div class="provider-card-head">
                  <span class="provider-card-title">Built-in Local ONNX</span>
                  <span class="provider-selection-indicator ${snapshot.settings.provider === "local" ? "active" : ""}">
                    ${snapshot.settings.provider === "local" ? icon("check") + " Active" : "Select"}
                  </span>
                </div>
                <div class="provider-card-desc">
                  Model: <code>jina-embeddings-v2-small-en</code><br/>
                  Runs 100% locally via ONNX Runtime. 512 dimensions. Zero network requests, offline, ultra-fast.
                </div>
              </button>

              <button type="button" class="provider-card ${snapshot.settings.provider === "openai" ? "selected" : ""}" data-select-provider="openai" aria-pressed="${snapshot.settings.provider === "openai"}">
                <div class="provider-card-head">
                  <span class="provider-card-title">OpenAI-Compatible</span>
                  <span class="provider-selection-indicator ${snapshot.settings.provider === "openai" ? "active" : ""}">
                    ${snapshot.settings.provider === "openai" ? icon("check") + " Active" : "Select"}
                  </span>
                </div>
                <div class="provider-card-desc">
                  Use OpenAI, Ollama, LM Studio, OpenRouter, vLLM, or any compatible <code>/embeddings</code> API endpoint.
                </div>
              </button>
            </div>
          </div>

          <!-- Custom OpenAI Provider Inputs -->
          ${snapshot.settings.provider === "openai" ? `
          <div class="custom-provider-details">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
              <div>
                <div style="font-weight:600;font-size:12px;color:var(--text-primary);display:flex;align-items:center;gap:6px;">
                  ${icon("cpu")} Custom OpenAI-Compatible Provider Details
                </div>
              </div>
            </div>

            <div style="margin-top:10px;margin-bottom:8px;">
              <span style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:6px;">Quick Presets:</span>
              <div class="provider-presets-row">
                ${PROVIDER_PRESETS.map(
                  (p, idx) => `
                  <button type="button" class="provider-preset-btn" data-preset-idx="${idx}">
                    ${p.name}
                  </button>
                `
                ).join("")}
              </div>
            </div>

            <div class="form-group" style="margin-bottom:12px;">
              <label>Base URL</label>
              <input type="text" id="setting-openai-url" value="${escapeHtml(snapshot.settings.openaiBaseUrl)}" placeholder="https://api.openai.com/v1 or http://localhost:11434/v1"/>
            </div>

            <div class="form-group" style="margin-bottom:12px;">
              <label>API Key (leave blank for local Ollama/LM Studio)</label>
              <div class="api-key-wrap">
                <input type="password" id="setting-openai-key" value="${escapeHtml(snapshot.settings.openaiApiKey)}" placeholder="sk-... (optional for local models)"/>
                <button type="button" class="api-key-toggle-btn" id="btn-toggle-key-visibility">Show</button>
              </div>
            </div>

            <div class="form-group" style="margin-bottom:12px;">
              <label>Model Name</label>
              <input type="text" id="setting-openai-model" value="${escapeHtml(snapshot.settings.openaiModel)}" placeholder="text-embedding-3-small or nomic-embed-text"/>
            </div>

            <div class="form-group" style="margin-bottom:16px;">
              <label>Dimensions (0 = model default)</label>
              <input type="number" id="setting-openai-dims" min="0" step="1" value="${snapshot.settings.openaiDimensions}"/>
            </div>

            <div class="test-connection-box">
              <div>
                <button class="btn-detail-action" id="btn-test-connection" ${isTestingConnection ? "disabled" : ""}>
                  ${isTestingConnection ? "Testing..." : icon("sparkles") + " Test Connection"}
                </button>
              </div>
              <div id="test-result-display">
                ${
                  connectionTestResult
                    ? connectionTestResult.success
                      ? `<span class="test-result-status success">✓ Connected! Latency: ${connectionTestResult.latencyMs}ms (${connectionTestResult.dimension} dims)</span>`
                      : `<span class="test-result-status error">✗ Error: ${escapeHtml(connectionTestResult.error || "Failed")}</span>`
                    : ""
                }
              </div>
            </div>
          </div>
          ` : `
          <div class="provider-local-info">
            <div class="provider-local-info-icon">${icon("cpu")}</div>
            <div class="provider-local-info-copy">
              <div class="provider-local-info-title">Built-in Local ONNX</div>
              <p>Embeddings are generated on this device using the bundled <code>jina-embeddings-v2-small-en</code> model.</p>
              <div class="provider-local-info-stats">
                <span><strong>33M</strong> parameters</span>
                <span><strong>8192</strong> max context</span>
                <span><strong>English</strong> language</span>
                <span><strong>JinaBERT / BERT-style encoder</strong> architecture</span>
                <span><strong>512</strong> dimensions</span>
              </div>
            </div>
          </div>
          `}

          <!-- Re-index All Snippets -->
          <div>
            <div class="settings-section-title">Vector Index Maintenance</div>
            <div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg-card);padding:12px;border-radius:8px;border:1px solid var(--border-subtle);">
              <div>
                <div style="font-weight:600;font-size:12px;color:var(--text-primary);">Re-index All Snippets</div>
                <div style="font-size:11px;color:var(--text-muted);">Re-generate embeddings for all snippets using active provider.</div>
              </div>
              <button class="btn-detail-action" id="btn-reindex" ${isReindexing ? "disabled" : ""}>
                ${icon("refresh")} ${isReindexing ? "Reindexing..." : "Re-index"}
              </button>
            </div>
          </div>
          ` : settingsActiveTab === "preferences" ? `
          <!-- Preferences -->
          <div>
            <div class="settings-section-title">App Preferences</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
              <div class="form-group">
                <label>Theme</label>
                ${renderSingleSelect("setting-theme", snapshot.settings.theme, [
                  { value: "dark", label: "Dark (Obsidian)" },
                  { value: "light", label: "Light" },
                ], "settings-single-select")}
              </div>
              <div class="form-group">
                <label>Default Editor Layout</label>
                ${renderSingleSelect("setting-editor-mode", snapshot.settings.editorMode, [
                  { value: "split", label: "Split View" },
                  { value: "edit", label: "Edit Only" },
                  { value: "preview", label: "Preview Only" },
                ], "settings-single-select")}
              </div>
              <div class="form-group">
                <label>Open Snippets</label>
                ${renderSingleSelect("setting-snippet-open-mode", snapshot.settings.openSnippetsInNewTabs ? "new_tab" : "current_tab", [
                  { value: "new_tab", label: "In a New Tab" },
                  { value: "current_tab", label: "In the Current Tab" },
                ], "settings-single-select")}
              </div>
            </div>
            <div class="interface-scale-setting">
              <div class="interface-scale-copy">
                <strong>Text size</strong>
                <span>${isMac ? "⌘" : "Ctrl"} +/− to adjust · ${isMac ? "⌘" : "Ctrl"} 0 to reset</span>
              </div>
              <div class="interface-scale-control" role="group" aria-label="Text size">
                <button type="button" class="btn-detail-action btn-icon" data-action="interface-scale-decrease" aria-label="Decrease text size" title="Decrease text size">${icon("minus")}</button>
                <output id="interface-scale-value" aria-live="polite">${Math.round(interfaceScale * 100)}%</output>
                <button type="button" class="btn-detail-action btn-icon" data-action="interface-scale-increase" aria-label="Increase text size" title="Increase text size">${icon("plus")}</button>
                <button type="button" class="btn-detail-action" data-action="interface-scale-reset">Reset</button>
              </div>
            </div>
          </div>
          ` : `
          <!-- Backup & Restore Tab -->
          <div class="backup-status-banner">
            <div class="backup-status-info">
              <span class="backup-status-icon">${icon("database")}</span>
              <div>
                <div class="backup-status-title">${escapeHtml(snapshot.databaseInfo?.filename || "snippets.sqlite3")}</div>
                <div class="backup-status-subtitle">${formatBytes(snapshot.databaseInfo?.sizeBytes ?? 0)} on disk</div>
              </div>
            </div>
            <div class="backup-stats-badges">
              <span class="backup-badge">${icon("file-text")} ${snapshot.snippets.length} ${snapshot.snippets.length === 1 ? "Snippet" : "Snippets"}</span>
              <span class="backup-badge">${icon("folder")} ${snapshot.collections.length} ${snapshot.collections.length === 1 ? "Collection" : "Collections"}</span>
            </div>
          </div>

          <div>
            <div class="settings-section-title">Storage Location</div>
            <div class="storage-location-card">
              <div class="form-group">
                <label for="storage-directory">Folder</label>
                <div class="storage-folder-row">
                  <input type="text" id="storage-directory" value="${escapeHtml(snapshot.databaseInfo?.directory || "")}" readonly />
                  <button type="button" class="btn-detail-action" id="btn-choose-storage">${icon("folder")} Choose…</button>
                </div>
              </div>
              <div class="form-group">
                <label for="storage-file-name">Database file</label>
                <input type="text" id="storage-file-name" value="${escapeHtml(snapshot.databaseInfo?.filename || "snippets.sqlite3")}" placeholder="snippets.sqlite3" />
              </div>
              <div class="storage-location-footer">
                <span>The current database is copied to the new location and used immediately. A <code>.sqlite3</code> extension is added automatically.</span>
                <button type="button" class="btn-detail-action btn-save" id="btn-save-storage">${icon("check")} Move Storage</button>
              </div>
            </div>
          </div>

          <div>
            <div class="settings-section-title">Data Backup &amp; Disaster Recovery</div>
            <div class="backup-actions-grid">
              <div class="backup-action-card">
                <div>
                  <div class="backup-action-head">
                    ${icon("archive")}
                    <span>Create Backup Snapshot</span>
                  </div>
                  <div class="backup-action-desc">
                    Snapshot the entire SQLite database, collections, tags, keywords, and settings into a timestamped, portable backup folder. Safe for external drives or cloud sync.
                  </div>
                </div>
                <button type="button" class="btn-detail-action btn-save" id="btn-start-backup" style="width:100%;justify-content:center;">
                  ${icon("download")} Create Backup…
                </button>
              </div>

              <div class="backup-action-card">
                <div>
                  <div class="backup-action-head restore-head">
                    ${icon("refresh")}
                    <span>Restore from Backup</span>
                  </div>
                  <div class="backup-action-desc">
                    Validate and restore from a previously created SnippetBox backup folder. Features integrity checks, staged file replacement, and automatic rollback protection.
                  </div>
                </div>
                <button type="button" class="btn-detail-action" id="btn-start-restore" style="width:100%;justify-content:center;">
                  ${icon("upload")} Restore Backup…
                </button>
              </div>
            </div>
          </div>
          `}
        </div>

        <div class="modal-footer">
          <button class="btn-detail-action" id="btn-cancel-settings">${settingsActiveTab === "backup" ? "Close" : "Cancel"}</button>
          ${settingsActiveTab !== "backup" ? `<button class="btn-detail-action btn-save" id="btn-save-settings">Save Settings</button>` : ""}
        </div>
      </div>
    </div>

    <!-- Collection Modal -->
    <div class="modal-overlay" id="modal-collection" ${collectionModalOpen ? "" : "hidden"}>
      <div class="modal-card" style="width: 400px;">
        <div class="modal-header">
          <div class="modal-title">
            ${icon(editingCollection ? "edit" : "folder-plus")}
            <span>${editingCollection ? "Rename Collection" : "New Collection"}</span>
          </div>
          <button class="modal-close-btn" id="btn-close-collection">
            ${icon("close")}
          </button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>${editingCollection ? "New name" : "Name"}</label>
            <input type="text" id="collection-name-input" placeholder="e.g. Algorithms, DevOps, Cheatsheets..." value="${escapeHtml(editingCollection?.name || "")}"/>
          </div>
          ${
            editingCollection
              ? ""
              : `<div class="form-group">
                  <label>Color Accent</label>
                  <div style="display:flex;gap:8px;align-items:center;">
                    <input type="color" id="collection-color-input" value="#10b981" style="width:40px;height:36px;padding:2px;border:0;border-radius:6px;cursor:pointer;background:transparent;"/>
                    <span style="font-size:11px;color:var(--text-muted);">Choose a distinct color for this collection</span>
                  </div>
                </div>`
          }
        </div>
        <div class="modal-footer">
          <button class="btn-detail-action" id="btn-cancel-collection">Cancel</button>
          <button class="btn-detail-action btn-save" id="btn-save-collection">${editingCollection ? "Rename Collection" : "Save Collection"}</button>
        </div>
      </div>
    </div>

    <!-- Text Import Modal -->
    <div class="modal-overlay" id="modal-text-import" ${importModalOpen ? "" : "hidden"}>
      <div class="modal-card import-modal-card">
        <div class="modal-header">
          <div class="modal-title">
            ${icon("upload")}
            <span>Import Text Files</span>
          </div>
          <button type="button" class="modal-close-btn" id="btn-close-text-import" ${isImportingText ? "disabled" : ""}>
            ${icon("close")}
          </button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>Import into collection</label>
            ${renderSingleSelect(
              "import-collection",
              importCollectionId,
              snapshot.collections.map((collection) => ({ value: collection.id, label: collection.name })),
              "import-collection-select"
            )}
          </div>
          <p class="import-help">Each readable text file becomes one snippet. Its filename is used as the title and its extension as the language. Folders are scanned recursively.</p>
          <div class="import-source-actions">
            <button type="button" class="import-source-btn" id="btn-import-files" ${isImportingText ? "disabled" : ""}>
              ${icon("file-text")}
              <span><strong>${isImportingText ? "Importing…" : "Choose files…"}</strong><small>Select one or multiple text, Markdown, MDX, or code files.</small></span>
            </button>
            <button type="button" class="import-source-btn" id="btn-import-folders" ${isImportingText ? "disabled" : ""}>
              ${icon("folder")}
              <span><strong>${isImportingText ? "Importing…" : "Choose folders…"}</strong><small>Import all text files inside one or multiple folders recursively.</small></span>
            </button>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn-detail-action" id="btn-cancel-text-import" ${isImportingText ? "disabled" : ""}>Cancel</button>
        </div>
      </div>
    </div>

    <!-- Bulk Move Modal -->
    <div class="modal-overlay" id="modal-bulk-move" ${bulkMoveModalOpen ? "" : "hidden"}>
      <div class="modal-card bulk-action-card">
        <div class="modal-header">
          <div class="modal-title">
            ${icon("folder")}
            <span>Move ${selectedSnippetIds.size} ${selectedSnippetIds.size === 1 ? "snippet" : "snippets"}</span>
          </div>
          <button type="button" class="modal-close-btn" id="btn-close-bulk-move">
            ${icon("close")}
          </button>
        </div>
        <div class="modal-body">
          <div class="bulk-collection-list">
            ${snapshot.collections
              .map((col) => {
                const selected = (bulkMoveCollectionId || "default") === col.id;
                return `
                  <button type="button" class="bulk-collection-option ${selected ? "selected" : ""}" data-bulk-move-collection="${col.id}">
                    <span class="collection-dot" style="background-color: ${escapeHtml(col.color)};"></span>
                    <span>${escapeHtml(col.name)}</span>
                    ${selected ? icon("check") : ""}
                  </button>
                `;
              })
              .join("")}
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn-detail-action" id="btn-cancel-bulk-move">Cancel</button>
          <button type="button" class="btn-detail-action btn-save" id="btn-confirm-bulk-move">Move</button>
        </div>
      </div>
    </div>

    <!-- Bulk Tag Modal -->
    <div class="modal-overlay" id="modal-bulk-tag" ${bulkTagModalOpen ? "" : "hidden"}>
      <div class="modal-card bulk-action-card">
        <div class="modal-header">
          <div class="modal-title">
            ${icon("tag")}
            <span>${bulkTagRemove ? "Remove tags from" : "Add tags to"} ${selectedSnippetIds.size} ${selectedSnippetIds.size === 1 ? "snippet" : "snippets"}</span>
          </div>
          <button type="button" class="modal-close-btn" id="btn-close-bulk-tag">
            ${icon("close")}
          </button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>Tags</label>
            <input type="text" id="bulk-tag-input" value="${escapeHtml(bulkTagInput)}" placeholder="Comma separated tags..."/>
          </div>
          ${
            snapshot.tags.length > 0
              ? `<div class="bulk-tag-chip-list">
                  ${snapshot.tags
                    .map((tag) => {
                      const active = parseTagList(bulkTagInput).includes(tag);
                      return `<button type="button" class="bulk-tag-chip ${active ? "active" : ""}" data-bulk-tag-chip="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`;
                    })
                    .join("")}
                </div>`
              : ""
          }
          <label class="bulk-tag-remove">
            <input type="checkbox" id="bulk-tag-remove" ${bulkTagRemove ? "checked" : ""} />
            Remove these tags instead
          </label>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn-detail-action" id="btn-cancel-bulk-tag">Cancel</button>
          <button type="button" class="btn-detail-action btn-save" id="btn-confirm-bulk-tag">${bulkTagRemove ? "Remove tags" : "Add tags"}</button>
        </div>
      </div>
    </div>

    <!-- Custom Confirmation Dialog -->
    <div class="modal-overlay confirmation-overlay" id="modal-confirmation" ${confirmationDialog ? "" : "hidden"}>
      <div class="modal-card confirmation-card" role="dialog" aria-modal="true" aria-labelledby="confirmation-title">
        <div class="confirmation-icon">${icon("trash")}</div>
        <div class="confirmation-copy">
          <h2 id="confirmation-title">${escapeHtml(confirmationDialog?.title || "")}</h2>
          <p>${escapeHtml(confirmationDialog?.message || "")}</p>
        </div>
        <div class="confirmation-actions">
          <button type="button" class="btn-detail-action" id="btn-cancel-confirmation">Cancel</button>
          <button type="button" class="btn-detail-action btn-confirm-danger" id="btn-confirmation-confirm">${escapeHtml(confirmationDialog?.confirmLabel || "Confirm")}</button>
        </div>
      </div>
    </div>

    <!-- Backup & Restore Operations Modal -->
    ${
      backupModalState
        ? `
    <div class="modal-overlay backup-modal-overlay" id="modal-backup-op">
      <div class="modal-card backup-modal-card">
        <div class="modal-header">
          <div class="modal-title">
            ${icon(
              backupModalState.type === "backup-success" || backupModalState.type === "restore-success"
                ? "check"
                : backupModalState.type === "restore-confirm"
                ? "refresh"
                : "database"
            )}
            <span>${escapeHtml(backupModalState.title)}</span>
          </div>
          ${
            backupModalState.type === "backup-success" || backupModalState.type === "restore-confirm"
              ? `<button class="modal-close-btn" id="btn-close-backup-op">${icon("close")}</button>`
              : ""
          }
        </div>

        <div class="modal-body">
          ${
            backupModalState.type === "backup-progress" ||
            backupModalState.type === "restore-inspecting" ||
            backupModalState.type === "restore-progress"
              ? `
              <div class="backup-progress-body">
                <div class="backup-spinner"></div>
                <div style="font-weight:600;font-size:13px;color:var(--text-primary);">${escapeHtml(backupModalState.title)}</div>
                <div style="font-size:11.5px;color:var(--text-muted);">${escapeHtml(backupModalState.message || "")}</div>
                ${backupModalState.path ? `<div class="backup-path-preview">${escapeHtml(backupModalState.path)}</div>` : ""}
              </div>
            `
              : backupModalState.type === "backup-success" && backupModalState.backupResult
              ? `
              <div>
                <div class="backup-success-icon">${icon("check")}</div>
                <div style="text-align:center;font-weight:600;font-size:14px;color:var(--text-primary);margin-bottom:6px;">
                  Backup Completed
                </div>
                <div style="text-align:center;font-size:12px;color:var(--text-muted);margin-bottom:14px;">
                  ${backupModalState.backupResult.snippets_count} snippets and ${backupModalState.backupResult.collections_count} collections were safely archived.
                </div>

                <div class="backup-summary-box">
                  <div class="backup-summary-row">
                    <span>Archive Folder:</span>
                    <span>${escapeHtml(backupModalState.backupResult.folder_name)}</span>
                  </div>
                  <div class="backup-summary-row">
                    <span>Files Copied:</span>
                    <span>${backupModalState.backupResult.copied_files_count}</span>
                  </div>
                  <div class="backup-summary-row">
                    <span>Snippets:</span>
                    <span>${backupModalState.backupResult.snippets_count}</span>
                  </div>
                  <div class="backup-summary-row">
                    <span>Collections:</span>
                    <span>${backupModalState.backupResult.collections_count}</span>
                  </div>
                </div>

                <div style="font-size:11px;color:var(--text-muted);margin-top:10px;">
                  Destination path:
                </div>
                <div class="backup-path-preview">${escapeHtml(backupModalState.backupResult.target_dir)}</div>
              </div>
            `
              : backupModalState.type === "restore-confirm" && backupModalState.preview
              ? `
              <div>
                <p style="font-size:12.5px;color:var(--text-primary);line-height:1.5;margin-bottom:12px;">
                  Validate the details below before proceeding with the restore:
                </p>

                <div class="backup-summary-box">
                  <div class="backup-summary-row">
                    <span>Archive Folder:</span>
                    <span>${escapeHtml(backupModalState.preview.folder_name)}</span>
                  </div>
                  <div class="backup-summary-row">
                    <span>Created:</span>
                    <span>${escapeHtml(backupModalState.preview.created_at ? new Date(backupModalState.preview.created_at).toLocaleString() : "Unknown")}</span>
                  </div>
                  <div class="backup-summary-row">
                    <span>Snippets:</span>
                    <span>${backupModalState.preview.snippets_count}</span>
                  </div>
                  <div class="backup-summary-row">
                    <span>Collections:</span>
                    <span>${backupModalState.preview.collections_count}</span>
                  </div>
                  <div class="backup-summary-row">
                    <span>Archive Size:</span>
                    <span>${formatBytes(backupModalState.preview.total_bytes)} (${backupModalState.preview.file_count} files)</span>
                  </div>
                </div>

                <div class="backup-warning-box">
                  ${icon("help")}
                  <div>
                    <strong>Overwrite Warning:</strong> Restoring replaces current snippets and collections with this backup. An automatic rollback copy of your current data is saved in case of any failure.
                  </div>
                </div>
              </div>
            `
              : backupModalState.type === "restore-success" && backupModalState.restoreResult
              ? `
              <div>
                <div class="backup-success-icon">${icon("check")}</div>
                <div style="text-align:center;font-weight:600;font-size:14px;color:var(--text-primary);margin-bottom:6px;">
                  Data Restored Successfully
                </div>
                <p style="text-align:center;font-size:12px;color:var(--text-muted);line-height:1.5;margin-bottom:14px;">
                  ${backupModalState.restoreResult.restored_files_count} files were restored. Please reload SnippetBox to display the restored snippets and collections.
                </p>
                <div class="backup-path-preview">${escapeHtml(backupModalState.restoreResult.backup_dir)}</div>
                ${
                  backupModalState.restoreResult.warnings.length > 0
                    ? `<div style="margin-top:10px;padding:8px 12px;border-radius:6px;background:rgba(245,158,11,0.1);color:#fcd34d;font-size:11px;">
                        <strong>Warnings:</strong> ${backupModalState.restoreResult.warnings.map(escapeHtml).join("<br/>")}
                      </div>`
                    : ""
                }
              </div>
            `
              : ""
          }
        </div>

        <div class="modal-footer">
          ${
            backupModalState.type === "backup-progress" || backupModalState.type === "restore-progress"
              ? `
              <button class="btn-detail-action" id="btn-cancel-active-op" ${backupModalState.cancellationPending ? "disabled" : ""}>
                ${backupModalState.cancellationPending ? "Cancelling…" : "Cancel"}
              </button>
            `
              : backupModalState.type === "restore-confirm"
              ? `
              <button class="btn-detail-action" id="btn-cancel-backup-op">Cancel</button>
              <button class="btn-detail-action btn-save" id="btn-confirm-restore" style="background:var(--rose);border-color:var(--rose);">
                ${icon("refresh")} Confirm &amp; Restore
              </button>
            `
              : backupModalState.type === "restore-success"
              ? `
              <button class="btn-detail-action btn-save" id="btn-reload-after-restore">
                ${icon("refresh")} Reload SnippetBox
              </button>
            `
              : `
              <button class="btn-detail-action btn-save" id="btn-done-backup-op">Done</button>
            `
          }
        </div>
      </div>
    </div>
        `
        : ""
    }

    <!-- Export Format Selection Modal -->
    ${renderExportModal()}

    <!-- Export Success Modal -->
    ${renderExportSuccessModal()}

    <!-- Toast Notifications Container -->
    <div class="toast-container" id="toast-container"></div>
  `;

  attachDynamicListeners();

  const pageSelect = document.getElementById("btn-select-page") as HTMLInputElement | null;
  if (pageSelect?.dataset.indeterminate === "true") pageSelect.indeterminate = true;

  if (bulkTagModalOpen) {
    const tagInput = document.getElementById("bulk-tag-input") as HTMLInputElement | null;
    if (tagInput && document.activeElement !== tagInput) {
      tagInput.focus();
      tagInput.setSelectionRange(tagInput.value.length, tagInput.value.length);
    }
  }

  if (prevSidebarScrollTop > 0) {
    const sidebarEl = document.querySelector(".sidebar-scroll");
    if (sidebarEl) sidebarEl.scrollTop = prevSidebarScrollTop;
  }
  if (prevTagCloudScrollTop > 0) {
    const tagCloudEl = document.querySelector(".tag-cloud");
    if (tagCloudEl) tagCloudEl.scrollTop = prevTagCloudScrollTop;
  }
  if (sameSnippet) {
    if (prevEditorScrollTop > 0) {
      const editorEl = document.getElementById("editor-textarea");
      if (editorEl) editorEl.scrollTop = prevEditorScrollTop;
    }
    if (prevPreviewScrollTop > 0) {
      const previewEl = document.querySelector(".preview-pane");
      if (previewEl) previewEl.scrollTop = prevPreviewScrollTop;
    }
  }
  lastRenderedSnippetId = activeSnippetId;
}

function renderMarkdown(content: string): string {
  if (!content) {
    return `<p style="color:var(--text-muted);font-style:italic;">No content written yet.</p>`;
  }
  const rawHtml = marked.parse(content) as string;
  return DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ["target", "data-code"],
  });
}

function hasActiveFilters(): boolean {
  return (
    (filterState.collectionIds && filterState.collectionIds.length > 0) ||
    Boolean(filterState.dateFrom) ||
    Boolean(filterState.dateTo) ||
    Boolean(filterState.favoriteOnly) ||
    Boolean(filterState.query)
  );
}

function getCollectionsFilterLabel(): string {
  const count = filterState.collectionIds?.length || 0;
  if (count === 0) return "Collections";
  if (count === 1) {
    const col = snapshot.collections.find(
      (c) => c.id === filterState.collectionIds?.[0]
    );
    return col ? col.name : "1 Collection";
  }
  return `Collections (${count})`;
}

function getDateFilterLabel(): string {
  if (filterState.dateFrom && filterState.dateTo) {
    return `${filterState.dateFrom} → ${filterState.dateTo}`;
  }
  if (filterState.dateFrom) return `From ${filterState.dateFrom}`;
  if (filterState.dateTo) return `Until ${filterState.dateTo}`;
  return "Date Added";
}

function escapeHtml(str: string): string {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showToast(message: string, type: "success" | "error" = "success") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    ${icon(type === "success" ? "check" : "close")}
    <span>${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    toast.style.transition = "all 0.2s ease";
    setTimeout(() => toast.remove(), 200);
  }, 2800);
}

function openConfirmationDialog(state: ConfirmationDialogState): void {
  confirmationDialog = state;
  openSelectId = null;
  collectionPopoverOpen = false;
  datePopoverOpen = false;
  render();
}

function syncInterfaceScaleControls(): void {
  const currentIndex = INTERFACE_SCALE_LEVELS.indexOf(
    interfaceScale as typeof INTERFACE_SCALE_LEVELS[number]
  );
  const value = document.querySelector<HTMLOutputElement>("#interface-scale-value");
  const decrease = document.querySelector<HTMLButtonElement>(
    "[data-action='interface-scale-decrease']"
  );
  const increase = document.querySelector<HTMLButtonElement>(
    "[data-action='interface-scale-increase']"
  );
  const reset = document.querySelector<HTMLButtonElement>(
    "[data-action='interface-scale-reset']"
  );

  if (value) value.textContent = `${Math.round(interfaceScale * 100)}%`;
  if (decrease) decrease.disabled = currentIndex <= 0;
  if (increase) increase.disabled = currentIndex >= INTERFACE_SCALE_LEVELS.length - 1;
  if (reset) reset.disabled = interfaceScale === DEFAULT_INTERFACE_SCALE;
}

async function setInterfaceScale(scale: number, announce = true): Promise<void> {
  if (!INTERFACE_SCALE_LEVELS.includes(scale as typeof INTERFACE_SCALE_LEVELS[number])) return;

  try {
    // Tauri's native webview zoom keeps the viewport/layout behavior correct.
    await getCurrentWebview().setZoom(scale);
    document.documentElement.style.zoom = "";
  } catch {
    // The CSS fallback keeps the feature usable in a regular Vite preview too.
    document.documentElement.style.zoom = String(scale);
  }

  interfaceScale = scale;
  localStorage.setItem("snippetbox-interface-scale", String(scale));
  syncInterfaceScaleControls();
  if (announce) showToast(`Text size: ${Math.round(scale * 100)}%`);
}

async function stepInterfaceScale(direction: -1 | 1): Promise<void> {
  const currentIndex = INTERFACE_SCALE_LEVELS.indexOf(
    interfaceScale as typeof INTERFACE_SCALE_LEVELS[number]
  );
  const nextIndex = Math.max(
    0,
    Math.min(INTERFACE_SCALE_LEVELS.length - 1, currentIndex + direction)
  );
  if (nextIndex === currentIndex) return;
  await setInterfaceScale(INTERFACE_SCALE_LEVELS[nextIndex]);
}

// Attach event listeners
function attachDynamicListeners() {
  // Window controls
  document.getElementById("btn-win-min")?.addEventListener("click", () => {
    invoke("window_minimize");
  });
  document.getElementById("btn-win-max")?.addEventListener("click", () => {
    invoke("window_maximize");
  });
  document.getElementById("btn-win-close")?.addEventListener("click", () => {
    invoke("window_close");
  });

  // Search input
  const searchInput = document.getElementById(
    "search-input"
  ) as HTMLInputElement | null;
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      const val = (e.target as HTMLInputElement).value;
      filterState.query = val;
      if (!val.trim()) {
        userExplicitlyChangedSort = false;
        filterState.sortBy = "created_desc";
      }
      ++searchRequestId;
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(async () => {
        await performSearch();
        render();
        // Keep focus on search input
        const newSearchInput = document.getElementById(
          "search-input"
        ) as HTMLInputElement | null;
        if (newSearchInput) {
          newSearchInput.focus();
          newSearchInput.setSelectionRange(
            newSearchInput.value.length,
            newSearchInput.value.length
          );
        }
      }, 200);
    });
  }

  const keywordSearchInput = document.getElementById(
    "keyword-search-input"
  ) as HTMLInputElement | null;
  if (keywordSearchInput) {
    keywordSearchInput.addEventListener("input", (e) => {
      keywordSearchQuery = (e.target as HTMLInputElement).value;
      if (keywordSearchDebounceTimer) clearTimeout(keywordSearchDebounceTimer);
      keywordSearchDebounceTimer = setTimeout(() => {
        render();
        const nextInput = document.getElementById(
          "keyword-search-input"
        ) as HTMLInputElement | null;
        if (nextInput) {
          nextInput.focus();
          nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
        }
      }, 300);
    });
  }

  document.getElementById("btn-clear-search")?.addEventListener("click", async () => {
    filterState.query = "";
    userExplicitlyChangedSort = false;
    filterState.sortBy = "created_desc";
    await performSearch();
    render();
  });

  // Search mode selector
  document.querySelectorAll("[data-search-mode]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const mode = (e.currentTarget as HTMLElement).getAttribute(
        "data-search-mode"
      ) as "hybrid" | "semantic" | "keyword";
      filterState.searchMode = mode;
      await performSearch();
      render();
    });
  });

  // Shared single-select dropdowns (sort, settings, and snippet collection)
  document.querySelectorAll<HTMLElement>("[data-select-trigger]").forEach((trigger) => {
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = trigger.getAttribute("data-select-trigger");
      if (!id) return;
      closeFilterPopovers();
      setSingleSelectOpen(openSelectId === id ? null : id);
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-select-option]").forEach((option) => {
    option.addEventListener("click", async (e) => {
      e.stopPropagation();
      const picker = option.closest<HTMLElement>("[data-select-picker]");
      const selectId = picker?.getAttribute("data-select-picker");
      const value = option.getAttribute("data-select-option");
      if (!picker || !selectId || !value) return;

      setSingleSelectOpen(null);
      updateSingleSelectDisplay(picker, value);

      if (selectId === "sort-select") {
        filterState.sortBy = value;
        userExplicitlyChangedSort = true;
        await performSearch();
        render();
        return;
      }

      if (selectId === "setting-theme" && (value === "dark" || value === "light")) {
        snapshot.settings.theme = value;
        document.documentElement.setAttribute("data-theme", value);
      } else if (
        selectId === "setting-editor-mode" &&
        (value === "split" || value === "edit" || value === "preview")
      ) {
        snapshot.settings.editorMode = value;
      } else if (selectId === "detail-collection") {
        const active = getActiveSnippet();
        if (active) active.collectionId = value;
      } else if (selectId === "import-collection") {
        importCollectionId = value;
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-action^='interface-scale-']").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.getAttribute("data-action");
      if (action === "interface-scale-decrease") await stepInterfaceScale(-1);
      if (action === "interface-scale-increase") await stepInterfaceScale(1);
      if (action === "interface-scale-reset") await setInterfaceScale(DEFAULT_INTERFACE_SCALE);
    });
  });

  // New snippet
  document.getElementById("btn-new-snippet")?.addEventListener("click", createNewSnippet);
  document.getElementById("btn-placeholder-new")?.addEventListener("click", createNewSnippet);
  document.getElementById("btn-import-snippets")?.addEventListener("click", () => {
    importCollectionId =
      filterState.collectionIds?.length === 1 ? filterState.collectionIds[0] : "default";
    importModalOpen = true;
    render();
  });
  document.getElementById("btn-close-text-import")?.addEventListener("click", closeTextImportModal);
  document.getElementById("btn-cancel-text-import")?.addEventListener("click", closeTextImportModal);
  document.getElementById("btn-import-files")?.addEventListener("click", () => {
    void chooseAndImportText(false);
  });
  document.getElementById("btn-import-folders")?.addEventListener("click", () => {
    void chooseAndImportText(true);
  });

  // Nav All / Nav Favorites
  document.getElementById("nav-all")?.addEventListener("click", async () => {
    filterState.favoriteOnly = false;
    filterState.collectionIds = [];
    await performSearch();
    render();
  });

  document.getElementById("nav-favorites")?.addEventListener("click", async () => {
    filterState.favoriteOnly = true;
    filterState.collectionIds = [];
    await performSearch();
    render();
  });

  // Nav Collection click
  document.querySelectorAll("[data-collection-id]").forEach((el) => {
    el.addEventListener("click", async (e) => {
      const colId = (e.currentTarget as HTMLElement).getAttribute("data-collection-id")!;
      filterState.collectionIds = [colId];
      filterState.favoriteOnly = false;
      await performSearch();
      render();
    });
  });

  // Rename Collection
  document.querySelectorAll("[data-rename-collection]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const colId = (e.currentTarget as HTMLElement).getAttribute("data-rename-collection");
      editingCollection = snapshot.collections.find((collection) => collection.id === colId) || null;
      if (!editingCollection) return;
      collectionModalOpen = true;
      render();
      requestAnimationFrame(() => {
        document.getElementById("collection-name-input")?.focus();
      });
    });
  });

  // Delete Collection
  document.querySelectorAll("[data-delete-collection]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const colId = (e.currentTarget as HTMLElement).getAttribute("data-delete-collection")!;
      openConfirmationDialog({
        title: "Delete collection?",
        message: "Snippets in this collection will be moved to Default.",
        confirmLabel: "Delete collection",
        action: async () => {
        try {
          await invoke("delete_collection", { id: colId });
          showToast("Collection deleted");
          const fresh = await invoke<AppSnapshot>("get_app_snapshot");
          snapshot = fresh;
          filterState.collectionIds = [];
          await performSearch();
          render();
        } catch (err) {
          showToast(`Failed to delete collection: ${err}`, "error");
        }
        },
      });
    });
  });

  // Keyword filter pills
  document.querySelectorAll("[data-keyword-filter]").forEach((pill) => {
    pill.addEventListener("click", async (e) => {
      const kw = (e.currentTarget as HTMLElement).getAttribute("data-keyword-filter")!;
      if (filterState.query === kw) {
        filterState.query = "";
        userExplicitlyChangedSort = false;
        filterState.sortBy = "created_desc";
      } else {
        filterState.query = kw;
        userExplicitlyChangedSort = false;
        filterState.sortBy = "relevance";
      }
      await performSearch();
      render();
    });
  });

  // Card tag pills click to search by tag
  document.querySelectorAll("[data-card-tag]").forEach((pill) => {
    pill.addEventListener("click", async (e) => {
      e.stopPropagation();
      const tag = (e.currentTarget as HTMLElement).getAttribute("data-card-tag")!;
      if (filterState.query === tag) {
        filterState.query = "";
        userExplicitlyChangedSort = false;
        filterState.sortBy = "created_desc";
      } else {
        filterState.query = tag;
        userExplicitlyChangedSort = false;
        filterState.sortBy = "relevance";
      }
      await performSearch();
      render();
    });
  });

  // Pagination controls
  document.getElementById("btn-page-prev")?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      render();
      const listEl = document.getElementById("snippets-list");
      if (listEl) listEl.scrollTop = 0;
    }
  });

  document.getElementById("btn-page-next")?.addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(searchResults.length / PAGE_SIZE));
    if (currentPage < totalPages) {
      currentPage++;
      render();
      const listEl = document.getElementById("snippets-list");
      if (listEl) listEl.scrollTop = 0;
    }
  });

  // Filter Popover Toggles
  document.getElementById("btn-filter-collection")?.addEventListener("click", (e) => {
    e.stopPropagation();
    setSingleSelectOpen(null);
    collectionPopoverOpen = !collectionPopoverOpen;
    datePopoverOpen = false;
    render();
  });

  document.getElementById("btn-filter-date")?.addEventListener("click", (e) => {
    e.stopPropagation();
    setSingleSelectOpen(null);
    datePopoverOpen = !datePopoverOpen;
    collectionPopoverOpen = false;
    render();
  });

  document.getElementById("btn-filter-fav")?.addEventListener("click", async () => {
    filterState.favoriteOnly = !filterState.favoriteOnly;
    await performSearch();
    render();
  });

  document.getElementById("btn-clear-all-filters")?.addEventListener("click", async () => {
    filterState.query = "";
    filterState.collectionIds = [];
    filterState.dateFrom = "";
    filterState.dateTo = "";
    filterState.favoriteOnly = false;
    userExplicitlyChangedSort = false;
    filterState.sortBy = "created_desc";
    await performSearch();
    render();
  });

  // Collection Popover Checkboxes
  document.querySelectorAll("[data-filter-col-id]").forEach((cb) => {
    cb.addEventListener("change", async (e) => {
      const input = e.target as HTMLInputElement;
      const colId = input.getAttribute("data-filter-col-id")!;
      const cur = filterState.collectionIds || [];
      if (input.checked) {
        filterState.collectionIds = [...cur, colId];
      } else {
        filterState.collectionIds = cur.filter((id) => id !== colId);
      }
      await performSearch();
      render();
    });
  });

  document.getElementById("btn-clear-col-filter")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    filterState.collectionIds = [];
    await performSearch();
    render();
  });

  // Date Presets
  document.querySelectorAll("[data-date-preset]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const preset = (e.currentTarget as HTMLElement).getAttribute("data-date-preset");
      const today = new Date();
      if (preset === "today") {
        const d = today.toISOString().split("T")[0];
        filterState.dateFrom = d;
        filterState.dateTo = d;
      } else if (preset === "7d") {
        const past = new Date(today.getTime() - 7 * 86400000);
        filterState.dateFrom = past.toISOString().split("T")[0];
        filterState.dateTo = today.toISOString().split("T")[0];
      } else if (preset === "30d") {
        const past = new Date(today.getTime() - 30 * 86400000);
        filterState.dateFrom = past.toISOString().split("T")[0];
        filterState.dateTo = today.toISOString().split("T")[0];
      } else if (preset === "all") {
        filterState.dateFrom = "";
        filterState.dateTo = "";
      }
      datePopoverOpen = false;
      await performSearch();
      render();
    });
  });

  document.getElementById("date-from-input")?.addEventListener("change", async (e) => {
    filterState.dateFrom = (e.target as HTMLInputElement).value;
    await performSearch();
    render();
  });

  document.getElementById("date-to-input")?.addEventListener("change", async (e) => {
    filterState.dateTo = (e.target as HTMLInputElement).value;
    await performSearch();
    render();
  });

  document.getElementById("btn-clear-date-filter")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    filterState.dateFrom = "";
    filterState.dateTo = "";
    datePopoverOpen = false;
    await performSearch();
    render();
  });

  // Snippet Card Click
  document.querySelectorAll(".snippet-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".card-action-btn") || target.closest(".card-select")) return;

      const id = card.getAttribute("data-snippet-id")!;
      const mouse = e as MouseEvent;
      if (mouse.shiftKey || mouse.metaKey || mouse.ctrlKey) {
        e.preventDefault();
        if (mouse.shiftKey) selectSnippetRange(id, getPaginatedSnippetIds());
        else toggleSnippetSelection(id);
        render();
        return;
      }

      // Discard empty unsaved draft when clicking away
      if (activeSnippetId && activeSnippetId.startsWith("new-") && activeSnippetId !== id) {
        const cur = snapshot.snippets.find((s) => s.id === activeSnippetId);
        if (cur && !cur.title && !cur.content) {
          openSnippetIds = openSnippetIds.filter((openId) => openId !== activeSnippetId);
          snapshot.snippets = snapshot.snippets.filter((s) => s.id !== activeSnippetId);
          searchResults = searchResults.filter((r) => r.snippet.id !== activeSnippetId);
        }
      }
      openSnippet(id);
      render();
      void loadRelatedSnippets(id);
    });
  });

  document.querySelectorAll<HTMLInputElement>("[data-select-snippet]").forEach((checkbox) => {
    checkbox.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = checkbox.getAttribute("data-select-snippet");
      if (!id) return;
      const mouse = e as MouseEvent;
      if (mouse.shiftKey) selectSnippetRange(id, getPaginatedSnippetIds());
      else toggleSnippetSelection(id, checkbox.checked);
      render();
    });
  });

  document.getElementById("btn-select-page")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const checkbox = e.currentTarget as HTMLInputElement;
    const pageIds = getPaginatedSnippetIds();
    if (checkbox.checked) pageIds.forEach((id) => selectedSnippetIds.add(id));
    else pageIds.forEach((id) => selectedSnippetIds.delete(id));
    lastCheckedSnippetId = pageIds[pageIds.length - 1] || lastCheckedSnippetId;
    render();
  });

  document.getElementById("btn-select-all-results")?.addEventListener("click", (e) => {
    e.stopPropagation();
    searchResults.forEach((result) => selectedSnippetIds.add(result.snippet.id));
    render();
  });

  document.getElementById("btn-clear-selection")?.addEventListener("click", (e) => {
    e.stopPropagation();
    clearSnippetSelection();
    closeBulkActionModals();
    render();
  });

  document.getElementById("btn-batch-move")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openBulkMoveModal();
  });
  document.getElementById("btn-batch-tag")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openBulkTagModal();
  });
  document.getElementById("btn-batch-favorite")?.addEventListener("click", (e) => {
    e.stopPropagation();
    void setSelectedFavorites();
  });
  document.getElementById("btn-batch-export")?.addEventListener("click", (e) => {
    e.stopPropagation();
    void exportSelectedSnippets();
  });
  document.getElementById("btn-batch-delete")?.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteSelectedSnippets();
  });

  const closeBulkMove = () => {
    bulkMoveModalOpen = false;
    render();
  };
  document.getElementById("btn-close-bulk-move")?.addEventListener("click", closeBulkMove);
  document.getElementById("btn-cancel-bulk-move")?.addEventListener("click", closeBulkMove);
  document.getElementById("modal-bulk-move")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeBulkMove();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-bulk-move-collection]").forEach((button) => {
    button.addEventListener("click", () => {
      bulkMoveCollectionId = button.getAttribute("data-bulk-move-collection");
      render();
    });
  });
  document.getElementById("btn-confirm-bulk-move")?.addEventListener("click", () => {
    void moveSelectedSnippets();
  });

  const closeBulkTag = () => {
    bulkTagModalOpen = false;
    render();
  };
  document.getElementById("btn-close-bulk-tag")?.addEventListener("click", closeBulkTag);
  document.getElementById("btn-cancel-bulk-tag")?.addEventListener("click", closeBulkTag);
  document.getElementById("modal-bulk-tag")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeBulkTag();
  });
  document.getElementById("bulk-tag-input")?.addEventListener("input", (e) => {
    bulkTagInput = (e.currentTarget as HTMLInputElement).value;
  });
  document.getElementById("bulk-tag-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void tagSelectedSnippets();
    }
  });
  document.getElementById("bulk-tag-remove")?.addEventListener("change", (e) => {
    bulkTagRemove = (e.currentTarget as HTMLInputElement).checked;
    render();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-bulk-tag-chip]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const tag = chip.getAttribute("data-bulk-tag-chip");
      if (!tag) return;
      const tags = parseTagList(bulkTagInput);
      const index = tags.indexOf(tag);
      if (index >= 0) tags.splice(index, 1);
      else tags.push(tag);
      bulkTagInput = tags.join(", ");
      render();
    });
  });
  document.getElementById("btn-confirm-bulk-tag")?.addEventListener("click", () => {
    void tagSelectedSnippets();
  });

  document.querySelectorAll<HTMLElement>("[data-snippet-tab]").forEach((tab) => {
    tab.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("[data-close-snippet-tab]")) return;
      const id = tab.dataset.snippetTab;
      if (!id) return;
      activeSnippetId = id;
      render();
      void loadRelatedSnippets(id);
    });
  });

  document.querySelectorAll<HTMLElement>("[data-close-snippet-tab]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const id = button.dataset.closeSnippetTab;
      if (!id) return;
      closeSnippetTab(id);
      render();
      if (activeSnippetId) void loadRelatedSnippets(activeSnippetId);
    });
  });

  document.getElementById("btn-toggle-detail-header")?.addEventListener("click", () => {
    detailHeaderCollapsed = !detailHeaderCollapsed;
    localStorage.setItem(
      "snippetbox-detail-header-collapsed",
      String(detailHeaderCollapsed)
    );
    render();
  });

  document.getElementById("btn-toggle-snippets-pane")?.addEventListener("click", () => {
    snippetsPaneCollapsed = !snippetsPaneCollapsed;
    localStorage.setItem(
      "snippetbox-snippets-pane-collapsed",
      String(snippetsPaneCollapsed)
    );
    render();
  });

  attachRelatedSnippetListeners();

  // Copy Snippet from Card
  document.querySelectorAll("[data-copy-snippet]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = (e.currentTarget as HTMLElement).getAttribute("data-copy-snippet")!;
      await copySnippetById(id);
    });
  });

  // Favorite toggle from Card
  document.querySelectorAll("[data-toggle-fav]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const targetBtn = e.currentTarget as HTMLElement;
      const id = targetBtn.getAttribute("data-toggle-fav")!;
      await toggleFavorite(id, targetBtn);
    });
  });

  // Delete from Card
  document.querySelectorAll("[data-delete-snippet]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = (e.currentTarget as HTMLElement).getAttribute("data-delete-snippet")!;
      await deleteSnippetById(id);
    });
  });

  // Editor Actions
  document.getElementById("btn-export-active")?.addEventListener("click", () => {
    if (activeSnippetId) {
      if (isDraftSnippetId(activeSnippetId)) {
        showToast("Please save this snippet before exporting", "error");
        return;
      }
      openExportModal([activeSnippetId]);
    }
  });
  document.getElementById("btn-save-active")?.addEventListener("click", saveActiveSnippet);
  document.getElementById("btn-copy-active")?.addEventListener("click", () => {
    if (activeSnippetId) copySnippetById(activeSnippetId);
  });
  document.getElementById("btn-delete-active")?.addEventListener("click", () => {
    if (activeSnippetId) deleteSnippetById(activeSnippetId);
  });

  // Export Modal Actions
  const closeExport = () => {
    if (!exportModalState.isExporting) closeExportModal();
  };
  document.getElementById("btn-close-export")?.addEventListener("click", closeExport);
  document.getElementById("btn-cancel-export")?.addEventListener("click", closeExport);
  document.getElementById("modal-export")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeExport();
  });

  document.querySelectorAll<HTMLInputElement>("[data-export-format]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const fmt = cb.getAttribute("data-export-format") as ExportFormat;
      if (cb.checked) {
        exportModalState.formats.add(fmt);
      } else {
        exportModalState.formats.delete(fmt);
      }
      render();
    });
  });

  document.getElementById("export-base-filename")?.addEventListener("input", (e) => {
    exportModalState.baseFilename = (e.target as HTMLInputElement).value;
    const hintEl = document.querySelector(".export-hint");
    if (hintEl) {
      const cnt = exportModalState.formats.size;
      const base = exportModalState.baseFilename || "snippets-export";
      if (cnt === 1) {
        hintEl.innerHTML = `Save dialog will prompt to save <strong>${escapeHtml(base)}.${Array.from(exportModalState.formats)[0]}</strong>.`;
      } else if (cnt > 1) {
        hintEl.innerHTML = `Directory dialog will prompt for a folder, and save all ${cnt} chosen files there.`;
      } else {
        hintEl.innerHTML = `<span style="color:var(--rose);">Please select at least one format above.</span>`;
      }
    }
  });

  document.getElementById("btn-confirm-export")?.addEventListener("click", () => {
    void executeExport();
  });

  // Export Success Modal Actions
  const closeExportSuccess = () => closeExportSuccessModal();
  document.getElementById("btn-close-export-success")?.addEventListener("click", closeExportSuccess);
  document.getElementById("btn-done-export-success")?.addEventListener("click", closeExportSuccess);
  document.getElementById("modal-export-success")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeExportSuccess();
  });

  document.querySelectorAll<HTMLButtonElement>(".btn-open-exported-file").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const path = btn.getAttribute("data-file-path");
      if (!path) return;
      try {
        await openPath(path);
      } catch (err) {
        showToast(`Could not open file: ${err}`, "error");
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>(".btn-reveal-exported-file").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const path = btn.getAttribute("data-file-path");
      if (!path) return;
      try {
        await revealItemInDir(path);
      } catch (err) {
        showToast(`Could not reveal file in folder: ${err}`, "error");
      }
    });
  });

  document.getElementById("btn-cancel-confirmation")?.addEventListener("click", () => {
    confirmationDialog = null;
    render();
  });

  document.getElementById("modal-confirmation")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      confirmationDialog = null;
      render();
    }
  });

  document.getElementById("btn-confirmation-confirm")?.addEventListener("click", async () => {
    const pending = confirmationDialog;
    if (!pending) return;
    confirmationDialog = null;
    render();
    try {
      await pending.action();
    } catch (err) {
      showToast(`Action failed: ${err}`, "error");
    }
  });

  // Editor Mode Tabs & Sync Scroll
  const editorMode = snapshot.settings.editorMode || "split";

  document.querySelectorAll("[data-editor-mode]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const mode = (e.currentTarget as HTMLElement).getAttribute(
        "data-editor-mode"
      ) as "split" | "edit" | "preview";
      preserveRenderedEditorState();
      snapshot.settings.editorMode = mode;
      render();
    });
  });

  // Sync Scroll Toggle Button
  document.getElementById("btn-toggle-sync-scroll")?.addEventListener("click", () => {
    preserveRenderedEditorState();
    syncScrollEnabled = !syncScrollEnabled;
    localStorage.setItem("snippetbox-sync-scroll", String(syncScrollEnabled));
    showToast(syncScrollEnabled ? "Sync scroll enabled" : "Sync scroll disabled");
    render();
  });

  // Live editor typing updates live preview
  const editorTextarea = document.getElementById(
    "editor-textarea"
  ) as HTMLTextAreaElement | null;
  const detailTitleInput = document.getElementById(
    "detail-title"
  ) as HTMLInputElement | null;
  if (detailTitleInput) {
    detailTitleInput.addEventListener("input", () => {
      if (!activeSnippetId?.startsWith("new-")) return;
      const value = detailTitleInput.value.trim();
      if (!value) {
        autoTitleEnabled = true;
        autoTitleValue = "";
      } else if (value !== autoTitleValue) {
        autoTitleEnabled = false;
      }
    });
  }

  if (editorTextarea) {
    editorTextarea.addEventListener("input", () => {
      const preview = document.getElementById("preview-content");
      if (preview) {
        preview.innerHTML = renderMarkdown(editorTextarea.value);
      }

      if (syncScrollEnabled && editorMode === "split") {
        const previewPane = document.querySelector(".preview-pane") as HTMLElement | null;
        if (previewPane) {
          const maxEditor = editorTextarea.scrollHeight - editorTextarea.clientHeight;
          const maxPreview = previewPane.scrollHeight - previewPane.clientHeight;
          if (maxEditor > 0 && maxPreview > 0) {
            const ratio = editorTextarea.scrollTop / maxEditor;
            previewPane.scrollTop = Math.round(ratio * maxPreview);
          }
        }
      }

      updateDraftTitleFromContent(editorTextarea.value);
    });

    // Handle Tab key inside textarea
    editorTextarea.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const start = editorTextarea.selectionStart;
        const end = editorTextarea.selectionEnd;
        editorTextarea.value =
          editorTextarea.value.substring(0, start) +
          "  " +
          editorTextarea.value.substring(end);
        editorTextarea.selectionStart = editorTextarea.selectionEnd = start + 2;
        editorTextarea.dispatchEvent(new Event("input"));
      }
    });
  }

  // Synchronized scrolling between Editor and Preview in Split View
  const previewPane = document.querySelector(".preview-pane") as HTMLElement | null;
  if (editorTextarea && previewPane && editorMode === "split" && syncScrollEnabled) {
    let isSyncingLeft = false;
    let isSyncingRight = false;

    // Initially synchronize preview with editor position if editor has scroll position
    const initialMaxEditor = editorTextarea.scrollHeight - editorTextarea.clientHeight;
    const initialMaxPreview = previewPane.scrollHeight - previewPane.clientHeight;
    if (initialMaxEditor > 0 && initialMaxPreview > 0 && editorTextarea.scrollTop > 0) {
      previewPane.scrollTop = Math.round((editorTextarea.scrollTop / initialMaxEditor) * initialMaxPreview);
    }

    editorTextarea.addEventListener("scroll", () => {
      if (!syncScrollEnabled) return;
      if (isSyncingLeft) {
        isSyncingLeft = false;
        return;
      }
      const maxEditor = editorTextarea.scrollHeight - editorTextarea.clientHeight;
      const maxPreview = previewPane.scrollHeight - previewPane.clientHeight;
      if (maxEditor > 0 && maxPreview > 0) {
        const ratio = editorTextarea.scrollTop / maxEditor;
        const targetScroll = Math.round(ratio * maxPreview);
        if (Math.abs(previewPane.scrollTop - targetScroll) > 1) {
          isSyncingRight = true;
          previewPane.scrollTop = targetScroll;
        }
      }
      requestAnimationFrame(() => {
        isSyncingRight = false;
        isSyncingLeft = false;
      });
    }, { passive: true });

    previewPane.addEventListener("scroll", () => {
      if (!syncScrollEnabled) return;
      if (isSyncingRight) {
        isSyncingRight = false;
        return;
      }
      const maxPreview = previewPane.scrollHeight - previewPane.clientHeight;
      const maxEditor = editorTextarea.scrollHeight - editorTextarea.clientHeight;
      if (maxPreview > 0 && maxEditor > 0) {
        const ratio = previewPane.scrollTop / maxPreview;
        const targetScroll = Math.round(ratio * maxEditor);
        if (Math.abs(editorTextarea.scrollTop - targetScroll) > 1) {
          isSyncingLeft = true;
          editorTextarea.scrollTop = targetScroll;
        }
      }
      requestAnimationFrame(() => {
        isSyncingRight = false;
        isSyncingLeft = false;
      });
    }, { passive: true });
  }

  // Code copy buttons in preview
  document.querySelectorAll(".code-copy-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const target = e.currentTarget as HTMLElement;
      const code = decodeURIComponent(target.getAttribute("data-code") || "");
      await navigator.clipboard.writeText(code);
      target.innerHTML = `${icon("check")} Copied!`;
      setTimeout(() => {
        target.innerHTML = `${icon("copy")} Copy`;
      }, 2000);
      showToast("Code block copied to clipboard!");
    });
  });

  // Clickable links in markdown preview open in external browser
  document.getElementById("preview-content")?.addEventListener("click", async (e) => {
    const link = (e.target as HTMLElement).closest("a");
    if (link && link.href) {
      e.preventDefault();
      try {
        await openUrl(link.href);
      } catch (err) {
        console.error("Failed to open external link:", err);
      }
    }
  });

  // Settings Modal Handlers
  const openSettings = (tab: "ai" | "preferences" | "backup" = "ai") => {
    settingsModalOpen = true;
    settingsActiveTab = tab;
    connectionTestResult = null;
    render();
    if (tab === "backup") {
      void invoke<DatabaseInfo>("get_database_info").then((info) => {
        snapshot.databaseInfo = info;
        if (settingsModalOpen && settingsActiveTab === "backup") render();
      }).catch(() => {});
    }
  };
  document.getElementById("btn-open-settings")?.addEventListener("click", () => openSettings());
  document.getElementById("btn-open-backup-sidebar")?.addEventListener("click", () => openSettings("backup"));

  document.querySelectorAll<HTMLButtonElement>("[data-settings-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-settings-tab") as "ai" | "preferences" | "backup";
      if (tab) {
        settingsActiveTab = tab;
        render();
        if (tab === "backup") {
          void invoke<DatabaseInfo>("get_database_info").then((info) => {
            snapshot.databaseInfo = info;
            if (settingsModalOpen && settingsActiveTab === "backup") render();
          }).catch(() => {});
        }
      }
    });
  });

  document.getElementById("btn-start-backup")?.addEventListener("click", () => {
    void triggerBackupData();
  });

  document.getElementById("btn-start-restore")?.addEventListener("click", () => {
    void triggerRestoreData();
  });

  document.getElementById("btn-choose-storage")?.addEventListener("click", async () => {
    const selected = await open({
      title: "Choose SnippetBox storage folder",
      directory: true,
      multiple: false,
      defaultPath: snapshot.databaseInfo.directory || undefined,
    });
    if (typeof selected === "string") {
      const input = document.getElementById("storage-directory") as HTMLInputElement | null;
      if (input) input.value = selected;
    }
  });

  document.getElementById("btn-save-storage")?.addEventListener("click", () => {
    void moveStorage();
  });

  const closeBackupModal = () => {
    backupModalState = null;
    render();
  };

  document.getElementById("btn-close-backup-op")?.addEventListener("click", closeBackupModal);
  document.getElementById("btn-done-backup-op")?.addEventListener("click", closeBackupModal);
  document.getElementById("btn-cancel-backup-op")?.addEventListener("click", closeBackupModal);
  document.getElementById("modal-backup-op")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget && !activeDataOperationId) {
      closeBackupModal();
    }
  });

  document.getElementById("btn-cancel-active-op")?.addEventListener("click", () => {
    void cancelCurrentDataOperation();
  });

  document.getElementById("btn-confirm-restore")?.addEventListener("click", () => {
    void confirmAndRunRestore();
  });

  document.getElementById("btn-reload-after-restore")?.addEventListener("click", () => {
    window.location.reload();
  });

  document.getElementById("btn-close-settings")?.addEventListener("click", () => {
    settingsModalOpen = false;
    render();
  });

  document.getElementById("btn-cancel-settings")?.addEventListener("click", () => {
    settingsModalOpen = false;
    render();
  });

  document.querySelectorAll("[data-select-provider]").forEach((card) => {
    card.addEventListener("click", () => {
      const provider = card.getAttribute("data-select-provider") as "local" | "openai";
      snapshot.settings.provider = provider;
      render();
    });
  });

  // Presets
  document.querySelectorAll("[data-preset-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.getAttribute("data-preset-idx") || "0", 10);
      const preset = PROVIDER_PRESETS[idx];
      if (!preset) return;
      const urlInput = document.getElementById("setting-openai-url") as HTMLInputElement;
      const modelInput = document.getElementById("setting-openai-model") as HTMLInputElement;
      const dimsInput = document.getElementById("setting-openai-dims") as HTMLInputElement;
      if (urlInput) urlInput.value = preset.url;
      if (modelInput) modelInput.value = preset.model;
      if (dimsInput) dimsInput.value = String(preset.dims);
      showToast(`Loaded ${preset.name} preset!`);
    });
  });

  // Toggle API key visibility
  document.getElementById("btn-toggle-key-visibility")?.addEventListener("click", () => {
    const keyInput = document.getElementById("setting-openai-key") as HTMLInputElement;
    const toggleBtn = document.getElementById("btn-toggle-key-visibility");
    if (keyInput && toggleBtn) {
      if (keyInput.type === "password") {
        keyInput.type = "text";
        toggleBtn.textContent = "Hide";
      } else {
        keyInput.type = "password";
        toggleBtn.textContent = "Show";
      }
    }
  });

  document.getElementById("btn-test-connection")?.addEventListener("click", async () => {
    const url = (document.getElementById("setting-openai-url") as HTMLInputElement)?.value;
    const key = (document.getElementById("setting-openai-key") as HTMLInputElement)?.value;
    const model = (document.getElementById("setting-openai-model") as HTMLInputElement)?.value;
    const dims = parseInt(
      (document.getElementById("setting-openai-dims") as HTMLInputElement)?.value || "512",
      10
    );

    if (!Number.isInteger(dims) || dims < 0) {
      showToast("Dimensions must be a nonnegative integer", "error");
      return;
    }

    const testSettings: AppSettings = {
      ...snapshot.settings,
      openaiBaseUrl: url,
      openaiApiKey: key,
      openaiModel: model,
      openaiDimensions: dims,
    };

    isTestingConnection = true;
    render();

    try {
      const res = await invoke<TestProviderResult>("test_provider_settings", {
        settings: testSettings,
      });
      connectionTestResult = res;
      if (res.success) {
        showToast("Embeddings provider connection successful!");
      } else {
        showToast(`Connection error: ${res.error}`, "error");
      }
    } catch (err) {
      connectionTestResult = {
        success: false,
        dimension: 0,
        latencyMs: 0,
        error: String(err),
      };
    } finally {
      isTestingConnection = false;
      render();
    }
  });

  document.getElementById("btn-save-settings")?.addEventListener("click", async () => {
    const url = (document.getElementById("setting-openai-url") as HTMLInputElement)?.value;
    const key = (document.getElementById("setting-openai-key") as HTMLInputElement)?.value;
    const model = (document.getElementById("setting-openai-model") as HTMLInputElement)?.value;
    const dims = parseInt(
      (document.getElementById("setting-openai-dims") as HTMLInputElement)?.value || "512",
      10
    );
    const theme = document.querySelector<HTMLElement>("[data-select-picker='setting-theme']")
      ?.dataset.selectedValue as "dark" | "light";
    const editorMode = document.querySelector<HTMLElement>("[data-select-picker='setting-editor-mode']")
      ?.dataset.selectedValue as "split" | "edit" | "preview";
    const snippetOpenMode = document.querySelector<HTMLElement>("[data-select-picker='setting-snippet-open-mode']")
      ?.dataset.selectedValue as "new_tab" | "current_tab";

    if (!Number.isInteger(dims) || dims < 0) {
      showToast("Dimensions must be a nonnegative integer", "error");
      return;
    }

    snapshot.settings.openaiBaseUrl = url || "https://api.openai.com/v1";
    snapshot.settings.openaiApiKey = key || "";
    snapshot.settings.openaiModel = model || "text-embedding-3-small";
    snapshot.settings.openaiDimensions = dims;
    snapshot.settings.theme = theme || "dark";
    snapshot.settings.editorMode = editorMode || "split";
    snapshot.settings.openSnippetsInNewTabs = snippetOpenMode !== "current_tab";

    try {
      await invoke("update_settings", { settings: snapshot.settings });
      settingsModalOpen = false;
      document.documentElement.setAttribute("data-theme", snapshot.settings.theme);
      const fresh = await invoke<AppSnapshot>("get_app_snapshot");
      snapshot = fresh;
      await performSearch();
      showToast("Settings saved successfully!");
      render();
    } catch (err) {
      showToast(`Failed to save settings: ${err}`, "error");
    }
  });

  document.getElementById("btn-reindex")?.addEventListener("click", async () => {
    isReindexing = true;
    render();
    try {
      const count = await invoke<number>("reindex_all_embeddings");
      await performSearch();
      showToast(`Re-indexed ${count} snippets with active provider!`);
    } catch (err) {
      showToast(`Reindexing failed: ${err}`, "error");
    } finally {
      isReindexing = false;
      render();
    }
  });

  // Collection Modal Handlers
  document.getElementById("btn-add-collection")?.addEventListener("click", () => {
    editingCollection = null;
    collectionModalOpen = true;
    render();
    requestAnimationFrame(() => {
      document.getElementById("collection-name-input")?.focus();
    });
  });

  document.getElementById("btn-close-collection")?.addEventListener("click", () => {
    collectionModalOpen = false;
    editingCollection = null;
    render();
  });

  document.getElementById("btn-cancel-collection")?.addEventListener("click", () => {
    collectionModalOpen = false;
    editingCollection = null;
    render();
  });

  document.getElementById("btn-save-collection")?.addEventListener("click", async () => {
    const nameInput = document.getElementById("collection-name-input") as HTMLInputElement;
    const colorInput = document.getElementById("collection-color-input") as HTMLInputElement;
    const name = nameInput?.value.trim();
    if (!name) {
      showToast("Please enter a collection name", "error");
      return;
    }

    const newCol: Collection = {
      id: editingCollection ? editingCollection.id : `col-${Date.now()}`,
      name,
      description: editingCollection?.description,
      color: editingCollection?.color || colorInput?.value || "#10b981",
      createdAt: editingCollection?.createdAt || new Date().toISOString(),
    };

    try {
      await invoke("save_collection", { collection: newCol });
      collectionModalOpen = false;
      const action = editingCollection ? "renamed" : "saved";
      editingCollection = null;
      showToast(`Collection "${name}" ${action}!`);
      const fresh = await invoke<AppSnapshot>("get_app_snapshot");
      snapshot = fresh;
      render();
    } catch (err) {
      showToast(`Failed to save collection: ${err}`, "error");
    }
  });
}

function setupGlobalEventListeners() {
  // Close popovers on outside click
  window.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest(".filter-picker") && !target.closest(".single-select")) {
      if (collectionPopoverOpen || datePopoverOpen || openSelectId) {
        closeFilterPopovers();
        setSingleSelectOpen(null);
      }
    }
  });

  // Global Keyboard Shortcuts
  window.addEventListener("keydown", async (e) => {
    const meta = e.metaKey || e.ctrlKey;

    if (meta && !e.altKey && (e.key === "+" || e.key === "=")) {
      e.preventDefault();
      await stepInterfaceScale(1);
    } else if (meta && !e.altKey && e.key === "-") {
      e.preventDefault();
      await stepInterfaceScale(-1);
    } else if (meta && !e.altKey && e.key === "0") {
      e.preventDefault();
      await setInterfaceScale(DEFAULT_INTERFACE_SCALE);
    } else if (meta && e.key.toLowerCase() === "n") {
      e.preventDefault();
      createNewSnippet();
    } else if (meta && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveActiveSnippet();
    } else if (meta && e.key.toLowerCase() === "k") {
      e.preventDefault();
      const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
      if (searchInput) searchInput.focus();
    } else if (meta && e.key === ",") {
      e.preventDefault();
      settingsModalOpen = true;
      render();
    } else if (e.key === "Escape") {
      if (backupModalState) {
        if (!activeDataOperationId) {
          backupModalState = null;
          render();
        }
      } else if (confirmationDialog) {
        confirmationDialog = null;
        render();
      } else if (bulkMoveModalOpen || bulkTagModalOpen) {
        closeBulkActionModals();
        render();
      } else if (openSelectId) {
        setSingleSelectOpen(null);
      } else if (importModalOpen && !isImportingText) {
        importModalOpen = false;
        render();
      } else if (settingsModalOpen || collectionModalOpen) {
        settingsModalOpen = false;
        collectionModalOpen = false;
        editingCollection = null;
        render();
      } else if (selectedSnippetIds.size > 0) {
        clearSnippetSelection();
        render();
      }
    }
  });
}

// Logic implementations
function createNewSnippet() {
  // If an empty temp snippet is already active/present, switch to it and focus
  const existingEmpty = snapshot.snippets.find(
    (s) => s.id.startsWith("new-") && !s.title && !s.content
  );
  if (existingEmpty) {
    if (!openSnippetIds.includes(existingEmpty.id)) openSnippetIds.push(existingEmpty.id);
    activeSnippetId = existingEmpty.id;
    beginDraftTitleTracking(existingEmpty.id);
    render();
    focusNewSnippetEditor();
    return;
  }

  const newId = `new-${Date.now()}`;
  const newSnippet: Snippet = {
    id: newId,
    title: "",
    content: "",
    language: "markdown",
    collectionId:
      filterState.collectionIds && filterState.collectionIds.length === 1
        ? filterState.collectionIds[0]
        : "default",
    tags: [],
    keywords: [],
    favorite: false,
    copyCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastCopiedAt: null,
  };

  snapshot.snippets.unshift(newSnippet);
  openSnippet(newSnippet.id);
  beginDraftTitleTracking(newSnippet.id);
  render();
  focusNewSnippetEditor();
}

function closeTextImportModal(): void {
  if (isImportingText) return;
  importModalOpen = false;
  setSingleSelectOpen(null);
  render();
}

async function chooseAndImportText(directory: boolean): Promise<void> {
  if (isImportingText) return;

  try {
    const selected = await open({
      directory,
      multiple: true,
      title: directory ? "Choose folders to import recursively" : "Choose text files to import",
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return;

    isImportingText = true;
    setSingleSelectOpen(null);
    render();
    const job = await invoke<TextImportJob>("enqueue_text_import", {
      paths,
      collectionId: importCollectionId,
    });
    textImportJobs = [job, ...textImportJobs.filter((item) => item.id !== job.id)].slice(0, 10);
    importModalOpen = false;
    showToast("Import queued. You can keep using SnippetBox.");
  } catch (error) {
    showToast(`Import failed: ${error}`, "error");
  } finally {
    isImportingText = false;
    render();
  }
}

function beginDraftTitleTracking(id: string): void {
  autoTitleDraftId = id;
  autoTitleValue = "";
  autoTitleEnabled = true;
}

function focusNewSnippetEditor(): void {
  window.setTimeout(() => {
    const editor = document.getElementById("editor-textarea") as HTMLTextAreaElement | null;
    if (!editor) return;
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }, 0);
}

function deriveTitleFromContent(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const title = line
      .trim()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    if (title) return title;
  }
  return "";
}

function updateDraftTitleFromContent(content: string): void {
  if (!activeSnippetId?.startsWith("new-")) return;

  const titleInput = document.getElementById("detail-title") as HTMLInputElement | null;
  const activeSnippet = getActiveSnippet();
  if (!titleInput || !activeSnippet) return;

  if (autoTitleDraftId !== activeSnippetId) {
    beginDraftTitleTracking(activeSnippetId);
  }
  if (!autoTitleEnabled) return;

  const title = deriveTitleFromContent(content);
  titleInput.value = title;
  autoTitleValue = title;
  activeSnippet.title = title;
}

async function saveActiveSnippet() {
  const title = (document.getElementById("detail-title") as HTMLInputElement)?.value;
  const content = (document.getElementById("editor-textarea") as HTMLTextAreaElement)?.value || "";
  const language = getActiveSnippet()?.language || "markdown";
  const collectionId =
    document.querySelector<HTMLElement>("[data-select-picker='detail-collection']")
      ?.dataset.selectedValue || getActiveSnippet()?.collectionId;
  const rawTags = (document.getElementById("detail-tags") as HTMLInputElement)?.value || "";

  if (!content.trim() && !title?.trim()) {
    showToast("Cannot save empty snippet", "error");
    return;
  }

  const tags = rawTags
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const isNew = Boolean(activeSnippetId?.startsWith("new-"));
  const previousId = activeSnippetId;
  const input: SnippetInput = {
    id: isNew ? undefined : (activeSnippetId || undefined),
    title: title || undefined,
    content,
    language,
    collectionId,
    tags,
    favorite: getActiveSnippet()?.favorite || false,
  };

  try {
    const saved = await invoke<Snippet>("save_snippet", { input });
    snapshot.snippets = snapshot.snippets.filter((s) => !s.id.startsWith("new-"));
    if (isNew && previousId) {
      openSnippetIds = openSnippetIds.map((id) => id === previousId ? saved.id : id);
    }
    activeSnippetId = saved.id;
    showToast("Snippet saved & embeddings indexed!");

    // Refresh snapshot
    const fresh = await invoke<AppSnapshot>("get_app_snapshot");
    snapshot = fresh;
    await performSearch();
    render();
    void loadRelatedSnippets(saved.id);
  } catch (err) {
    showToast(`Failed to save snippet: ${err}`, "error");
  }
}

async function copySnippetById(id: string) {
  const snip = snapshot.snippets.find((s) => s.id === id);
  if (!snip) return;

  try {
    await navigator.clipboard.writeText(snip.content);
    await invoke("record_snippet_copy", { id });
    snip.copyCount += 1;
    showToast("Copied to clipboard!");
    render();
  } catch (err) {
    showToast(`Failed to copy: ${err}`, "error");
  }
}

async function toggleFavorite(id: string, buttonEl?: HTMLElement) {
  const snip = snapshot.snippets.find((s) => s.id === id);
  const searchItem = searchResults.find((r) => r.snippet.id === id);

  const currentFav = searchItem?.snippet.favorite ?? snip?.favorite ?? buttonEl?.classList.contains("active-star") ?? false;
  const targetFav = !currentFav;

  // Optimistically update memory
  if (snip) snip.favorite = targetFav;
  if (searchItem) searchItem.snippet.favorite = targetFav;

  // Optimistically update DOM elements immediately
  const buttons = buttonEl
    ? [buttonEl]
    : (Array.from(document.querySelectorAll(`[data-toggle-fav="${id}"]`)) as HTMLElement[]);

  const applyButtonVisuals = (isFav: boolean) => {
    buttons.forEach((b) => {
      if (isFav) {
        b.classList.add("active-star");
        b.innerHTML = icon("star-filled");
        b.title = "Remove favorite";
      } else {
        b.classList.remove("active-star");
        b.innerHTML = icon("star");
        b.title = "Favorite snippet";
      }
    });
  };

  applyButtonVisuals(targetFav);

  const favCountEl = document.querySelector("#nav-favorites .nav-count");
  if (favCountEl) {
    favCountEl.textContent = String(snapshot.snippets.filter((s) => s.favorite).length);
  }

  try {
    const newState = await invoke<boolean>("toggle_favorite", { id });
    if (snip) snip.favorite = newState;
    if (searchItem) searchItem.snippet.favorite = newState;

    if (newState !== targetFav) {
      applyButtonVisuals(newState);
      if (favCountEl) {
        favCountEl.textContent = String(snapshot.snippets.filter((s) => s.favorite).length);
      }
    }

    if (filterState.favoriteOnly) {
      await performSearch();
      render();
    }
  } catch (err) {
    // Revert optimistic updates on failure
    if (snip) snip.favorite = currentFav;
    if (searchItem) searchItem.snippet.favorite = currentFav;
    applyButtonVisuals(currentFav);
    if (favCountEl) {
      favCountEl.textContent = String(snapshot.snippets.filter((s) => s.favorite).length);
    }
    showToast(`Error updating favorite: ${err}`, "error");
  }
}

function deleteSnippetById(id: string): void {
  const snippet = snapshot.snippets.find((item) => item.id === id);
  if (!snippet) return;

  openConfirmationDialog({
    title: "Delete snippet?",
    message: id.startsWith("new-")
      ? "This unsaved snippet will be discarded."
      : `"${snippet.title || "Untitled Snippet"}" will be permanently deleted.`,
    confirmLabel: "Delete snippet",
    action: () => performDeleteSnippet(id),
  });
}

async function performDeleteSnippet(id: string): Promise<void> {
  if (id.startsWith("new-")) {
    snapshot.snippets = snapshot.snippets.filter((s) => s.id !== id);
    searchResults = searchResults.filter((r) => r.snippet.id !== id);
    selectedSnippetIds.delete(id);
    closeSnippetTab(id);
    showToast("Draft deleted");
    render();
    if (activeSnippetId) void loadRelatedSnippets(activeSnippetId);
    return;
  }

  try {
    await invoke("delete_snippet", { id });
    snapshot.snippets = snapshot.snippets.filter((s) => s.id !== id);
    selectedSnippetIds.delete(id);
    closeSnippetTab(id);
    showToast("Snippet deleted");
    await performSearch();
    render();
    if (activeSnippetId) void loadRelatedSnippets(activeSnippetId);
  } catch (err) {
    showToast(`Failed to delete: ${err}`, "error");
  }
}

function openBulkMoveModal(): void {
  const savedIds = getSelectedSavedIds();
  if (savedIds.length === 0) {
    showToast("Select saved snippets to move", "error");
    return;
  }
  const first = snapshot.snippets.find((snippet) => snippet.id === savedIds[0]);
  bulkMoveCollectionId = first?.collectionId || snapshot.collections[0]?.id || "default";
  bulkMoveModalOpen = true;
  bulkTagModalOpen = false;
  render();
}

function openBulkTagModal(): void {
  if (getSelectedSavedIds().length === 0) {
    showToast("Select saved snippets to tag", "error");
    return;
  }
  bulkTagInput = "";
  bulkTagRemove = false;
  bulkTagModalOpen = true;
  bulkMoveModalOpen = false;
  render();
}

async function moveSelectedSnippets(): Promise<void> {
  const ids = getSelectedSavedIds();
  const collectionId = bulkMoveCollectionId;
  if (ids.length === 0) {
    showToast("Select saved snippets to move", "error");
    return;
  }
  if (!collectionId) {
    showToast("Choose a collection", "error");
    return;
  }

  try {
    await invoke("move_snippets", { ids, collectionId });
    ids.forEach((id) => applySnippetCollection(id, collectionId));
    bulkMoveModalOpen = false;
    const collection = snapshot.collections.find((item) => item.id === collectionId);
    showToast(`Moved ${ids.length} ${ids.length === 1 ? "snippet" : "snippets"} to ${collection?.name || "collection"}`);
    await runSearchKeepingPage();
    pruneSnippetSelection();
    render();
  } catch (err) {
    showToast(`Failed to move snippets: ${err}`, "error");
  }
}

async function tagSelectedSnippets(): Promise<void> {
  const ids = getSelectedSavedIds();
  const tags = parseTagList(bulkTagInput);
  if (ids.length === 0) {
    showToast("Select saved snippets to tag", "error");
    return;
  }
  if (tags.length === 0) {
    showToast("Enter at least one tag", "error");
    return;
  }

  try {
    await invoke("tag_snippets", {
      ids,
      add: bulkTagRemove ? [] : tags,
      remove: bulkTagRemove ? tags : [],
    });
    bulkTagModalOpen = false;
    bulkTagInput = "";
    showToast(
      `${bulkTagRemove ? "Removed" : "Added"} ${tags.length} ${tags.length === 1 ? "tag" : "tags"} on ${ids.length} ${ids.length === 1 ? "snippet" : "snippets"}`
    );
    await refreshSnapshotPreservingDrafts();
    await runSearchKeepingPage();
    render();
  } catch (err) {
    showToast(`Failed to update tags: ${err}`, "error");
  }
}

async function setSelectedFavorites(): Promise<void> {
  const ids = getSelectedSavedIds();
  if (ids.length === 0) {
    showToast("Select saved snippets to favorite", "error");
    return;
  }

  const favorite = !allSelectedAreFavorited();
  const previous = new Map(
    ids.map((id) => {
      const snippet =
        snapshot.snippets.find((item) => item.id === id) ||
        searchResults.find((result) => result.snippet.id === id)?.snippet;
      return [id, Boolean(snippet?.favorite)];
    })
  );

  ids.forEach((id) => applySnippetFavorite(id, favorite));
  render();

  try {
    await invoke("set_snippets_favorite", { ids, favorite });
    showToast(
      favorite
        ? `Favorited ${ids.length} ${ids.length === 1 ? "snippet" : "snippets"}`
        : `Removed ${ids.length} ${ids.length === 1 ? "snippet" : "snippets"} from favorites`
    );
    if (filterState.favoriteOnly) await runSearchKeepingPage();
    pruneSnippetSelection();
    render();
  } catch (err) {
    previous.forEach((wasFavorite, id) => applySnippetFavorite(id, wasFavorite));
    showToast(`Failed to update favorites: ${err}`, "error");
    render();
  }
}

function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function openExportModal(snippetIds: string[]) {
  const savedIds = snippetIds.filter((id) => !isDraftSnippetId(id));
  if (savedIds.length === 0) {
    showToast("Select saved snippets to export", "error");
    return;
  }

  exportModalState.isOpen = true;
  exportModalState.snippetIds = savedIds;
  exportModalState.formats = new Set<ExportFormat>(["pdf"]);
  exportModalState.isExporting = false;
  exportModalState.progressPercent = 0;
  exportModalState.progressStage = "Preparing export…";
  exportModalState.progressCurrent = 0;
  exportModalState.progressTotal = savedIds.length;
  exportModalState.error = null;

  if (savedIds.length === 1) {
    const s = snapshot.snippets.find((x) => x.id === savedIds[0]);
    const cleanTitle = s?.title ? sanitizeFilename(s.title) : "snippet";
    exportModalState.baseFilename = cleanTitle || "snippet";
  } else {
    exportModalState.baseFilename = `snippets-export-${new Date().toISOString().slice(0, 10)}`;
  }

  render();
}

function closeExportModal() {
  exportModalState.isOpen = false;
  exportModalState.isExporting = false;
  render();
}

function closeExportSuccessModal() {
  exportSuccessState.isOpen = false;
  render();
}

async function exportSelectedSnippets(): Promise<void> {
  const ids = getSelectedSavedIds();
  if (ids.length === 0) {
    showToast("Select saved snippets to export", "error");
    return;
  }
  openExportModal(ids);
}

async function executeExport(): Promise<void> {
  if (exportModalState.formats.size === 0) {
    showToast("Please select at least one format to export", "error");
    return;
  }

  const ids = exportModalState.snippetIds;
  if (ids.length === 0) {
    showToast("No snippets selected for export", "error");
    return;
  }

  const baseName = exportModalState.baseFilename.trim() || "snippets-export";
  const formats = Array.from(exportModalState.formats);

  // Prompt for destination before starting background generation
  let targetPathSingle: string | null = null;
  let targetDirMultiple: string | null = null;

  if (formats.length === 1) {
    const fmt = formats[0];
    const filterName =
      fmt === "pdf" ? "PDF Document" : fmt === "html" ? "HTML Webpage" : "JSON Document";
    const defaultFilename = `${baseName}.${fmt}`;

    targetPathSingle = await save({
      defaultPath: defaultFilename,
      title: `Export Snippets as ${fmt.toUpperCase()}`,
      filters: [{ name: filterName, extensions: [fmt] }],
    });

    if (!targetPathSingle) {
      // User cancelled picker
      return;
    }
  } else {
    const selectedDir = await open({
      directory: true,
      multiple: false,
      title: `Select Destination Folder for ${formats.length} Export Files`,
    });

    if (!selectedDir || typeof selectedDir !== "string") {
      // User cancelled picker
      return;
    }
    targetDirMultiple = selectedDir;
  }

  // Keep dialog open and transition to live background generation progress view
  exportModalState.isExporting = true;
  exportModalState.progressPercent = 0;
  exportModalState.progressStage = "Preparing background worker…";
  exportModalState.progressCurrent = 0;
  exportModalState.progressTotal = ids.length;
  exportModalState.error = null;
  render();

  const handleProgress = (evt: { percent: number; stage: string; current: number; total: number }) => {
    exportModalState.progressPercent = evt.percent;
    exportModalState.progressStage = evt.stage;
    exportModalState.progressCurrent = evt.current;
    exportModalState.progressTotal = evt.total;

    // Fast direct DOM update to keep UI ultra smooth
    const stageEl = document.getElementById("export-progress-stage");
    const fillEl = document.getElementById("export-progress-bar-fill");
    const pctEl = document.getElementById("export-progress-percent");
    const countsEl = document.getElementById("export-progress-counts");

    if (stageEl) stageEl.textContent = evt.stage;
    if (fillEl) fillEl.style.width = `${Math.max(5, Math.min(100, evt.percent))}%`;
    if (pctEl) pctEl.textContent = `${evt.percent}%`;
    if (countsEl && evt.current > 0) {
      countsEl.textContent = `${evt.current} of ${evt.total} processed`;
    }
  };

  try {
    handleProgress({
      percent: 5,
      stage: "Retrieving snippets from database…",
      current: 0,
      total: ids.length,
    });

    const snippets = await invoke<Snippet[]>("get_snippets_for_export", { ids });
    if (!snippets || snippets.length === 0) {
      throw new Error("No snippets found to export");
    }

    handleProgress({
      percent: 10,
      stage: "Starting document generation on background thread…",
      current: 0,
      total: snippets.length,
    });

    const generatedResults = await runExportInBackground(
      formats,
      snippets,
      snapshot.collections,
      baseName,
      (evt) => {
        const mappedPercent = Math.round(10 + evt.percent * 0.8);
        handleProgress({
          percent: mappedPercent,
          stage: evt.stage,
          current: evt.current,
          total: evt.total,
        });
      }
    );

    handleProgress({
      percent: 92,
      stage: "Writing exported files to disk…",
      current: snippets.length,
      total: snippets.length,
    });

    const savedFiles: ExportedFileRecord[] = [];

    if (formats.length === 1 && targetPathSingle) {
      const fmt = formats[0];
      const result = generatedResults.find((r) => r.format === fmt);
      if (!result) throw new Error(`Export data missing for ${fmt}`);

      const filename = targetPathSingle.split(/[\\/]/).pop() || `${baseName}.${fmt}`;

      if (fmt === "pdf") {
        const bytes = Array.from(new Uint8Array(result.data as ArrayBuffer));
        await invoke("save_export_binary_file", { path: targetPathSingle, bytes });
      } else {
        await invoke("save_export_text_file", { path: targetPathSingle, content: result.data as string });
      }

      savedFiles.push({
        format: fmt,
        path: targetPathSingle,
        filename,
      });
    } else if (targetDirMultiple) {
      const sep = targetDirMultiple.includes("\\") ? "\\" : "/";
      const cleanDir = targetDirMultiple.replace(/[\\/]+$/, "");

      for (const fmt of formats) {
        const result = generatedResults.find((r) => r.format === fmt);
        if (!result) continue;

        const filename = `${baseName}.${fmt}`;
        const filePath = `${cleanDir}${sep}${filename}`;

        if (fmt === "pdf") {
          const bytes = Array.from(new Uint8Array(result.data as ArrayBuffer));
          await invoke("save_export_binary_file", { path: filePath, bytes });
        } else {
          await invoke("save_export_text_file", { path: filePath, content: result.data as string });
        }

        savedFiles.push({
          format: fmt,
          path: filePath,
          filename,
        });
      }
    }

    handleProgress({
      percent: 100,
      stage: "Export complete!",
      current: snippets.length,
      total: snippets.length,
    });

    exportModalState.isOpen = false;
    exportModalState.isExporting = false;
    exportSuccessState = {
      isOpen: true,
      snippetCount: snippets.length,
      files: savedFiles,
    };

    showToast(
      `Exported ${snippets.length} ${snippets.length === 1 ? "snippet" : "snippets"} to ${savedFiles.length} ${savedFiles.length === 1 ? "format" : "formats"}`
    );
    render();
  } catch (err) {
    console.error("Export failed:", err);
    exportModalState.isExporting = false;
    exportModalState.error = String(err);
    showToast(`Export failed: ${err}`, "error");
    render();
  }
}

function deleteSelectedSnippets(): void {
  const ids = [...selectedSnippetIds];
  if (ids.length === 0) return;

  const draftCount = ids.filter((id) => isDraftSnippetId(id)).length;
  const savedCount = ids.length - draftCount;
  const parts: string[] = [];
  if (savedCount > 0) {
    parts.push(
      `${savedCount} saved ${savedCount === 1 ? "snippet" : "snippets"} will be permanently deleted`
    );
  }
  if (draftCount > 0) {
    parts.push(`${draftCount} unsaved ${draftCount === 1 ? "draft" : "drafts"} will be discarded`);
  }

  openConfirmationDialog({
    title: `Delete ${ids.length} ${ids.length === 1 ? "snippet" : "snippets"}?`,
    message: `${parts.join(". ")}.`,
    confirmLabel: ids.length === 1 ? "Delete snippet" : "Delete snippets",
    action: () => performDeleteSelectedSnippets(ids),
  });
}

async function performDeleteSelectedSnippets(ids: string[]): Promise<void> {
  const draftIds = ids.filter((id) => isDraftSnippetId(id));
  const savedIds = ids.filter((id) => !isDraftSnippetId(id));

  if (savedIds.length > 0) {
    await invoke("batch_delete_snippets", { ids: savedIds });
    snapshot.snippets = snapshot.snippets.filter((snippet) => !savedIds.includes(snippet.id));
    for (const id of savedIds) {
      selectedSnippetIds.delete(id);
      closeSnippetTab(id);
    }
  }

  for (const id of draftIds) {
    snapshot.snippets = snapshot.snippets.filter((snippet) => snippet.id !== id);
    searchResults = searchResults.filter((result) => result.snippet.id !== id);
    selectedSnippetIds.delete(id);
    closeSnippetTab(id);
  }

  pruneSnippetSelection();
  showToast(`Deleted ${ids.length} ${ids.length === 1 ? "snippet" : "snippets"}`);
  await runSearchKeepingPage();
  render();
  if (activeSnippetId) void loadRelatedSnippets(activeSnippetId);
}

// Backup & Restore implementations
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function createDataOperationId(): string {
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function moveStorage(overwrite = false): Promise<void> {
  const directory = (document.getElementById("storage-directory") as HTMLInputElement | null)?.value.trim() || "";
  const fileName = (document.getElementById("storage-file-name") as HTMLInputElement | null)?.value.trim() || "";
  const button = document.getElementById("btn-save-storage") as HTMLButtonElement | null;
  if (button) {
    button.disabled = true;
    button.textContent = "Moving…";
  }

  try {
    snapshot.databaseInfo = await invoke<DatabaseInfo>("configure_storage", {
      directory,
      fileName,
      overwrite,
    });
    showToast(`Storage moved to ${snapshot.databaseInfo.path}`);
    render();
  } catch (error) {
    const message = String(error);
    if (!overwrite && message.startsWith("STORAGE_FILE_EXISTS:")) {
      const shouldReplace = await confirm(message.replace("STORAGE_FILE_EXISTS:", ""), {
        title: "Replace storage file?",
        kind: "warning",
      });
      if (shouldReplace) {
        await moveStorage(true);
        return;
      }
    } else {
      showToast(`Failed to move storage: ${message}`, "error");
    }
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.innerHTML = `${icon("check")} Move Storage`;
    }
  }
}

async function triggerBackupData() {
  if (activeDataOperationId !== null) return;
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Destination Directory for SnippetBox Backup",
    });

    if (!selected || typeof selected !== "string") {
      return;
    }

    const operationId = createDataOperationId();
    activeDataOperationId = operationId;
    dataOperationCancellationPending = false;

    backupModalState = {
      type: "backup-progress",
      title: "Creating Backup Snapshot…",
      message: "Flushing database, verifying integrity, and staging files…",
      path: selected,
      operationId,
      cancellationPending: false,
    };
    render();

    const result = await invoke<BackupResult>("backup_data", {
      destinationDir: selected,
      operationId,
    });

    backupModalState = {
      type: "backup-success",
      title: "Backup Created Successfully",
      backupResult: result,
      path: result.target_dir,
    };
    showToast(`Backup created: ${result.folder_name}`);
    render();
  } catch (error: any) {
    const message = String(error);
    backupModalState = null;
    if (message.includes(BACKUP_CANCELLED_ERROR)) {
      showToast("Backup cancelled safely. No incomplete backup was kept.");
    } else {
      showToast(`Backup failed: ${message}`, "error");
    }
    render();
  } finally {
    activeDataOperationId = null;
    dataOperationCancellationPending = false;
  }
}

async function triggerRestoreData() {
  if (activeDataOperationId !== null) return;
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select a SnippetBox Backup Folder",
    });

    if (!selected || typeof selected !== "string") return;

    backupModalState = {
      type: "restore-inspecting",
      title: "Inspecting Backup…",
      message: "Verifying SQLite integrity and inspecting files…",
      path: selected,
    };
    render();

    const preview = await invoke<BackupPreview>("inspect_backup", {
      backupDir: selected,
    });

    backupModalState = {
      type: "restore-confirm",
      title: "Restore SnippetBox Backup?",
      preview,
      path: preview.backup_dir,
    };
    render();
  } catch (error: any) {
    backupModalState = null;
    showToast(`Restore inspection failed: ${String(error)}`, "error");
    render();
  }
}

async function confirmAndRunRestore() {
  if (!backupModalState?.preview || activeDataOperationId !== null) return;
  const preview = backupModalState.preview;
  const operationId = createDataOperationId();
  activeDataOperationId = operationId;
  dataOperationCancellationPending = false;

  backupModalState = {
    type: "restore-progress",
    title: "Restoring Data…",
    message: "Staging and validating files. Your existing data has not been modified yet.",
    path: preview.backup_dir,
    operationId,
    cancellationPending: false,
  };
  render();

  try {
    const result = await invoke<RestoreResult>("restore_data", {
      backupDir: preview.backup_dir,
      operationId,
      confirmOverwrite: true,
    });

    backupModalState = {
      type: "restore-success",
      title: "Data Restored Successfully",
      restoreResult: result,
      path: result.backup_dir,
    };
    showToast("Data restored successfully!");
    render();
  } catch (error: any) {
    const message = String(error);
    backupModalState = null;
    if (message.includes(BACKUP_CANCELLED_ERROR)) {
      showToast("Restore cancelled safely. Your existing data was not changed.");
    } else {
      showToast(`Restore failed: ${message}`, "error");
    }
    render();
  } finally {
    activeDataOperationId = null;
    dataOperationCancellationPending = false;
  }
}

async function cancelCurrentDataOperation() {
  if (!activeDataOperationId || dataOperationCancellationPending) return;
  dataOperationCancellationPending = true;
  if (backupModalState) {
    backupModalState.cancellationPending = true;
    backupModalState.message = "Cancelling operation and cleaning up staging files…";
    render();
  }

  try {
    const accepted = await invoke<boolean>("cancel_data_operation", {
      operationId: activeDataOperationId,
    });
    if (!accepted && activeDataOperationId) {
      if (backupModalState) {
        backupModalState.message = "The final replacement has begun and cannot be interrupted safely.";
        render();
      }
    }
  } catch (err) {
    dataOperationCancellationPending = false;
    showToast(`Unable to cancel operation: ${String(err)}`, "error");
  }
}

// Kick off
window.addEventListener("DOMContentLoaded", () => {
  init();
});
