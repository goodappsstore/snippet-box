use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::Local;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::AppState;

pub const CANCELLED_ERROR: &str = "BACKUP_CANCELLED";
const MANIFEST_FILE: &str = ".snippetbox-backup.json";
const BACKUP_FORMAT_VERSION: u32 = 1;

#[derive(Deserialize, Serialize, Debug)]
struct BackupManifest {
    format_version: u32,
    app: String,
    created_at: String,
    database_file: String,
    snippets_count: usize,
    collections_count: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BackupResult {
    pub source_dir: String,
    pub target_dir: String,
    pub folder_name: String,
    pub copied_files_count: usize,
    pub copied_files: Vec<String>,
    pub snippets_count: usize,
    pub collections_count: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BackupPreview {
    pub backup_dir: String,
    pub folder_name: String,
    pub database_file: String,
    pub snippets_count: usize,
    pub collections_count: usize,
    pub file_count: usize,
    pub total_bytes: u64,
    pub created_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RestoreResult {
    pub backup_dir: String,
    pub restored_files_count: usize,
    pub restored_files: Vec<String>,
    pub warnings: Vec<String>,
}

enum CopyFailure {
    Cancelled,
    Io(String),
}

struct StagingCleanup(PathBuf);

impl Drop for StagingCleanup {
    fn drop(&mut self) {
        if self.0.exists() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

impl CopyFailure {
    fn io(action: &str, path: &Path, error: std::io::Error) -> Self {
        Self::Io(format!("{action} {}: {error}", path.display()))
    }
}

impl From<String> for CopyFailure {
    fn from(msg: String) -> Self {
        CopyFailure::Io(msg)
    }
}

fn ensure_not_cancelled(cancelled: &AtomicBool) -> Result<(), CopyFailure> {
    if cancelled.load(Ordering::Acquire) {
        Err(CopyFailure::Cancelled)
    } else {
        Ok(())
    }
}

fn is_sqlite_sidecar(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    name.ends_with("-wal") || name.ends_with("-shm")
}

fn is_restore_work_directory(relative_path: &Path) -> bool {
    let Some(name) = relative_path
        .components()
        .next()
        .and_then(|component| component.as_os_str().to_str())
    else {
        return false;
    };
    (name.starts_with(".snippetbox-restore-") || name.starts_with(".snippetbox-backup-"))
        && (name.ends_with(".staging") || name.ends_with(".rollback") || name.ends_with(".partial"))
}

fn is_ignored_data_entry(relative_path: &Path) -> bool {
    let Some(name) = relative_path
        .components()
        .next()
        .and_then(|component| component.as_os_str().to_str())
    else {
        return false;
    };
    // Exclude static ONNX model files from user data backups
    name == "model" || is_restore_work_directory(relative_path)
}

fn is_safe_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path.components().all(|component| {
            matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
}

fn sidecar_path(db_path: &Path, suffix: &str) -> PathBuf {
    let mut path = db_path.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

fn copy_file(source: &Path, target: &Path, cancelled: &AtomicBool) -> Result<(), CopyFailure> {
    ensure_not_cancelled(cancelled)?;
    let mut input =
        File::open(source).map_err(|error| CopyFailure::io("Unable to open", source, error))?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target)
        .map_err(|error| CopyFailure::io("Unable to create", target, error))?;
    let mut buffer = vec![0_u8; 1024 * 1024];

    loop {
        ensure_not_cancelled(cancelled)?;
        let read = input
            .read(&mut buffer)
            .map_err(|error| CopyFailure::io("Unable to read", source, error))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| CopyFailure::io("Unable to write", target, error))?;
    }

    output
        .sync_all()
        .map_err(|error| CopyFailure::io("Unable to flush", target, error))?;
    let permissions = fs::metadata(source)
        .map_err(|error| CopyFailure::io("Unable to read metadata for", source, error))?
        .permissions();
    fs::set_permissions(target, permissions)
        .map_err(|error| CopyFailure::io("Unable to preserve permissions for", target, error))?;
    Ok(())
}

fn copy_directory(
    source: &Path,
    target: &Path,
    relative_prefix: &Path,
    copied_files: &mut Vec<String>,
    cancelled: &AtomicBool,
) -> Result<(), CopyFailure> {
    ensure_not_cancelled(cancelled)?;
    let entries = fs::read_dir(source)
        .map_err(|error| CopyFailure::io("Unable to read directory", source, error))?;
    let mut entries = entries
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| CopyFailure::io("Unable to read an entry in", source, error))?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        ensure_not_cancelled(cancelled)?;
        let file_type = entry
            .file_type()
            .map_err(|error| CopyFailure::io("Unable to inspect", &entry.path(), error))?;
        let file_name = entry.file_name();
        let source_path = entry.path();
        let target_path = target.join(&file_name);
        let relative_path = relative_prefix.join(&file_name);

        if file_type.is_dir() && !is_ignored_data_entry(&relative_path) {
            fs::create_dir(&target_path).map_err(|error| {
                CopyFailure::io("Unable to create directory", &target_path, error)
            })?;
            copy_directory(
                &source_path,
                &target_path,
                &relative_path,
                copied_files,
                cancelled,
            )?;
        } else if file_type.is_file()
            && !is_sqlite_sidecar(&source_path)
            && relative_path != Path::new(MANIFEST_FILE)
        {
            copy_file(&source_path, &target_path, cancelled)?;
            copied_files.push(relative_path.to_string_lossy().to_string());
        }
    }
    Ok(())
}

fn collect_files(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|error| {
        format!(
            "Unable to read backup directory {}: {error}",
            directory.display()
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "Unable to read an entry in {}: {error}",
                directory.display()
            )
        })?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Unable to inspect {}: {error}", entry.path().display()))?;
        if file_type.is_dir() {
            collect_files(root, &entry.path(), files)?;
        } else if file_type.is_file() {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| "Backup contains an invalid file path".to_string())?
                .to_path_buf();
            if !is_safe_relative_path(&relative) {
                return Err("Backup contains an unsafe file path".into());
            }
            files.push(relative);
        }
    }
    files.sort();
    Ok(())
}

fn read_manifest(backup_dir: &Path) -> Result<Option<BackupManifest>, String> {
    let path = backup_dir.join(MANIFEST_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let bytes =
        fs::read(&path).map_err(|error| format!("Unable to read the backup manifest: {error}"))?;
    let manifest: BackupManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("The backup manifest is invalid: {error}"))?;
    if manifest.format_version != BACKUP_FORMAT_VERSION {
        return Err(format!(
            "Backup format {} is not supported by this version of SnippetBox",
            manifest.format_version
        ));
    }
    if !is_safe_relative_path(Path::new(&manifest.database_file)) {
        return Err("The backup manifest contains an unsafe database path".into());
    }
    Ok(Some(manifest))
}

fn validate_database(path: &Path) -> Result<(usize, usize), String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Unable to open the backup database: {error}"))?;
    let integrity: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| format!("Unable to validate the backup database integrity: {error}"))?;
    // SQLite's FTS5 virtual table tries to write internal integrity check structures
    // which fails with "attempt to write a readonly database" when opened read-only.
    if integrity != "ok"
        && !(integrity.contains("snippets_fts")
            && integrity.contains("attempt to write a readonly database"))
    {
        return Err(format!(
            "The selected backup database failed its integrity check: {integrity}"
        ));
    }
    let table_count: i64 = connection
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('snippets', 'collections')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("The selected folder is not a SnippetBox backup: {error}"))?;
    if table_count < 2 {
        return Err("The selected folder is missing required SnippetBox tables".into());
    }
    let snippets_count: usize = connection
        .query_row("SELECT count(*) FROM snippets", [], |row| row.get(0))
        .unwrap_or(0);
    let collections_count: usize = connection
        .query_row("SELECT count(*) FROM collections", [], |row| row.get(0))
        .unwrap_or(0);
    Ok((snippets_count, collections_count))
}

fn inspect_backup_at(
    state: &AppState,
    backup_dir: &str,
) -> Result<(PathBuf, BackupPreview), String> {
    let backup_dir = PathBuf::from(backup_dir.trim());
    if !backup_dir.is_dir() {
        return Err("Selected backup does not exist or is not a directory".into());
    }
    let backup_dir = fs::canonicalize(&backup_dir)
        .map_err(|error| format!("Unable to resolve the selected backup directory: {error}"))?;
    let source_dir = state.db.data_dir();
    let source_dir = fs::canonicalize(&source_dir)
        .map_err(|error| format!("Unable to resolve the current data directory: {error}"))?;
    if backup_dir.starts_with(&source_dir) || source_dir.starts_with(&backup_dir) {
        return Err(
            "Choose a backup folder outside the current SnippetBox data directory".into(),
        );
    }

    let manifest = read_manifest(&backup_dir)?;
    let database_file = manifest
        .as_ref()
        .map(|m| m.database_file.clone())
        .or_else(|| {
            state
                .db
                .db_path()
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "snippets.sqlite3".to_string());

    let database_relative = PathBuf::from(&database_file);
    if !is_safe_relative_path(&database_relative) {
        return Err("The backup contains an unsafe database path".into());
    }
    let database_path = backup_dir.join(&database_relative);
    if !database_path.is_file() {
        return Err(format!(
            "The selected folder does not contain the expected database file: {database_file}"
        ));
    }

    let (snippets_count, collections_count) = validate_database(&database_path)?;

    let mut files = Vec::new();
    collect_files(&backup_dir, &backup_dir, &mut files)?;
    let total_bytes = files.iter().try_fold(0_u64, |total, relative| {
        let size = fs::metadata(backup_dir.join(relative))
            .map_err(|error| format!("Unable to inspect backup file: {error}"))?
            .len();
        total
            .checked_add(size)
            .ok_or_else(|| "Backup size is too large".to_string())
    })?;
    let folder_name = backup_dir
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| backup_dir.to_string_lossy().to_string());

    let preview = BackupPreview {
        backup_dir: backup_dir.to_string_lossy().to_string(),
        folder_name,
        database_file,
        snippets_count,
        collections_count,
        file_count: files.len(),
        total_bytes,
        created_at: manifest.map(|m| m.created_at),
    };
    Ok((backup_dir, preview))
}

pub fn inspect_backup(state: &AppState, backup_dir: &str) -> Result<BackupPreview, String> {
    inspect_backup_at(state, backup_dir).map(|(_, preview)| preview)
}

fn remove_staging_directory(staging_dir: &Path, reason: &str, cancelled: bool) -> String {
    match fs::remove_dir_all(staging_dir) {
        Ok(()) => reason.to_string(),
        Err(error) if cancelled => format!(
            "The operation was cancelled, but its staging folder could not be removed ({}): {error}",
            staging_dir.display(),
        ),
        Err(error) => format!(
            "{reason}. The staging folder could not be removed ({}): {error}",
            staging_dir.display(),
        ),
    }
}

fn write_manifest(path: &Path, manifest: &BackupManifest) -> Result<(), CopyFailure> {
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|error| {
        CopyFailure::Io(format!("Unable to serialize backup manifest: {error}"))
    })?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| CopyFailure::io("Unable to create", path, error))?;
    file.write_all(&bytes)
        .map_err(|error| CopyFailure::io("Unable to write", path, error))?;
    file.sync_all()
        .map_err(|error| CopyFailure::io("Unable to flush", path, error))
}

pub fn create_backup(
    state: &AppState,
    destination_dir: &str,
    cancelled: &AtomicBool,
    committing: &AtomicBool,
) -> Result<BackupResult, String> {
    let source_dir = state.db.data_dir();
    if !source_dir.is_dir() {
        return Err(format!(
            "Source data directory does not exist: {}",
            source_dir.display()
        ));
    }

    let destination_dir = PathBuf::from(destination_dir.trim());
    if !destination_dir.is_dir() {
        return Err("Selected destination does not exist or is not a directory".into());
    }

    let canonical_source = fs::canonicalize(&source_dir)
        .map_err(|error| format!("Unable to resolve source data directory: {error}"))?;
    let canonical_destination = fs::canonicalize(&destination_dir)
        .map_err(|error| format!("Unable to resolve backup destination: {error}"))?;
    ensure_not_cancelled(cancelled).map_err(|_| CANCELLED_ERROR.to_string())?;

    let created_at = Local::now();
    let folder_name = format!(
        "snippetbox-backup-{}",
        created_at.format("%Y-%m-%d_%H-%M-%S")
    );
    let target_dir = canonical_destination.join(&folder_name);
    if target_dir.exists() {
        return Err(format!(
            "Backup folder already exists: {}",
            target_dir.display()
        ));
    }

    let staging_dir = canonical_destination.join(format!(
        ".snippetbox-backup-{}.partial",
        Uuid::new_v4()
    ));
    fs::create_dir(&staging_dir)
        .map_err(|error| format!("Unable to create backup staging folder: {error}"))?;
    let _staging_cleanup = StagingCleanup(staging_dir.clone());

    let (snippets_count, collections_count) = state.db.get_counts()?;
    state.db.checkpoint_wal()?;
    let database_path = state.db.db_path();
    let database_file = database_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "snippets.sqlite3".to_string());

    let copy_result = state.db.with_backup_write_lock(|| {
        ensure_not_cancelled(cancelled)?;
        copy_file(
            &database_path,
            &staging_dir.join(&database_file),
            cancelled,
        )?;
        let mut copied_files = vec![database_file.clone()];

        write_manifest(
            &staging_dir.join(MANIFEST_FILE),
            &BackupManifest {
                format_version: BACKUP_FORMAT_VERSION,
                app: "SnippetBox".to_string(),
                created_at: created_at.to_rfc3339(),
                database_file,
                snippets_count,
                collections_count,
            },
        )?;
        copied_files.push(MANIFEST_FILE.to_string());
        ensure_not_cancelled(cancelled)?;
        Ok(copied_files)
    });

    let mut copied_files = match copy_result {
        Ok(files) => files,
        Err(CopyFailure::Cancelled) => {
            return Err(remove_staging_directory(
                &staging_dir,
                CANCELLED_ERROR,
                true,
            ));
        }
        Err(CopyFailure::Io(message)) => {
            return Err(remove_staging_directory(
                &staging_dir,
                &format!("Backup failed: {message}"),
                false,
            ));
        }
    };

    let cancellation_won = {
        let _active_op = state
            .active_data_operation
            .lock()
            .map_err(|error| error.to_string())?;
        if cancelled.load(Ordering::Acquire) {
            true
        } else {
            committing.store(true, Ordering::Release);
            false
        }
    };
    if cancellation_won {
        return Err(remove_staging_directory(
            &staging_dir,
            CANCELLED_ERROR,
            true,
        ));
    }

    if let Err(error) = fs::rename(&staging_dir, &target_dir) {
        return Err(remove_staging_directory(
            &staging_dir,
            &format!("Unable to finalize backup: {error}"),
            false,
        ));
    }

    copied_files.sort();
    Ok(BackupResult {
        source_dir: canonical_source.to_string_lossy().to_string(),
        target_dir: target_dir.to_string_lossy().to_string(),
        folder_name,
        copied_files_count: copied_files.len(),
        copied_files,
        snippets_count,
        collections_count,
    })
}

struct InstalledFile {
    target: PathBuf,
    rollback: Option<PathBuf>,
}

fn remove_db_sidecars(db_path: &Path) -> Result<(), String> {
    for suffix in ["-wal", "-shm"] {
        let path = sidecar_path(db_path, suffix);
        if path.exists() {
            fs::remove_file(&path).map_err(|error| {
                format!(
                    "Unable to remove stale SQLite sidecar {}: {error}",
                    path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn rollback_installed_files(installed: &[InstalledFile], db_path: &Path) -> Result<(), String> {
    let mut failures = Vec::new();
    if let Err(error) = remove_db_sidecars(db_path) {
        failures.push(error);
    }
    for file in installed.iter().rev() {
        if file.target.exists() {
            if let Err(error) = fs::remove_file(&file.target) {
                failures.push(format!(
                    "Unable to remove restored file {}: {error}",
                    file.target.display()
                ));
                continue;
            }
        }
        if let Some(rollback) = &file.rollback {
            if let Some(parent) = file.target.parent() {
                if let Err(error) = fs::create_dir_all(parent) {
                    failures.push(format!(
                        "Unable to recreate directory {}: {error}",
                        parent.display()
                    ));
                    continue;
                }
            }
            if let Err(error) = fs::rename(rollback, &file.target) {
                failures.push(format!(
                    "Unable to restore original file {}: {error}",
                    file.target.display()
                ));
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

pub fn restore_backup(
    state: &AppState,
    backup_dir: &str,
    cancelled: &AtomicBool,
    committing: &AtomicBool,
) -> Result<RestoreResult, String> {
    let (backup_dir, preview) = inspect_backup_at(state, backup_dir)?;
    ensure_not_cancelled(cancelled).map_err(|_| CANCELLED_ERROR.to_string())?;

    let db_path = state.db.db_path();
    let source_dir = state.db.data_dir();
    let source_dir = fs::canonicalize(&source_dir)
        .map_err(|error| format!("Unable to resolve the current data directory: {error}"))?;

    let operation_suffix = Uuid::new_v4();
    let staging_dir = source_dir.join(format!(
        ".snippetbox-restore-{operation_suffix}.staging"
    ));
    let rollback_dir = source_dir.join(format!(
        ".snippetbox-restore-{operation_suffix}.rollback"
    ));
    fs::create_dir(&staging_dir)
        .map_err(|error| format!("Unable to create restore staging folder: {error}"))?;
    let _staging_cleanup = StagingCleanup(staging_dir.clone());

    let mut staged_file_names = Vec::new();
    let staging_result = copy_directory(
        &backup_dir,
        &staging_dir,
        Path::new(""),
        &mut staged_file_names,
        cancelled,
    );
    match staging_result {
        Ok(()) => {}
        Err(CopyFailure::Cancelled) => {
            return Err(remove_staging_directory(
                &staging_dir,
                CANCELLED_ERROR,
                true,
            ));
        }
        Err(CopyFailure::Io(message)) => {
            return Err(remove_staging_directory(
                &staging_dir,
                &format!("Unable to stage restore data: {message}"),
                false,
            ));
        }
    }

    let backup_db_relative = PathBuf::from(&preview.database_file);
    validate_database(&staging_dir.join(&backup_db_relative)).map_err(|error| {
        remove_staging_directory(
            &staging_dir,
            &format!("The staged database could not be validated: {error}"),
            false,
        )
    })?;
    ensure_not_cancelled(cancelled)
        .map_err(|_| remove_staging_directory(&staging_dir, CANCELLED_ERROR, true))?;

    let current_db_relative = PathBuf::from(
        db_path
            .file_name()
            .ok_or_else(|| "Unable to determine current database filename".to_string())?,
    );
    let staged_files = staged_file_names
        .into_iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let mut mappings = Vec::new();
    let mut target_paths = HashSet::new();

    for source_relative in staged_files {
        if source_relative != backup_db_relative {
            continue;
        }
        let target_relative = if source_relative == backup_db_relative {
            current_db_relative.clone()
        } else {
            source_relative.clone()
        };
        if !target_paths.insert(target_relative.clone()) {
            let message = format!(
                "The backup maps more than one file to {}",
                target_relative.display()
            );
            return Err(remove_staging_directory(&staging_dir, &message, false));
        }
        let target = source_dir.join(&target_relative);
        if target.exists() && !target.is_file() {
            let message = format!(
                "Cannot restore {} because the destination is not a file",
                target.display()
            );
            return Err(remove_staging_directory(&staging_dir, &message, false));
        }
        mappings.push((source_relative, target_relative));
    }

    if !mappings
        .iter()
        .any(|(_, target)| target == &current_db_relative)
    {
        return Err(remove_staging_directory(
            &staging_dir,
            "The staged restore does not contain a database file",
            false,
        ));
    }

    state.db.checkpoint_wal()?;

    let cancellation_won = {
        let _active_op = state
            .active_data_operation
            .lock()
            .map_err(|error| error.to_string())?;
        if cancelled.load(Ordering::Acquire) {
            true
        } else {
            committing.store(true, Ordering::Release);
            false
        }
    };
    if cancellation_won {
        return Err(remove_staging_directory(
            &staging_dir,
            CANCELLED_ERROR,
            true,
        ));
    }

    // Release database connection locks before swapping files
    if let Err(error) = state.db.close_for_restore() {
        return Err(remove_staging_directory(
            &staging_dir,
            &format!("Failed to close current database: {error}"),
            false,
        ));
    }

    if let Err(error) = remove_db_sidecars(&db_path) {
        let _ = state.db.reopen_after_restore();
        return Err(remove_staging_directory(&staging_dir, &error, false));
    }

    if let Err(error) = fs::create_dir(&rollback_dir) {
        let _ = state.db.reopen_after_restore();
        return Err(remove_staging_directory(
            &staging_dir,
            &format!("Unable to create restore rollback folder: {error}"),
            false,
        ));
    }

    let mut installed = Vec::new();
    let mut install_error = None;
    for (source_relative, target_relative) in &mappings {
        let staged = staging_dir.join(source_relative);
        let target = source_dir.join(target_relative);
        let rollback = rollback_dir.join(target_relative);
        if let Some(parent) = target.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                install_error = Some(format!(
                    "Unable to create restore destination {}: {error}",
                    parent.display()
                ));
                break;
            }
        }
        let previous = if target.exists() {
            if let Some(parent) = rollback.parent() {
                if let Err(error) = fs::create_dir_all(parent) {
                    install_error = Some(format!(
                        "Unable to create rollback destination {}: {error}",
                        parent.display()
                    ));
                    break;
                }
            }
            if let Err(error) = fs::rename(&target, &rollback) {
                install_error = Some(format!(
                    "Unable to preserve current file {}: {error}",
                    target.display()
                ));
                break;
            }
            Some(rollback.clone())
        } else {
            None
        };
        if let Err(error) = fs::rename(&staged, &target) {
            if let Some(previous) = &previous {
                installed.push(InstalledFile {
                    target: target.clone(),
                    rollback: Some(previous.clone()),
                });
            }
            install_error = Some(format!(
                "Unable to install restored file {}: {error}",
                target.display()
            ));
            break;
        }
        installed.push(InstalledFile {
            target,
            rollback: previous,
        });
    }

    if install_error.is_none() {
        if let Err(error) = state.db.reopen_after_restore() {
            install_error = Some(format!("The restored database could not be opened: {error}"));
        }
    }

    if let Some(error) = install_error {
        let rollback_error = rollback_installed_files(&installed, &db_path).err();
        let reopen_error = state.db.reopen_after_restore().err();
        let _ = fs::remove_dir_all(&staging_dir);
        if rollback_error.is_none() {
            let _ = fs::remove_dir_all(&rollback_dir);
        }
        let mut details = vec![error];
        if let Some(rollback_error) = rollback_error {
            details.push(format!(
                "Automatic rollback was incomplete; recovery files remain in {}: {rollback_error}",
                rollback_dir.display()
            ));
        }
        if let Some(reopen_error) = reopen_error {
            details.push(format!(
                "The original database could not be reopened: {reopen_error}"
            ));
        }
        return Err(details.join(". "));
    }

    let mut warnings = Vec::new();
    if let Err(error) = fs::remove_dir_all(&staging_dir) {
        warnings.push(format!(
            "The empty restore staging folder could not be removed ({}): {error}",
            staging_dir.display()
        ));
    }
    if let Err(error) = fs::remove_dir_all(&rollback_dir) {
        warnings.push(format!(
            "The restore succeeded, but old rollback files could not be removed ({}): {error}",
            rollback_dir.display()
        ));
    }

    let mut restored_files = mappings
        .into_iter()
        .map(|(_, target)| target.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    restored_files.sort();

    Ok(RestoreResult {
        backup_dir: backup_dir.to_string_lossy().to_string(),
        restored_files_count: restored_files.len(),
        restored_files,
        warnings,
    })
}
