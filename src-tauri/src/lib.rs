use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, Monitor, PhysicalPosition, PhysicalRect, PhysicalSize, Runtime, State,
    WebviewWindow,
};
use uuid::Uuid;

mod backup;
mod db;
mod embedding;
mod keyword;
mod models;

use db::Database;
use embedding::{EmbeddingService, LocalOnnxEmbedder};
use keyword::extract_keywords;
use models::{
    AppSettings, AppSnapshot, Collection, DatabaseInfo, ProviderStatus, SearchFilter, SearchResult,
    Snippet, SnippetInput, TestProviderResult, TextImportJob,
};

pub struct ActiveDataOperation {
    pub operation_id: String,
    pub cancelled: Arc<AtomicBool>,
    pub committing: Arc<AtomicBool>,
}

pub struct AppState {
    pub operation: tokio::sync::Mutex<()>,
    pub db: Arc<Database>,
    pub embedding: Arc<EmbeddingService>,
    pub active_data_operation: std::sync::Mutex<Option<ActiveDataOperation>>,
    pub import_worker_running: AtomicBool,
    pub storage_preference_path: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoragePreference {
    database_path: PathBuf,
}

fn load_storage_preference(path: &Path) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(path).ok()?;
    let preference = serde_json::from_str::<StoragePreference>(&raw).ok()?;
    preference
        .database_path
        .is_absolute()
        .then_some(preference.database_path)
}

fn save_storage_preference(path: &Path, database_path: &Path) -> Result<(), String> {
    let preference = StoragePreference {
        database_path: database_path.to_path_buf(),
    };
    let json = serde_json::to_vec_pretty(&preference)
        .map_err(|e| format!("Failed to encode the storage preference: {e}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| "Storage preference path has no parent folder".to_string())?;
    let suffix = Uuid::new_v4();
    let staging = parent.join(format!(".snippetbox-storage-preference-{suffix}.tmp"));
    std::fs::write(&staging, json)
        .map_err(|e| format!("Failed to stage the storage preference: {e}"))?;

    let replaced = parent.join(format!(".snippetbox-storage-preference-{suffix}.replaced"));
    let had_preference = path.exists();
    if had_preference {
        if let Err(error) = std::fs::rename(path, &replaced) {
            let _ = std::fs::remove_file(&staging);
            return Err(format!(
                "Failed to prepare the storage preference: {error}"
            ));
        }
    }
    if let Err(error) = std::fs::rename(&staging, path) {
        if had_preference {
            let _ = std::fs::rename(&replaced, path);
        }
        let _ = std::fs::remove_file(&staging);
        return Err(format!("Failed to save the storage preference: {error}"));
    }
    if had_preference {
        let _ = std::fs::remove_file(replaced);
    }
    Ok(())
}

#[tauri::command]
async fn get_app_snapshot(state: State<'_, AppState>) -> Result<AppSnapshot, String> {
    let snippets = state.db.list_snippets()?;
    let collections = state.db.list_collections()?;
    let tags = state.db.get_all_tags()?;
    let keywords = state.db.get_all_keywords()?;
    let settings = state.db.get_settings()?;
    let database_info = state.db.get_database_info();

    let provider_status = ProviderStatus {
        local_model_loaded: state.embedding.local_loaded(),
        local_model_name: state.embedding.local_model_name().to_string(),
        local_dimension: 512,
        active_provider: match settings.provider {
            models::EmbeddingProviderType::Local => "local".to_string(),
            models::EmbeddingProviderType::Openai => "openai".to_string(),
        },
        message: if state.embedding.local_loaded() {
            Some("Local ONNX model active (512 dimensions)".to_string())
        } else {
            Some("Local model offline, OpenAI compatible provider required".to_string())
        },
    };

    Ok(AppSnapshot {
        snippets,
        collections,
        tags,
        keywords,
        settings,
        provider_status,
        database_info,
    })
}

#[tauri::command]
async fn get_database_info(state: State<'_, AppState>) -> Result<DatabaseInfo, String> {
    Ok(state.db.get_database_info())
}

#[tauri::command]
async fn configure_storage(
    directory: String,
    file_name: String,
    overwrite: bool,
    state: State<'_, AppState>,
) -> Result<DatabaseInfo, String> {
    let _operation = state.operation.lock().await;
    let directory = PathBuf::from(directory.trim());
    if !directory.is_absolute() {
        return Err("Choose an absolute folder for SnippetBox data".into());
    }

    std::fs::create_dir_all(&directory)
        .map_err(|e| format!("Failed to create the storage folder: {e}"))?;
    let directory = std::fs::canonicalize(&directory)
        .map_err(|e| format!("Failed to resolve the storage folder: {e}"))?;

    let mut file_name = file_name.trim().to_string();
    if file_name.is_empty() {
        return Err("A storage file name is required".into());
    }
    if file_name.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*'
            )
    }) || matches!(file_name.as_str(), "." | "..")
    {
        return Err("The storage file name contains characters that are not portable".into());
    }
    if !Path::new(&file_name)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("sqlite3"))
    {
        file_name.push_str(".sqlite3");
    }

    let new_path = directory.join(file_name);
    if new_path == state.storage_preference_path {
        return Err("Choose a different file name for SnippetBox storage".into());
    }
    let preference_path = state.storage_preference_path.clone();
    state.db.relocate(&new_path, overwrite, || {
        save_storage_preference(&preference_path, &new_path)
    })?;
    Ok(state.db.get_database_info())
}

#[tauri::command]
async fn save_snippet(input: SnippetInput, state: State<'_, AppState>) -> Result<Snippet, String> {
    let _operation = state.operation.lock().await;
    let now = Utc::now().to_rfc3339();
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let settings = state.db.get_settings()?;

    // Derive title if empty: first line of content or "Untitled Snippet"
    let title = input
        .title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| {
            let first_line = input.content.lines().next().unwrap_or("").trim();
            let clean = first_line.trim_start_matches('#').trim();
            if clean.is_empty() {
                "Untitled Snippet".to_string()
            } else if clean.len() > 60 {
                format!("{}…", clean.chars().take(60).collect::<String>())
            } else {
                clean.to_string()
            }
        });

    let language = input
        .language
        .unwrap_or_else(|| "markdown".to_string())
        .to_lowercase();
    let collection_id = input
        .collection_id
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "default".to_string());
    let tags = input.tags.unwrap_or_default();
    let favorite = input.favorite.unwrap_or(false);

    // Extract keywords automatically using NLP tokenization & ranking
    let keywords = extract_keywords(&title, &input.content, 8);

    // Check existing snippet to preserve created_at & copy_count
    let existing = state.db.get_snippet(&id)?;
    let (created_at, copy_count, last_copied_at) = if let Some(e) = existing {
        (e.created_at, e.copy_count, e.last_copied_at)
    } else {
        (now.clone(), 0, None)
    };

    let snippet = Snippet {
        id: id.clone(),
        title: title.clone(),
        content: input.content.clone(),
        language,
        collection_id,
        tags,
        keywords,
        favorite,
        copy_count,
        created_at,
        updated_at: now,
        last_copied_at,
    };

    // Generate embedding from title + content
    let embed_text = format!("{}\n\n{}", snippet.title, snippet.content);
    let embedding_res = state
        .embedding
        .generate_single(&embed_text, &settings)
        .await;

    let embedding_opt = match embedding_res {
        Ok(vec) => Some(vec),
        Err(e) => {
            eprintln!("Warning: Failed to generate embedding for snippet: {e}");
            None
        }
    };

    state.db.save_snippet(&snippet, embedding_opt.as_deref())?;

    Ok(snippet)
}

#[tauri::command]
async fn get_snippet(id: String, state: State<'_, AppState>) -> Result<Option<Snippet>, String> {
    state.db.get_snippet(&id)
}

#[tauri::command]
async fn delete_snippet(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    state.db.delete_snippet(&id)
}

#[tauri::command]
async fn batch_delete_snippets(ids: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    state.db.batch_delete_snippets(&ids)
}

#[tauri::command]
async fn toggle_favorite(id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let _operation = state.operation.lock().await;
    state.db.toggle_favorite(&id)
}

#[tauri::command]
async fn set_snippets_favorite(
    ids: Vec<String>,
    favorite: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    state.db.set_snippets_favorite(&ids, favorite)
}

#[tauri::command]
async fn tag_snippets(
    ids: Vec<String>,
    add: Vec<String>,
    remove: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    state.db.tag_snippets(&ids, &add, &remove)
}

#[tauri::command]
async fn record_snippet_copy(id: String, state: State<'_, AppState>) -> Result<u32, String> {
    let _operation = state.operation.lock().await;
    state.db.record_copy(&id)
}

#[tauri::command]
async fn move_snippets(
    ids: Vec<String>,
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    state.db.move_snippets(&ids, &collection_id)
}

#[tauri::command]
async fn save_collection(collection: Collection, state: State<'_, AppState>) -> Result<(), String> {
    state.db.save_collection(&collection)
}

#[tauri::command]
async fn delete_collection(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    state.db.delete_collection(&id)
}

async fn ensure_snippet_embeddings(
    state: &AppState,
    settings: &AppSettings,
) -> Result<(), String> {
    let missing = state.db.snippets_needing_embeddings()?;
    for chunk in missing.chunks(16) {
        let texts: Vec<String> = chunk
            .iter()
            .map(|snippet| format!("{}\n\n{}", snippet.title, snippet.content))
            .collect();
        let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
        let embeddings = state.embedding.generate_embeddings(&refs, settings).await?;
        if embeddings.len() != chunk.len() {
            return Err("Incomplete embedding batch".into());
        }
        for (snippet, vector) in chunk.iter().zip(&embeddings) {
            state.db.save_snippet(snippet, Some(vector))?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn search_snippets(
    mut filter: SearchFilter,
    state: State<'_, AppState>,
) -> Result<Vec<SearchResult>, String> {
    let _operation = state.operation.lock().await;
    let settings = state.db.get_settings()?;
    filter.search_mode = filter.search_mode.to_lowercase();
    let query_str = filter.query.as_deref().unwrap_or("").trim();

    let query_embedding = if !query_str.is_empty()
        && (filter.search_mode == "hybrid" || filter.search_mode == "semantic")
    {
        // Repair missing or invalidated vectors using the currently selected provider.
        ensure_snippet_embeddings(&state, &settings).await?;
        state
            .embedding
            .generate_single(query_str, &settings)
            .await
            .map(Some)
            .map_err(|e| format!("Embedding search failed: {e}"))?
    } else {
        None
    };

    state.db.hybrid_search(&filter, query_embedding.as_deref())
}

#[tauri::command]
async fn get_related_snippets(
    id: String,
    state: State<'_, AppState>,
) -> Result<Vec<SearchResult>, String> {
    let _operation = state.operation.lock().await;
    let snippet = state
        .db
        .get_snippet(&id)?
        .ok_or_else(|| "Snippet not found".to_string())?;
    let settings = state.db.get_settings()?;

    // Extracted terms keep SQLite full-text matching focused and within practical
    // query limits; the snippet's stored vector supplies the semantic signal.
    let mut terms = vec![snippet.title.clone()];
    terms.extend(snippet.tags.iter().cloned());
    terms.extend(snippet.keywords.iter().cloned());
    let keyword_text = terms.join(" ");

    ensure_snippet_embeddings(&state, &settings).await?;
    let query_embedding = state
        .db
        .get_snippet_embedding(&id)?
        .ok_or_else(|| "Snippet embedding is unavailable".to_string())?;
    let filter = SearchFilter {
        query: Some(keyword_text),
        search_mode: "hybrid".to_string(),
        sort_by: "relevance".to_string(),
        limit: None,
        ..SearchFilter::default()
    };

    let mut results = state.db.hybrid_search(&filter, Some(&query_embedding))?;
    results.retain(|result| result.snippet.id != id);
    results.truncate(10);
    Ok(results)
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    state.db.get_settings()
}

#[tauri::command]
async fn update_settings(settings: AppSettings, state: State<'_, AppState>) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    state.db.save_settings(&settings)
}

#[tauri::command]
async fn test_provider_settings(
    settings: AppSettings,
    state: State<'_, AppState>,
) -> Result<TestProviderResult, String> {
    Ok(state.embedding.test_openai_settings(&settings).await)
}

#[tauri::command]
async fn reindex_all_embeddings(state: State<'_, AppState>) -> Result<usize, String> {
    let _operation = state.operation.lock().await;
    let snippets = state.db.list_snippets()?;
    let settings = state.db.get_settings()?;
    let count = snippets.len();

    // Process in batches of 16 for optimal inference throughput
    let batch_size = 16;
    for chunk in snippets.chunks(batch_size) {
        let texts: Vec<String> = chunk
            .iter()
            .map(|s| format!("{}\n\n{}", s.title, s.content))
            .collect();
        let str_refs: Vec<&str> = texts.iter().map(|s| s.as_str()).collect();

        let embeddings = state
            .embedding
            .generate_embeddings(&str_refs, &settings)
            .await?;
        if embeddings.len() != chunk.len() {
            return Err("Embedding batch returned an unexpected number of results".into());
        }
        for (snip, emb) in chunk.iter().zip(embeddings.iter()) {
            state.db.save_snippet(snip, Some(emb))?;
        }
    }

    Ok(count)
}

fn collect_export_snippets(
    ids: Option<Vec<String>>,
    db: &db::Database,
) -> Result<Vec<Snippet>, String> {
    if let Some(ids) = ids {
        let mut list = Vec::new();
        for id in ids {
            if let Some(s) = db.get_snippet(&id)? {
                list.push(s);
            }
        }
        Ok(list)
    } else {
        db.list_snippets()
    }
}

#[tauri::command]
async fn export_snippets(
    ids: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let snippets = collect_export_snippets(ids, &state.db)?;
    serde_json::to_string_pretty(&snippets)
        .map_err(|e| format!("Failed to serialize export snippets: {e}"))
}

#[tauri::command]
async fn export_snippets_to_file(
    ids: Option<Vec<String>>,
    path: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let snippets = collect_export_snippets(ids, &state.db)?;
    let json = serde_json::to_string_pretty(&snippets)
        .map_err(|e| format!("Failed to serialize export snippets: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write export file: {e}"))?;
    Ok(snippets.len())
}

#[tauri::command]
async fn get_snippets_for_export(
    ids: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Vec<Snippet>, String> {
    collect_export_snippets(ids, &state.db)
}

#[tauri::command]
fn save_export_text_file(path: String, content: String) -> Result<String, String> {
    let p = std::path::PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&p, content).map_err(|e| format!("Failed to write export file '{path}': {e}"))?;
    Ok(path)
}

#[tauri::command]
fn save_export_binary_file(path: String, bytes: Vec<u8>) -> Result<String, String> {
    let p = std::path::PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&p, &bytes).map_err(|e| format!("Failed to write binary export file '{path}': {e}"))?;
    Ok(path)
}

#[tauri::command]
async fn import_snippets(
    snippets_json: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let _operation = state.operation.lock().await;
    let snippets: Vec<Snippet> = serde_json::from_str(&snippets_json)
        .map_err(|e| format!("Failed to parse snippets JSON: {e}"))?;
    let count = snippets.len();
    let settings = state.db.get_settings()?;

    for s in snippets {
        let embed_text = format!("{}\n\n{}", s.title, s.content);
        let emb = state
            .embedding
            .generate_single(&embed_text, &settings)
            .await
            .ok();
        state.db.save_snippet(&s, emb.as_deref())?;
    }

    Ok(count)
}

struct TextImportCandidate {
    file_index: usize,
    title: String,
    content: String,
    language: String,
    keywords: Vec<String>,
}

const TEXT_IMPORT_BATCH_SIZE: usize = 1;

fn prepare_text_import_chunk(
    paths: Vec<(usize, String)>,
) -> (Vec<TextImportCandidate>, usize, usize) {
    let mut candidates = Vec::new();
    let mut skipped_count = 0;
    let mut failed_count = 0;
    for (file_index, raw_path) in paths {
        let path = PathBuf::from(raw_path);
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => {
                failed_count += 1;
                continue;
            }
        };
        let Some(content) = decode_text_file(bytes) else {
            skipped_count += 1;
            continue;
        };
        if content.trim().is_empty() {
            skipped_count += 1;
            continue;
        }
        let title = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Imported snippet".to_string());
        let keywords = extract_keywords(&title, &content, 8);
        candidates.push(TextImportCandidate {
            file_index,
            title,
            language: language_from_path(&path),
            content,
            keywords,
        });
    }
    (candidates, skipped_count, failed_count)
}

fn decode_text_file(bytes: Vec<u8>) -> Option<String> {
    let text = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        String::from_utf8(bytes[3..].to_vec()).ok()?
    } else if bytes.starts_with(&[0xff, 0xfe]) {
        let body = &bytes[2..];
        if body.len() % 2 != 0 {
            return None;
        }
        let units = body
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]));
        String::from_utf16(&units.collect::<Vec<_>>()).ok()?
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        let body = &bytes[2..];
        if body.len() % 2 != 0 {
            return None;
        }
        let units = body
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]));
        String::from_utf16(&units.collect::<Vec<_>>()).ok()?
    } else {
        String::from_utf8(bytes).ok()?
    };

    let suspicious_controls = text
        .chars()
        .filter(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        .count();
    if text.contains('\0')
        || (suspicious_controls > 0 && suspicious_controls * 100 > text.chars().count().max(1))
    {
        None
    } else {
        Some(text)
    }
}

fn language_from_path(path: &Path) -> String {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" => "markdown".to_string(),
        "js" | "mjs" | "cjs" | "jsx" => "javascript".to_string(),
        "ts" | "mts" | "cts" | "tsx" => "typescript".to_string(),
        "py" => "python".to_string(),
        "rb" => "ruby".to_string(),
        "rs" => "rust".to_string(),
        "sh" | "bash" | "zsh" => "shell".to_string(),
        "yml" | "yaml" => "yaml".to_string(),
        "htm" | "html" => "html".to_string(),
        "cs" => "csharp".to_string(),
        "cpp" | "cc" | "cxx" | "hpp" => "cpp".to_string(),
        "txt" | "text" | "log" | "" => "text".to_string(),
        extension => extension.to_string(),
    }
}

fn collect_import_paths(paths: Vec<String>) -> (Vec<PathBuf>, usize, usize) {
    let mut pending: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    let mut skipped = 0;
    let mut failures = 0;

    while let Some(path) = pending.pop() {
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => {
                failures += 1;
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            skipped += 1;
            continue;
        }
        if metadata.is_dir() {
            match std::fs::read_dir(&path) {
                Ok(entries) => {
                    for entry in entries {
                        match entry {
                            Ok(entry) => pending.push(entry.path()),
                            Err(_) => failures += 1,
                        }
                    }
                }
                Err(_) => failures += 1,
            }
        } else if metadata.is_file() {
            let identity = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            if seen.insert(identity) {
                files.push(path);
            }
        } else {
            skipped += 1;
        }
    }

    files.sort();
    (files, skipped, failures)
}

async fn process_text_import_job(
    app: &AppHandle,
    job: db::PendingTextImportJob,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    if !state.db.collection_exists(&job.collection_id)? {
        return Err("The destination collection no longer exists".into());
    }

    let (files, mut skipped_count, mut failed_count) = if let Some(files) = job.files {
        (files, job.skipped_count, job.failed_count)
    } else {
        let paths = job.source_paths;
        let (paths, skipped, failed) = tauri::async_runtime::spawn_blocking(move || {
            collect_import_paths(paths)
        })
        .await
        .map_err(|e| format!("Import scanner stopped unexpectedly: {e}"))?;
        let files = paths
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        (files, skipped, failed)
    };

    {
        let _operation = state.operation.lock().await;
        if !state.db.text_import_job_is_active(&job.id)? {
            return Err("Import was superseded by a data restore".into());
        }
        state
            .db
            .set_text_import_files(&job.id, &files, skipped_count, failed_count)?;
    }
    let settings = state.db.get_settings()?;
    let mut imported_count = job.imported_count;
    let start_index = job.processed_count.min(files.len());

    for chunk_start in (start_index..files.len()).step_by(TEXT_IMPORT_BATCH_SIZE) {
        let chunk_end = (chunk_start + TEXT_IMPORT_BATCH_SIZE).min(files.len());
        let indexed_paths = files[chunk_start..chunk_end]
            .iter()
            .enumerate()
            .map(|(offset, path)| (chunk_start + offset, path.clone()))
            .collect();
        let (candidates, skipped, failed) = tauri::async_runtime::spawn_blocking(move || {
            prepare_text_import_chunk(indexed_paths)
        })
        .await
        .map_err(|e| format!("Import reader stopped unexpectedly: {e}"))?;
        skipped_count += skipped;
        failed_count += failed;

        let embedding_texts: Vec<String> = candidates
            .iter()
            .map(|candidate| format!("{}\n\n{}", candidate.title, candidate.content))
            .collect();
        let embeddings = if embedding_texts.is_empty() {
            None
        } else {
            let text_refs: Vec<&str> = embedding_texts.iter().map(String::as_str).collect();
            state
                .embedding
                .generate_embeddings(&text_refs, &settings)
                .await
                .ok()
        };

        {
            let _operation = state.operation.lock().await;
            if !state.db.text_import_job_is_active(&job.id)? {
                return Err("Import was superseded by a data restore".into());
            }
            for (index, candidate) in candidates.iter().enumerate() {
                let snippet_id = format!("import-{}-{}", job.id, candidate.file_index);
                if state.db.get_snippet(&snippet_id)?.is_some() {
                    imported_count += 1;
                    continue;
                }
                let now = Utc::now().to_rfc3339();
                let snippet = Snippet {
                    id: snippet_id,
                    title: candidate.title.clone(),
                    content: candidate.content.clone(),
                    language: candidate.language.clone(),
                    collection_id: job.collection_id.clone(),
                    tags: Vec::new(),
                    keywords: candidate.keywords.clone(),
                    favorite: false,
                    copy_count: 0,
                    created_at: now.clone(),
                    updated_at: now,
                    last_copied_at: None,
                };
                let embedding = embeddings.as_ref().and_then(|items| items.get(index));
                match state
                    .db
                    .save_snippet(&snippet, embedding.map(Vec::as_slice))
                {
                    Ok(()) => imported_count += 1,
                    Err(_) => failed_count += 1,
                }
            }

            state.db.update_text_import_progress(
                &job.id,
                chunk_end,
                imported_count,
                skipped_count,
                failed_count,
            )?;
        }
        tokio::task::yield_now().await;
    }

    Ok(())
}

fn start_text_import_worker(app: AppHandle) {
    let state = app.state::<AppState>();
    if state
        .import_worker_running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }

    tauri::async_runtime::spawn(async move {
        loop {
            let next_job = {
                let state = app.state::<AppState>();
                let _operation = state.operation.lock().await;
                state.db.claim_next_text_import_job()
            };
            match next_job {
                Ok(Some(job)) => {
                    let job_id = job.id.clone();
                    let result = process_text_import_job(&app, job).await;
                    let state = app.state::<AppState>();
                    let _operation = state.operation.lock().await;
                    let _ = state
                        .db
                        .finish_text_import_job(&job_id, result.as_ref().err().map(String::as_str));
                }
                Ok(None) => {
                    let state = app.state::<AppState>();
                    state.import_worker_running.store(false, Ordering::Release);
                    if state.db.has_queued_text_import_jobs().unwrap_or(false)
                        && state
                            .import_worker_running
                            .compare_exchange(
                                false,
                                true,
                                Ordering::AcqRel,
                                Ordering::Acquire,
                            )
                            .is_ok()
                    {
                        continue;
                    }
                    break;
                }
                Err(_) => {
                    app.state::<AppState>()
                        .import_worker_running
                        .store(false, Ordering::Release);
                    break;
                }
            }
        }
    });
}

#[tauri::command]
async fn enqueue_text_import(
    paths: Vec<String>,
    collection_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TextImportJob, String> {
    let _operation = state.operation.lock().await;
    if paths.is_empty() {
        return Err("Choose at least one file or folder".into());
    }
    if !state.db.collection_exists(&collection_id)? {
        return Err("Target collection does not exist".into());
    }
    let id = Uuid::new_v4().to_string();
    let job = state
        .db
        .enqueue_text_import_job(&id, &paths, &collection_id)?;
    start_text_import_worker(app);
    Ok(job)
}

#[tauri::command]
async fn get_text_import_jobs(state: State<'_, AppState>) -> Result<Vec<TextImportJob>, String> {
    state.db.list_text_import_jobs()
}

#[tauri::command]
async fn backup_data(
    app: AppHandle,
    destination_dir: String,
    operation_id: String,
) -> Result<backup::BackupResult, String> {
    let operation_id = operation_id.trim().to_string();
    if operation_id.is_empty() || operation_id.len() > 128 {
        return Err("Invalid backup operation identifier".into());
    }
    let state = app.state::<AppState>();
    let _operation = state.operation.lock().await;

    let cancelled = Arc::new(AtomicBool::new(false));
    let committing = Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<AppState>();
        let mut active = state
            .active_data_operation
            .lock()
            .map_err(|error| error.to_string())?;
        if active.is_some() {
            return Err("A backup or restore operation is already in progress".into());
        }
        *active = Some(ActiveDataOperation {
            operation_id: operation_id.clone(),
            cancelled: Arc::clone(&cancelled),
            committing: Arc::clone(&committing),
        });
    }

    let worker_app = app.clone();
    let worker_cancelled = Arc::clone(&cancelled);
    let worker_committing = Arc::clone(&committing);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = worker_app.state::<AppState>();
        backup::create_backup(
            &state,
            &destination_dir,
            &worker_cancelled,
            &worker_committing,
        )
    })
    .await
    .map_err(|error| format!("Backup worker stopped unexpectedly: {error}"))
    .and_then(|result| result);

    let state = app.state::<AppState>();
    let mut active = state
        .active_data_operation
        .lock()
        .map_err(|error| error.to_string())?;
    if active
        .as_ref()
        .map(|operation| operation.operation_id.as_str())
        == Some(operation_id.as_str())
    {
        *active = None;
    }
    result
}

#[tauri::command]
async fn inspect_backup(
    app: AppHandle,
    backup_dir: String,
) -> Result<backup::BackupPreview, String> {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = worker_app.state::<AppState>();
        backup::inspect_backup(&state, &backup_dir)
    })
    .await
    .map_err(|error| format!("Backup inspection stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn restore_data(
    app: AppHandle,
    backup_dir: String,
    operation_id: String,
    confirm_overwrite: bool,
) -> Result<backup::RestoreResult, String> {
    if !confirm_overwrite {
        return Err(
            "Restore requires explicit confirmation that existing data will be overwritten".into(),
        );
    }
    let operation_id = operation_id.trim().to_string();
    if operation_id.is_empty() || operation_id.len() > 128 {
        return Err("Invalid restore operation identifier".into());
    }
    let state = app.state::<AppState>();
    let _operation = state.operation.lock().await;

    let cancelled = Arc::new(AtomicBool::new(false));
    let committing = Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<AppState>();
        let mut active = state
            .active_data_operation
            .lock()
            .map_err(|error| error.to_string())?;
        if active.is_some() {
            return Err("A backup or restore operation is already in progress".into());
        }
        *active = Some(ActiveDataOperation {
            operation_id: operation_id.clone(),
            cancelled: Arc::clone(&cancelled),
            committing: Arc::clone(&committing),
        });
    }

    let worker_app = app.clone();
    let worker_cancelled = Arc::clone(&cancelled);
    let worker_committing = Arc::clone(&committing);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = worker_app.state::<AppState>();
        backup::restore_backup(
            &state,
            &backup_dir,
            &worker_cancelled,
            &worker_committing,
        )
    })
    .await
    .map_err(|error| format!("Restore worker stopped unexpectedly: {error}"))
    .and_then(|result| result);

    let state = app.state::<AppState>();
    let mut active = state
        .active_data_operation
        .lock()
        .map_err(|error| error.to_string())?;
    if active
        .as_ref()
        .map(|operation| operation.operation_id.as_str())
        == Some(operation_id.as_str())
    {
        *active = None;
    }
    result
}

#[tauri::command]
fn cancel_data_operation(state: State<AppState>, operation_id: String) -> Result<bool, String> {
    let active = state
        .active_data_operation
        .lock()
        .map_err(|error| error.to_string())?;
    let Some(active) = active.as_ref() else {
        return Ok(false);
    };
    if active.operation_id != operation_id.trim() {
        return Ok(false);
    }
    if active.committing.load(Ordering::Acquire) {
        return Ok(false);
    }
    active.cancelled.store(true, Ordering::Release);
    Ok(true)
}

// Window control commands
#[tauri::command]
async fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
async fn window_maximize(window: WebviewWindow) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn window_close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

// Window positioning helper from shelf-bookmaring-app
struct WindowGeometry {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
}

fn monitor_for_window<R: Runtime>(window: &WebviewWindow<R>) -> Option<Monitor> {
    window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .or_else(|| {
            window
                .available_monitors()
                .ok()
                .and_then(|monitors| monitors.into_iter().next())
        })
}

fn constrained_window_geometry(
    geometry: WindowGeometry,
    work_area: PhysicalRect<i32, u32>,
    center_fallback: bool,
) -> WindowGeometry {
    let max_width = work_area.size.width.max(1);
    let max_height = work_area.size.height.max(1);
    let target_width = geometry.size.width.clamp(1, max_width);
    let target_height = geometry.size.height.clamp(1, max_height);

    let max_x = work_area.position.x + work_area.size.width.saturating_sub(target_width) as i32;
    let max_y = work_area.position.y + work_area.size.height.saturating_sub(target_height) as i32;

    let target_x = if center_fallback {
        work_area.position.x + (work_area.size.width.saturating_sub(target_width) / 2) as i32
    } else {
        geometry.position.x.clamp(work_area.position.x, max_x)
    };

    let target_y = if center_fallback {
        work_area.position.y + (work_area.size.height.saturating_sub(target_height) / 2) as i32
    } else {
        geometry.position.y.clamp(work_area.position.y, max_y)
    };

    WindowGeometry {
        position: PhysicalPosition::new(target_x, target_y),
        size: PhysicalSize::new(target_width, target_height),
    }
}

fn fit_initial_window_to_work_area<R: Runtime>(window: &WebviewWindow<R>) {
    let Some(monitor) = monitor_for_window(window) else {
        return;
    };
    let work_area = *monitor.work_area();
    let Ok(inner_size) = window.inner_size() else {
        return;
    };
    let Ok(outer_size) = window.outer_size() else {
        return;
    };
    let horizontal_chrome = outer_size.width.saturating_sub(inner_size.width);
    let vertical_chrome = outer_size.height.saturating_sub(inner_size.height);
    let position = window
        .outer_position()
        .unwrap_or_else(|_| PhysicalPosition::new(work_area.position.x, work_area.position.y));
    let constrained = constrained_window_geometry(
        WindowGeometry {
            position,
            size: outer_size,
        },
        work_area,
        true,
    );
    let target_inner_size = PhysicalSize::new(
        constrained
            .size
            .width
            .saturating_sub(horizontal_chrome)
            .max(1),
        constrained
            .size
            .height
            .saturating_sub(vertical_chrome)
            .max(1),
    );
    if target_inner_size != inner_size {
        let _ = window.set_size(target_inner_size);
    }

    let Ok(final_outer_size) = window.outer_size() else {
        return;
    };
    let Ok(final_position) = window.outer_position() else {
        return;
    };
    let final_geometry = constrained_window_geometry(
        WindowGeometry {
            position: final_position,
            size: final_outer_size,
        },
        work_area,
        true,
    );
    let _ = window.set_position(final_geometry.position);
}

fn resolve_model_dir(app: &AppHandle) -> PathBuf {
    // 1. Check local source development resources/model
    let dev_candidates = [
        PathBuf::from("resources/model"),
        PathBuf::from("src-tauri/resources/model"),
        PathBuf::from("../src-tauri/resources/model"),
    ];
    for p in &dev_candidates {
        if p.join("model.onnx").exists() && p.join("tokenizer.json").exists() {
            return p.clone();
        }
    }

    // 2. Check bundled resource directory
    if let Ok(res_dir) = app.path().resource_dir() {
        let p = res_dir.join("resources").join("model");
        if p.join("model.onnx").exists() {
            return p;
        }
        let p2 = res_dir.join("model");
        if p2.join("model.onnx").exists() {
            return p2;
        }
    }

    // 3. Fallback to app local data directory
    if let Ok(data_dir) = app.path().app_local_data_dir() {
        let p = data_dir.join("model");
        if p.join("model.onnx").exists() {
            return p;
        }
    }

    PathBuf::from("src-tauri/resources/model")
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let storage_preference_path = data_dir.join("storage-preference.json");
            let default_db_path = data_dir.join("snippets.sqlite3");
            let db_path = load_storage_preference(&storage_preference_path)
                .unwrap_or(default_db_path);
            if let Some(parent) = db_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let database = Database::init(&db_path).map_err(std::io::Error::other)?;

            let model_dir = resolve_model_dir(app.handle());
            let local_embedder = match LocalOnnxEmbedder::load_from_dir(&model_dir) {
                Ok(embedder) => {
                    println!(
                        "Successfully initialized local ONNX embeddings model from {}",
                        model_dir.display()
                    );
                    Some(embedder)
                }
                Err(e) => {
                    eprintln!("Notice: Local ONNX embeddings model not loaded: {e}");
                    None
                }
            };

            let embedding_service = EmbeddingService::new(local_embedder);
            let state = AppState {
                operation: tokio::sync::Mutex::new(()),
                db: Arc::new(database),
                embedding: Arc::new(embedding_service),
                active_data_operation: std::sync::Mutex::new(None),
                import_worker_running: AtomicBool::new(false),
                storage_preference_path,
            };
            app.manage(state);
            start_text_import_worker(app.handle().clone());

            if let Some(window) = app.get_webview_window("main") {
                fit_initial_window_to_work_area(&window);
                window.show()?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_snapshot,
            get_database_info,
            configure_storage,
            save_snippet,
            get_snippet,
            delete_snippet,
            batch_delete_snippets,
            toggle_favorite,
            set_snippets_favorite,
            tag_snippets,
            record_snippet_copy,
            move_snippets,
            save_collection,
            delete_collection,
            search_snippets,
            get_related_snippets,
            get_settings,
            update_settings,
            test_provider_settings,
            reindex_all_embeddings,
            export_snippets,
            export_snippets_to_file,
            get_snippets_for_export,
            save_export_text_file,
            save_export_binary_file,
            import_snippets,
            enqueue_text_import,
            get_text_import_jobs,
            backup_data,
            inspect_backup,
            restore_data,
            cancel_data_operation,
            window_minimize,
            window_maximize,
            window_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Snippets Manager");
}
