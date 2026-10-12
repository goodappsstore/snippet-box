# SnippetBox — Modern Text & Markdown Snippet Manager

<img src="src-tauri/icons/icon.svg" alt="SnippetBox logo" width="96" height="96" />

A lightning-fast, local-first text and Markdown snippet manager built with **Rust**, **Tauri 2**, **SQLite**, and local **ONNX embeddings**.

## Screenshots

### SnippetBox homescreen

![SnippetBox homescreen](screenshots/snippetbox-home.jpg)

---

## Highlights

* 📝 **Full Markdown Editor & Viewer**: Split-view editor with live rendered preview, comfortable monospace typing, tab indentation, and format shortcuts.
* 🎨 **Syntax-Highlighted Code Blocks**: Highlight.js syntax highlighting across dozens of languages with one-click "Copy code" buttons.
* 🔗 **Clickable External Links**: Safely opens markdown links directly in your default web browser via the Tauri opener plugin.
* 🧠 **Built-in Local ONNX Embeddings**: Bundles `jinaai/jina-embeddings-v2-small-en` (512 dimensions, up to 8192 tokens) running locally offline through ONNX Runtime (`ort`) and Hugging Face `tokenizers`. Zero API keys or cloud dependencies needed!
* 🌐 **OpenAI-Compatible Embeddings Provider**: Option to switch to any OpenAI-compatible API endpoint (such as OpenAI `text-embedding-3-small`, Ollama, LM Studio, vLLM, or LocalAI). Includes an interactive connection tester.
* ⚡ **Hybrid Search**: Fuses vector cosine similarity and full-text keyword indexing (SQLite `FTS5` with BM25 ranking) via **Reciprocal Rank Fusion (RRF)**. Seamlessly toggle between **Hybrid**, **Semantic**, and **Keyword** search modes.
* 🧭 **Tabbed Snippet Viewer**: Keep several snippets open in a horizontally scrollable tab strip, choose whether selections open in a new or current tab, collapse snippet details for a full-height workspace, and hide the snippets browser in a persistent compact rail when you need more room.
* 🔎 **Related Snippets**: Explore up to ten hybrid-ranked related snippets directly below the active snippet's keywords.
* 🏷️ **Automatic Keyword Extraction**: Extracts representative NLP keywords using curated English and code-specific stop-word filtering upon adding or updating any snippet, populating an interactive keyword cloud for instant filtering.
* 📁 **Collections & Scoped Filtering**: Organize snippets into custom collections with personalized colors and rename them from a dedicated dialog. Multi-select collections, tags, languages, and date ranges.
* 📥 **Background Text File Import**: Queue one or many text, Markdown, MDX, or source-code files—or recursively scan entire folders—into a chosen collection while continuing to use the app. Progress is shown unobtrusively, interrupted jobs resume on startup, and binary files are ignored safely.
* 💾 **Custom Storage Location**: Choose the SQLite database folder and filename under **Settings → Backup & Restore**. SnippetBox copies the live database safely, switches to it immediately, and remembers the location for future launches.
* 📤 **Multi-Format Export (PDF, HTML, JSON)**: Export single snippets or bulk selections in beautifully formatted **PDF** documents (selected by default), self-contained standalone **HTML** webpages (featuring dark/light theme switching, live search, syntax highlighting, and copy buttons), and raw **JSON** data. Exports run on a dedicated background Web Worker thread with real-time animated progress to keep the UI fluid, and support single or multiple export formats simultaneously with one-click folder reveal and file opening.
* ☑️ **Bulk Selection & Actions**: Select many snippets with checkboxes, Shift-click, or Cmd/Ctrl-click, then move, tag, favorite, export in multiple formats, or delete them together.
* 📋 **One-Click Quick Copy**: Instant snippet clipboard copying with copy count tracking and toast feedback.
* 🖥️ **Tailored Window Management**: Frameless, modern Nordic Obsidian aesthetic with custom title bar dragging, macOS traffic-light buttons on macOS, and sleek controls on Windows/Linux.
* 🚀 **Multi-Platform CI/CD**: Full GitHub Actions matrix workflow generating production bundles for macOS (Apple Silicon & Intel), Linux (ARM64 & x86_64), and Windows (ARM64 & x86_64).

---

## Architecture & Tech Stack

| Layer | Technologies |
|---|---|
| **Frontend** | TypeScript, Vite 7, Marked, Highlight.js, DOMPurify |
| **Desktop Shell** | Tauri 2 (`@tauri-apps/api`, `tauri-plugin-opener`, `tauri-plugin-dialog`) |
| **Backend** | Rust 2021 |
| **Local Inference** | `ort` (ONNX Runtime 1.28; 1.23.2 on Intel macOS) + `tokenizers` (Hugging Face) |
| **Database** | SQLite 3 (embedding blobs with dimension-independent cosine scoring) + `FTS5` (full-text search) |
| **HTTP Client** | `reqwest` (with rustls) for OpenAI-compatible embeddings |

### App logo

The editable vector source is [`src-tauri/icons/icon.svg`](src-tauri/icons/icon.svg). Its stacked mint and indigo snippet cards match the app's navy palette. The title bar and browser favicon use this SVG directly; desktop and mobile icons are converted from it.

To regenerate the PNG, Windows ICO, macOS ICNS, and mobile assets with the existing Tauri CLI:

```bash
npm run tauri -- icon src-tauri/icons/icon.svg --output src-tauri/icons --ios-color '#090d16'
```

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v20+ recommended) & `npm`
- [Rust](https://rustup.rs/) (1.77.2+)
- Linux release builds use Ubuntu 24.04 for the glibc and C++ runtime required by the prebuilt ONNX Runtime library; Ubuntu 22.04 is unsupported with these binaries.

### Installation & Development

1. Install frontend dependencies:
   ```bash
   npm install
   ```

2. Run in development mode:
   ```bash
   npm run tauri dev
   ```

3. Type-check and verify both frontend and Rust backend:
   ```bash
   npm run check
   ```

4. Build production frontend assets:
   ```bash
   npm run build
   ```

5. Build desktop bundle for your platform:
   ```bash
   npm run tauri build
   ```

### Release Build (Local Testing)

To build a proper production release for local testing, run:

```bash
npm run tauri build
```

This compiles the frontend in production mode and the Rust backend with release
optimizations.

**Artifacts** (paths are relative to `src-tauri/target/release/`):

| Artifact | Path |
| --- | --- |
| Standalone binary | `snippets-manager` |
| macOS app bundle | `bundle/macos/SnippetBox.app` |
| macOS installer | `bundle/dmg/SnippetBox_0.1.0_<arch>.dmg` |

For local testing, the raw binary or the `.app` bundle is fastest — installing
the DMG is optional.

**Faster variants** (skip installer/codesign work):

```bash
# Release binary only, no bundle or installer
npm run tauri build -- --no-bundle

# App bundle only, no DMG
npm run tauri build -- --bundles app
```

**Notes**

- The first release build is slow: `ort`, `tokenizers`, and `sqlite-vec` (with
  bundled SQLite) compile from source and can take several minutes.
- The bundled ONNX model in `src-tauri/resources/model/` is copied into the
  bundle via the `resources` config, so the release app works offline. Ensure
  those files are present or the build will miss them.
- On macOS the build attempts to sign the bundle. If signing fails during local
  testing, either use `--no-bundle` and run the binary directly, or force ad-hoc
  signing with `APPLE_SIGNING_IDENTITY=- npm run tauri build`.
- The main window is configured with `"visible": false` and shown later by the
  frontend, so always launch the release binary or app bundle (not the lib crate
  via `cargo run`).

---

## Embeddings Configuration

### 1. Built-in Local ONNX Provider (Default)
SnippetBox bundles the `jinaai/jina-embeddings-v2-small-en` model directly inside the application:
* Model file: `src-tauri/resources/model/model.onnx`
* Tokenizer: `src-tauri/resources/model/tokenizer.json`
* Dimension: `512`
* Inference runs entirely locally on CPU/Metal with zero network requests.

### 2. Custom OpenAI-Compatible Provider
Navigate to **Settings** (`Cmd/Ctrl + ,`) to switch to a custom provider:
* **Base URL**: e.g., `https://api.openai.com/v1` or `http://localhost:11434/v1` (Ollama)
* **API Key**: API key (leave blank for local servers)
* **Model**: e.g., `text-embedding-3-small`, `bge-m3`, `nomic-embed-text`
* **Dimensions**: 512
* Click **Test Connection** to measure latency and confirm vector dimension.

---

## AI Assistance

Heavy AI assistance used. Not vibe-coded.

## License

MIT — see [LICENSE](LICENSE).

### Search behavior

Keyword search matches any query term with stemming and prefix matching across titles, content, tags, and extracted keywords. Punctuation separates terms. Results use BM25 relevance; hybrid search combines keyword and semantic ranks with reciprocal rank fusion. Displayed scores are relative ranking scores, not match probabilities.

Semantic search uses cosine similarity and excludes nonpositive similarities. Filters apply before ranking and the requested result limit. Embeddings can use any positive dimension supported by the provider; set Dimensions to 0 to use its default. Exact vector scoring scans stored embeddings, which favors correctness for personal snippet libraries over approximate indexing for very large datasets.

On upgrade, the text index is rebuilt and legacy embeddings are invalidated. Missing embeddings are generated automatically on the next semantic or hybrid search. Changing the provider, endpoint, model, or dimensions also invalidates embeddings. The first search after these changes can take longer. Provider failures are reported explicitly; keyword search remains available. Settings also offers manual reindexing, which reports failures instead of claiming success.

### Intel macOS ONNX Runtime

The release workflow downloads the official ONNX Runtime 1.23.2 Intel macOS
archive, verifies its SHA-256 checksum, and bundles its dylib in the app's
Frameworks directory. Intel macOS installers require macOS 13.4 or later. Other targets use ort's prebuilt ONNX Runtime 1.28.
For local Intel macOS builds, extract that archive into
`src-tauri/libs/onnxruntime-intel`, set `ORT_LIB_PATH` to its absolute `lib`
directory and `ORT_PREFER_DYNAMIC_LINK=1`, and pass
`--config src-tauri/tauri.macos-intel.conf.json` to the Tauri CLI.
